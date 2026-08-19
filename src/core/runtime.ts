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

/** Manages repository-level runtime processes and their independent ports. */
export class RuntimeManager {
  private readonly states = new Map<string, RuntimeState>();
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly allocatedPorts = new Map<number, string>();

  constructor(private readonly config: AppConfig) {}

  getState(workflowId: string, repositoryId: string): RuntimeState {
    return this.states.get(this.runtimeKey(workflowId, repositoryId)) ?? defaultRuntimeState();
  }

  async start(workflow: Workflow, repositoryId: string): Promise<RuntimeState> {
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

    const logDirectory = path.join(
      this.config.server.dataDir,
      'logs',
      workflow.id.replaceAll(/[^a-zA-Z0-9_.-]/g, '_'),
      repositoryId.replaceAll(/[^a-zA-Z0-9_.-]/g, '_')
    );
    await mkdir(logDirectory, { recursive: true, mode: 0o700 });
    const logFile = path.join(logDirectory, 'runtime.log');
    const log = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
    const preparingState: RuntimeState = { status: 'preparing', logFile };
    this.states.set(key, preparingState);

    void this.launch(workflow, repository, log).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!log.writableEnded) {
        log.write(`\n[workflow-manager] failed: ${message}\n`);
        log.end();
      }
      this.states.set(key, {
        status: 'failed',
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

    const port = await this.allocatePort(key);
    const variables = {
      port,
      worktree: repository.worktreePath,
      workflowId: workflow.id,
      repositoryId: repository.repositoryId,
    };
    const command = renderTemplate(runtime.startCommand, variables);
    const url = runtime.healthCheckUrl
      ? renderTemplate(runtime.healthCheckUrl, variables)
      : `http://127.0.0.1:${port}`;
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
      this.processes.delete(key);
      this.allocatedPorts.delete(port);
      if (!log.writableEnded) {
        log.write(
          `\n[workflow-manager] process exited with ${String(exitCode)} at ${new Date().toISOString()}\n`
        );
        log.end();
      }
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

  private async allocatePort(ownerKey: string): Promise<number> {
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
    throw new Error('No available runtime port in the configured range');
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
