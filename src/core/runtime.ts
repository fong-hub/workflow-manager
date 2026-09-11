import {
  chmodSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

import { renderTemplate, runFile } from './command.js';
import type {
  AppConfig,
  RuntimeState,
  Workflow,
  WorkflowRepository,
} from './types.js';

interface ManagedProcess {
  /** Undefined when this process was adopted after a manager restart. */
  child?: ChildProcess;
  workflowId: string;
  repositoryId: string;
  port: number;
  worktreePath: string;
  adopted: boolean;
}

interface PersistedRuntimeRecord {
  workflowId: string;
  repositoryId: string;
  state: RuntimeState;
  pidStartToken?: string;
  worktreePath: string;
}

interface PersistedRuntimeStore {
  runtimes: Record<string, PersistedRuntimeRecord>;
}

async function portAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host }, () => {
      server.close(() => resolve(true));
    });
  });
}

function defaultRuntimeState(): RuntimeState {
  return { status: 'stopped' };
}

function stateWithoutPid(state: RuntimeState): RuntimeState {
  const result = { ...state };
  delete result.pid;
  return result;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const processError = error as NodeJS.ErrnoException;
    return processError.code === 'EPERM';
  }
}

/**
 * Returns a platform-provided process birth marker. The marker prevents a
 * restored runtime from accidentally claiming a reused PID after a crash.
 */
async function processStartToken(pid: number): Promise<string | undefined> {
  const result = await runFile('ps', ['-p', String(pid), '-o', 'lstart='], {
    allowFailure: true,
  });
  const token = result.stdout.trim();
  return result.exitCode === 0 && token ? token : undefined;
}

/** A requested or automatically selected runtime port cannot be reserved. */
export class RuntimePortUnavailableError extends Error {
  override readonly name = 'RuntimePortUnavailableError';
}

/** Manages repository-level runtime processes and their independent ports. */
export class RuntimeManager {
  private readonly states = new Map<string, RuntimeState>();
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly allocatedPorts = new Map<number, string>();
  private readonly processStartTokens = new Map<string, string>();
  private readonly persistedWorktreePaths = new Map<string, string>();
  private readonly runtimeStateFile: string;
  private initialization: Promise<void> | undefined;

  constructor(private readonly config: AppConfig) {
    this.runtimeStateFile = path.join(config.server.dataDir, 'runtime-state.json');
    this.loadPersistedStates();
  }

  /**
   * Reconciles persisted processes with the operating system before workflows
   * are scanned. Normal service restarts adopt live runtimes; dead or reused
   * PIDs are converted to failed states and their ports are released.
   */
  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.restorePersistedProcesses();
    }
    await this.initialization;
  }

  getState(workflowId: string, repositoryId: string): RuntimeState {
    const key = this.runtimeKey(workflowId, repositoryId);
    this.reconcileAdoptedProcess(key);
    return this.states.get(key) ?? defaultRuntimeState();
  }

  async start(
    workflow: Workflow,
    repositoryId: string,
    options: { port?: number } = {}
  ): Promise<RuntimeState> {
    await this.initialize();
    const repository = workflow.repositories.find(
      (candidate) => candidate.repositoryId === repositoryId
    );
    if (!repository) {
      throw new Error(`Repository is not part of this workflow: ${repositoryId}`);
    }
    if (!repository.runtime) {
      throw new Error(
        `No runtime command is configured for repository: ${repository.repositoryLabel}`
      );
    }
    if (repository.prunable) {
      throw new Error('Cannot start a prunable worktree');
    }

    const key = this.runtimeKey(workflow.id, repositoryId);
    const current = this.getState(workflow.id, repositoryId);
    if (
      current &&
      ['preparing', 'starting', 'running'].includes(current.status)
    ) {
      return current;
    }

    // Select and reserve the port before any repository command runs so a
    // conflict fails the start request immediately instead of after prepare.
    const port = await this.allocatePort(key, options.port);
    const variables = {
      port,
      worktree: repository.worktreePath,
      workflowId: workflow.id,
      repositoryId: repository.repositoryId,
    };
    const url = repository.runtime.healthCheckUrl
      ? renderTemplate(repository.runtime.healthCheckUrl, variables)
      : `http://127.0.0.1:${port}`;

    let log: WriteStream;
    let logFile: string;
    try {
      const logDirectory = path.join(
        this.config.server.dataDir,
        'logs',
        workflow.id.replaceAll(/[^a-zA-Z0-9_.-]/g, '_'),
        repositoryId.replaceAll(/[^a-zA-Z0-9_.-]/g, '_')
      );
      await mkdir(logDirectory, { recursive: true, mode: 0o700 });
      logFile = path.join(logDirectory, 'runtime.log');
      log = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
    } catch (error) {
      this.releasePort(port, key);
      throw error;
    }

    const preparingState: RuntimeState = { status: 'preparing', port, url, logFile };
    this.states.set(key, preparingState);
    this.persistStates();

    void this.launch(workflow, repository, port, url, log).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.processes.has(key)) {
        this.releasePort(port, key);
      }
      if (!log.writableEnded) {
        log.write(`\n[workflow-manager] failed: ${message}\n`);
        log.end();
      }
      this.states.set(key, {
        status: 'failed',
        port,
        url,
        error: message,
        exitedAt: new Date().toISOString(),
        logFile,
      });
      this.persistStates();
    });

    return preparingState;
  }

  private async launch(
    workflow: Workflow,
    repository: WorkflowRepository,
    port: number,
    url: string,
    log: WriteStream
  ): Promise<void> {
    const runtime = repository.runtime!;
    const key = this.runtimeKey(workflow.id, repository.repositoryId);
    const cwd = path.resolve(repository.worktreePath, runtime.workingDirectory);
    if (runtime.prepareCommand) {
      log.write(
        `\n[workflow-manager] prepare ${new Date().toISOString()}\n${runtime.prepareCommand}\n`
      );
      const prepareCode = await this.runShell(runtime.prepareCommand, cwd, log);
      if (prepareCode !== 0) {
        throw new Error(`Prepare command exited with code ${prepareCode}`);
      }
    }

    // Preparation can be slow. Probe once more immediately before spawning
    // to catch an external process that claimed the reserved port meanwhile.
    if (!(await portAvailable(port, this.config.server.host))) {
      throw new RuntimePortUnavailableError(
        `Runtime port ${port} became occupied during preparation`
      );
    }

    const variables = {
      port,
      worktree: repository.worktreePath,
      workflowId: workflow.id,
      repositoryId: repository.repositoryId,
    };
    const command = renderTemplate(runtime.startCommand, variables);
    const logFile = this.states.get(key)?.logFile;
    this.states.set(key, {
      status: 'starting',
      port,
      url,
      ...(logFile ? { logFile } : {}),
    });
    this.persistStates();
    log.write(
      `\n[workflow-manager] start ${new Date().toISOString()}\n${command}\n`
    );

    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd,
      detached: true,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    if (!child.pid) throw new Error('Runtime process did not expose a PID');
    this.processes.set(key, {
      child,
      workflowId: workflow.id,
      repositoryId: repository.repositoryId,
      port,
      worktreePath: repository.worktreePath,
      adopted: false,
    });
    this.persistedWorktreePaths.set(key, repository.worktreePath);
    // Persist the PID before doing any further async work. If the manager is
    // killed in this small window, startup can still adopt the live process.
    this.states.set(key, {
      ...(this.states.get(key) ?? { status: 'starting' }),
      pid: child.pid,
    });
    this.persistStates();

    const pidStartToken = await processStartToken(child.pid);
    if (pidStartToken) {
      this.processStartTokens.set(key, pidStartToken);
      this.persistStates();
    }

    child.once('exit', (exitCode) => {
      const isCurrentProcess = this.processes.get(key)?.child === child;
      if (isCurrentProcess) {
        this.processes.delete(key);
        this.processStartTokens.delete(key);
      }
      if (this.allocatedPorts.get(port) === key && isCurrentProcess) {
        this.allocatedPorts.delete(port);
      }
      if (!log.writableEnded) {
        log.write(
          `\n[workflow-manager] process exited with ${String(exitCode)} at ${new Date().toISOString()}\n`
        );
        log.end();
      }
      // A timed-out stop may have been followed by a new start. In that case
      // this late exit belongs to the previous instance and must not overwrite
      // the replacement's state.
      if (!isCurrentProcess && this.processes.has(key)) return;
      const existing = this.states.get(key);
      this.states.set(key, {
        status:
          exitCode === 0 || existing?.status === 'stopped'
            ? 'stopped'
            : 'failed',
        port,
        url,
        exitedAt: new Date().toISOString(),
        exitCode,
        ...(exitCode && exitCode !== 0
          ? { error: `Runtime exited with code ${exitCode}` }
          : {}),
        ...(existing?.logFile ? { logFile: existing.logFile } : {}),
      });
      this.persistStates();
    });

    try {
      await this.waitForReady(url, child, Boolean(runtime.healthCheckUrl));
    } catch (error) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Process already exited.
      }
      throw error;
    }
    if (child.exitCode !== null || !this.processes.has(key)) {
      throw new Error('Runtime process exited before becoming ready');
    }
    this.states.set(key, {
      status: 'running',
      port,
      pid: child.pid,
      url,
      startedAt: new Date().toISOString(),
      ...(logFile ? { logFile } : {}),
    });
    this.persistStates();
  }

  async stop(workflowId: string, repositoryId: string): Promise<RuntimeState> {
    await this.initialize();
    const key = this.runtimeKey(workflowId, repositoryId);
    this.reconcileAdoptedProcess(key);
    const managed = this.processes.get(key);
    if (!managed) {
      const current = this.getState(workflowId, repositoryId);
      const withoutPid = stateWithoutPid(current);
      const stopped: RuntimeState = {
        ...withoutPid,
        status: 'stopped',
        exitedAt: new Date().toISOString(),
      };
      this.states.set(key, stopped);
      this.persistStates();
      return stopped;
    }

    const pid = managed.child?.pid ?? this.states.get(key)?.pid;
    if (!pid) {
      this.processes.delete(key);
      this.processStartTokens.delete(key);
      this.releasePort(managed.port, key);
      const stopped: RuntimeState = {
        ...this.getState(workflowId, repositoryId),
        status: 'stopped',
        exitedAt: new Date().toISOString(),
      };
      this.states.set(key, stopped);
      this.persistStates();
      return stopped;
    }

    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      const processError = error as NodeJS.ErrnoException;
      if (processError.code !== 'ESRCH') throw error;
    }

    await this.waitForProcessExit(pid, managed.child);

    // Do not retain stale in-memory ownership after the stop timeout. The
    // next start probes the real socket again before accepting the port.
    if (this.processes.get(key) === managed) {
      this.processes.delete(key);
    }
    this.processStartTokens.delete(key);
    this.releasePort(managed.port, key);

    const current = this.getState(workflowId, repositoryId);
    const withoutPid = stateWithoutPid(current);
    const stopped: RuntimeState = {
      ...withoutPid,
      status: 'stopped',
      exitedAt: new Date().toISOString(),
    };
    this.states.set(key, stopped);
    this.persistStates();
    return stopped;
  }

  /** Stops every runtime owned or adopted by this manager. */
  async shutdown(): Promise<void> {
    await this.initialize();
    const managed = [...this.processes.values()];
    await Promise.allSettled(
      managed.map((process) => this.stop(process.workflowId, process.repositoryId))
    );
  }

  async readLog(
    workflowId: string,
    repositoryId: string,
    maxBytes = 80_000
  ): Promise<string> {
    await this.initialize();
    const logFile = this.getState(workflowId, repositoryId).logFile;
    if (!logFile) return '';
    try {
      const fileStat = await stat(logFile);
      const start = Math.max(0, fileStat.size - maxBytes);
      const file = await open(logFile, 'r');
      try {
        const buffer = Buffer.alloc(fileStat.size - start);
        await file.read(buffer, 0, buffer.length, start);
        return buffer.toString('utf8');
      } finally {
        await file.close();
      }
    } catch {
      return readFile(logFile, 'utf8').catch(() => '');
    }
  }

  private async waitForReady(
    url: string,
    child: ChildProcess,
    healthCheckEnabled: boolean
  ): Promise<void> {
    if (!healthCheckEnabled) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (child.exitCode !== null) {
        throw new Error('Runtime process exited during startup');
      }
      return;
    }

    const deadline = Date.now() + this.config.runtime.startupTimeoutMs;
    let lastError = 'Health check did not respond';
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error('Runtime process exited before the health check passed');
      }
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(1200),
        });
        if (response.ok) return;
        lastError = `Health check returned HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      `Runtime health check timed out after ${this.config.runtime.startupTimeoutMs}ms: ${lastError}`
    );
  }

  private loadPersistedStates(): void {
    try {
      const loaded = JSON.parse(
        readFileSync(this.runtimeStateFile, 'utf8')
      ) as Partial<PersistedRuntimeStore>;
      for (const record of Object.values(loaded.runtimes ?? {})) {
        if (!record?.state || !record.workflowId || !record.repositoryId) continue;
        const runtimeKey = this.runtimeKey(record.workflowId, record.repositoryId);
        this.states.set(runtimeKey, record.state);
        if (record.pidStartToken) {
          this.processStartTokens.set(runtimeKey, record.pidStartToken);
        }
        this.persistedWorktreePaths.set(runtimeKey, record.worktreePath);
      }
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code !== 'ENOENT') {
        // A malformed runtime registry must not prevent the manager from
        // starting; it is safer to ignore it and allocate fresh ports.
        console.error('[workflow-manager] cannot read runtime state:', error);
      }
    }
  }

  private async restorePersistedProcesses(): Promise<void> {
    let changed = false;
    for (const [key, state] of this.states) {
      if (!['preparing', 'starting', 'running'].includes(state.status)) continue;
      const pid = state.pid;
      const token = this.processStartTokens.get(key);
      if (!pid || !processIsAlive(pid)) {
        this.markRestoredProcessFailed(key, '服务重启时发现运行进程已退出；已释放端口占用。');
        changed = true;
        continue;
      }
      const actualToken = await processStartToken(pid);
      if (token && actualToken !== token) {
        this.markRestoredProcessFailed(key, '运行进程 PID 已被其他进程复用或无法核验；已释放端口占用。');
        changed = true;
        continue;
      }
      const port = state.port;
      if (!port || port < 1 || port > 65_535) {
        this.markRestoredProcessFailed(key, '运行状态缺少端口信息；无法恢复端口管控。');
        changed = true;
        continue;
      }
      const [workflowId, repositoryId] = this.splitRuntimeKey(key);
      const existingOwner = this.allocatedPorts.get(port);
      if (existingOwner && existingOwner !== key) {
        this.markRestoredProcessFailed(key, `恢复时发现端口 ${port} 已被另一个 Runtime 记录占用；已释放本记录。`);
        changed = true;
        continue;
      }
      this.processes.set(key, {
        workflowId,
        repositoryId,
        port,
        worktreePath: this.persistedWorktreePaths.get(key) ?? '',
        adopted: true,
      });
      this.allocatedPorts.set(port, key);
      this.states.set(key, { ...state, status: 'running' });
      changed = true;
    }
    if (changed) this.persistStates();
  }

  private markRestoredProcessFailed(key: string, error: string): void {
    const current = this.states.get(key) ?? defaultRuntimeState();
    const withoutPid = stateWithoutPid(current);
    this.releasePort(current.port, key);
    this.processStartTokens.delete(key);
    this.states.set(key, {
      ...withoutPid,
      status: 'failed',
      error,
      exitedAt: new Date().toISOString(),
    });
  }

  private reconcileAdoptedProcess(key: string): void {
    const managed = this.processes.get(key);
    if (!managed?.adopted || managed.child?.pid) return;
    const pid = this.states.get(key)?.pid;
    if (pid && processIsAlive(pid)) return;
    this.processes.delete(key);
    this.processStartTokens.delete(key);
    this.releasePort(managed.port, key);
    const current = this.states.get(key) ?? defaultRuntimeState();
    const withoutPid = stateWithoutPid(current);
    this.states.set(key, {
      ...withoutPid,
      status: 'failed',
      error: '运行进程已退出；端口占用已释放。',
      exitedAt: new Date().toISOString(),
    });
    this.persistStates();
  }

  private async waitForProcessExit(
    pid: number,
    child?: ChildProcess
  ): Promise<void> {
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            // Process already exited.
          }
          resolve();
        }, this.config.runtime.stopTimeoutMs);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      return;
    }

    const deadline = Date.now() + this.config.runtime.stopTimeoutMs;
    while (Date.now() < deadline && processIsAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (processIsAlive(pid)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Process already exited.
      }
    }
  }

  private persistStates(): void {
    const runtimes: Record<string, PersistedRuntimeRecord> = {};
    for (const [key, state] of this.states) {
      const [workflowId, repositoryId] = this.splitRuntimeKey(key);
      const managed = this.processes.get(key);
      const pidStartToken = this.processStartTokens.get(key);
      const record: PersistedRuntimeRecord = {
        workflowId,
        repositoryId,
        state,
        ...(pidStartToken ? { pidStartToken } : {}),
        worktreePath:
          managed?.worktreePath ?? this.persistedWorktreePaths.get(key) ?? '',
      };
      runtimes[key] = record;
    }
    try {
      mkdirSync(this.config.server.dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.runtimeStateFile}.tmp`;
      writeFileSync(temporary, JSON.stringify({ runtimes }, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.runtimeStateFile);
      chmodSync(this.runtimeStateFile, 0o600);
    } catch (error) {
      console.error('[workflow-manager] cannot persist runtime state:', error);
    }
  }

  private splitRuntimeKey(key: string): [string, string] {
    const separator = key.lastIndexOf('::');
    if (separator < 0) return [key, ''];
    return [key.slice(0, separator), key.slice(separator + 2)];
  }

  private async allocatePort(
    ownerKey: string,
    requestedPort?: number
  ): Promise<number> {
    // A restored runtime has no ChildProcess exit event. Reconcile it before
    // every allocation so a process that died since the last scan cannot keep
    // a ghost reservation indefinitely.
    for (const key of this.processes.keys()) {
      this.reconcileAdoptedProcess(key);
    }

    if (requestedPort !== undefined) {
      if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
        throw new Error('Runtime port must be an integer between 1 and 65535');
      }
      const owner = this.allocatedPorts.get(requestedPort);
      if (owner && owner !== ownerKey) {
        throw new RuntimePortUnavailableError(
          `Runtime port ${requestedPort} is already allocated by another workflow`
        );
      }
      if (!(await portAvailable(requestedPort, this.config.server.host))) {
        throw new RuntimePortUnavailableError(
          `Runtime port ${requestedPort} is already in use`
        );
      }
      this.allocatedPorts.set(requestedPort, ownerKey);
      return requestedPort;
    }

    for (
      let port = this.config.runtime.portRange.start;
      port <= this.config.runtime.portRange.end;
      port += 1
    ) {
      if (this.allocatedPorts.has(port)) continue;
      if (await portAvailable(port, this.config.server.host)) {
        this.allocatedPorts.set(port, ownerKey);
        return port;
      }
    }
    throw new RuntimePortUnavailableError(
      `No available runtime port in configured range ${this.config.runtime.portRange.start}-${this.config.runtime.portRange.end}`
    );
  }

  private releasePort(port: number | undefined, ownerKey: string): void {
    if (port !== undefined && this.allocatedPorts.get(port) === ownerKey) {
      this.allocatedPorts.delete(port);
    }
  }

  private runShell(
    command: string,
    cwd: string,
    log: WriteStream
  ): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/zsh', ['-lc', command], {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.pipe(log, { end: false });
      child.stderr?.pipe(log, { end: false });
      child.once('error', reject);
      child.once('exit', resolve);
    });
  }

  private runtimeKey(workflowId: string, repositoryId: string): string {
    return `${workflowId}::${repositoryId}`;
  }
}
