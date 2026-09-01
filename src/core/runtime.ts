import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

import { renderTemplate } from './command.js';
import type {
  AppConfig,
  RuntimeState,
  Workflow,
  WorkflowRepository,
} from './types.js';

interface ManagedProcess {
  child: ChildProcess;
  log: WriteStream;
  workflowId: string;
  repositoryId: string;
  port: number;
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

/** A requested or automatically selected runtime port cannot be reserved. */
export class RuntimePortUnavailableError extends Error {
  override readonly name = 'RuntimePortUnavailableError';
}

/** Manages repository-level runtime processes and their independent ports. */
export class RuntimeManager {
  private readonly states = new Map<string, RuntimeState>();
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly allocatedPorts = new Map<number, string>();

  constructor(private readonly config: AppConfig) {}

  getState(workflowId: string, repositoryId: string): RuntimeState {
    return this.states.get(this.runtimeKey(workflowId, repositoryId)) ?? defaultRuntimeState();
  }

  async start(
    workflow: Workflow,
    repositoryId: string,
    options: { port?: number } = {}
  ): Promise<RuntimeState> {
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
    const current = this.states.get(key);
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
      log,
      workflowId: workflow.id,
      repositoryId: repository.repositoryId,
      port,
    });

    child.once('exit', (exitCode) => {
      const isCurrentProcess = this.processes.get(key)?.child === child;
      if (isCurrentProcess) {
        this.processes.delete(key);
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
  }

  async stop(workflowId: string, repositoryId: string): Promise<RuntimeState> {
    const key = this.runtimeKey(workflowId, repositoryId);
    const managed = this.processes.get(key);
    if (!managed?.child.pid) {
      const stopped = {
        ...this.getState(workflowId, repositoryId),
        status: 'stopped' as const,
      };
      this.states.set(key, stopped);
      return stopped;
    }
    const pid = managed.child.pid;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      const processError = error as NodeJS.ErrnoException;
      if (processError.code !== 'ESRCH') throw error;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Process already exited.
        }
        resolve();
      }, this.config.runtime.stopTimeoutMs);
      managed.child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // The exit event can arrive after the stop timeout (for example when a
    // detached child process needs extra time to terminate). Do not retain
    // stale in-memory ownership in that case; the next start still probes the
    // real socket before allocating the port.
    if (this.processes.get(key) === managed) {
      this.processes.delete(key);
    }
    if (this.allocatedPorts.get(managed.port) === key) {
      this.allocatedPorts.delete(managed.port);
    }

    const stopped: RuntimeState = {
      ...this.getState(workflowId, repositoryId),
      status: 'stopped',
      exitedAt: new Date().toISOString(),
    };
    this.states.set(key, stopped);
    return stopped;
  }

  async readLog(
    workflowId: string,
    repositoryId: string,
    maxBytes = 80_000
  ): Promise<string> {
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

  private async allocatePort(
    ownerKey: string,
    requestedPort?: number
  ): Promise<number> {
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

  private releasePort(port: number, ownerKey: string): void {
    if (this.allocatedPorts.get(port) === ownerKey) {
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
