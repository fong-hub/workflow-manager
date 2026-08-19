import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RuntimeManager } from '../src/core/runtime.js';
import type { AppConfig, Workflow } from '../src/core/types.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe('runtime manager', () => {
  it('preserves leading environment variable assignments in configured shell commands', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'workflow-runtime-'));
    temporaryDirectories.push(dataDir);
    const config: AppConfig = {
      version: 1,
      configPath: path.join(dataDir, 'config.yaml'),
      server: { host: '127.0.0.1', port: 4310, dataDir },
      runtime: {
        portRange: { start: 3290, end: 3299 },
        stopTimeoutMs: 1000,
        startupTimeoutMs: 5000,
      },
      sources: [],
      workspaces: [],
    };
    const runtime = {
      primary: true,
      workingDirectory: '.',
      startCommand:
        "PORT=${port} node -e 'require(\"http\").createServer((_, response) => response.end(process.env.PORT)).listen(Number(process.env.PORT), \"127.0.0.1\")'",
      healthCheckUrl: 'http://127.0.0.1:${port}',
    };
    const workflow: Workflow = {
      id: 'test::env-prefix',
      key: 'env-prefix',
      title: 'Environment prefix',
      workspaceId: 'test',
      workspaceLabel: 'Test',
      repositories: [
        {
          repositoryId: 'app',
          repositoryLabel: 'App',
          role: 'application',
          repositoryPath: dataDir,
          worktreePath: dataDir,
          branch: 'codex/env-prefix',
          headCommit: '0123456789abcdef',
          detached: false,
          prunable: false,
          dirty: false,
          dirtyFiles: [],
          ahead: 0,
          behind: 0,
          runtime,
          checks: [],
        },
        {
          repositoryId: 'other',
          repositoryLabel: 'Other runnable repository',
          role: 'service',
          repositoryPath: dataDir,
          worktreePath: dataDir,
          branch: 'codex/env-prefix',
          headCommit: 'fedcba9876543210',
          detached: false,
          prunable: false,
          dirty: false,
          dirtyFiles: [],
          ahead: 0,
          behind: 0,
          runtime: {
            ...runtime,
            startCommand:
              "PORT=${port} node -e 'require(\"http\").createServer((_, response) => response.end(\"other\")).listen(Number(process.env.PORT), \"127.0.0.1\")'",
          },
          checks: [],
        },
      ],
      acceptanceStale: false,
      runtimes: {
        app: { status: 'stopped' },
        other: { status: 'stopped' },
      },
    };
    const manager = new RuntimeManager(config);

    await manager.start(workflow, 'app');
    let state = manager.getState(workflow.id, 'app');
    for (let attempt = 0; attempt < 30 && state.status !== 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = manager.getState(workflow.id, 'app');
    }

    expect(state.status).toBe('running');
    expect(manager.getState(workflow.id, 'other').status).toBe('stopped');
    expect(state.url).toBeDefined();
    const response = await fetch(state.url!);
    expect(await response.text()).toBe(String(state.port));

    await manager.stop(workflow.id, 'app');
    expect(manager.getState(workflow.id, 'app').status).toBe('stopped');
  });
});
