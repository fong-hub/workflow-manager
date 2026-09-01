import net from 'node:net';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RuntimeManager } from '../src/core/runtime.js';
import type {
  AppConfig,
  RepositoryRuntimeConfig,
  RuntimeState,
  Workflow,
} from '../src/core/types.js';

const temporaryDirectories: string[] = [];
const listeningServers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    listeningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function createDataDirectory(): Promise<string> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'workflow-runtime-'));
  temporaryDirectories.push(dataDir);
  return dataDir;
}

async function findAvailablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not resolve an available test port');
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function occupyAvailablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  listeningServers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not resolve the occupied test port');
  }
  return address.port;
}

function createConfig(
  dataDir: string,
  portRange: { start: number; end: number }
): AppConfig {
  return {
    version: 1,
    configPath: path.join(dataDir, 'config.yaml'),
    server: { host: '127.0.0.1', port: 4310, dataDir },
    runtime: {
      portRange,
      stopTimeoutMs: 1000,
      startupTimeoutMs: 5000,
    },
    sources: [],
    workspaces: [],
  };
}

function createWorkflow(
  dataDir: string,
  runtimeOverrides: Partial<RepositoryRuntimeConfig> = {}
): Workflow {
  const runtime: RepositoryRuntimeConfig = {
    primary: true,
    workingDirectory: '.',
    startCommand:
      "PORT=${port} node -e 'require(\"http\").createServer((_, response) => response.end(process.env.PORT)).listen(Number(process.env.PORT), \"127.0.0.1\")'",
    healthCheckUrl: 'http://127.0.0.1:${port}',
    ...runtimeOverrides,
  };
  return {
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
}

async function waitForStatus(
  manager: RuntimeManager,
  workflowId: string,
  repositoryId: string,
  expectedStatus: RuntimeState['status']
): Promise<RuntimeState> {
  let state = manager.getState(workflowId, repositoryId);
  for (let attempt = 0; attempt < 40 && state.status !== expectedStatus; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    state = manager.getState(workflowId, repositoryId);
  }
  return state;
}

describe('runtime manager', () => {
  it('uses a manually specified port before falling back to the configured range', async () => {
    const dataDir = await createDataDirectory();
    const requestedPort = await findAvailablePort();
    const automaticPort = requestedPort === 65_535 ? requestedPort - 1 : requestedPort + 1;
    const workflow = createWorkflow(dataDir);
    const manager = new RuntimeManager(
      createConfig(dataDir, { start: automaticPort, end: automaticPort })
    );

    await manager.start(workflow, 'app', { port: requestedPort });
    const state = await waitForStatus(manager, workflow.id, 'app', 'running');

    expect(state.status).toBe('running');
    expect(state.port).toBe(requestedPort);
    expect(manager.getState(workflow.id, 'other').status).toBe('stopped');
    expect(state.url).toBeDefined();
    const response = await fetch(state.url!);
    expect(await response.text()).toBe(String(requestedPort));

    await manager.stop(workflow.id, 'app');
    expect(manager.getState(workflow.id, 'app').status).toBe('stopped');
  });

  it('rejects an occupied manual port before running the prepare command', async () => {
    const dataDir = await createDataDirectory();
    const occupiedPort = await occupyAvailablePort();
    const markerFile = path.join(dataDir, 'prepare-ran');
    const workflow = createWorkflow(dataDir, {
      prepareCommand: `node -e ${JSON.stringify(
        `require('node:fs').writeFileSync(${JSON.stringify(markerFile)}, 'ran')`
      )}`,
    });
    const manager = new RuntimeManager(
      createConfig(dataDir, { start: occupiedPort, end: occupiedPort })
    );

    await expect(
      manager.start(workflow, 'app', { port: occupiedPort })
    ).rejects.toThrow(`Runtime port ${occupiedPort} is already in use`);
    expect(manager.getState(workflow.id, 'app')).toEqual({ status: 'stopped' });
    await expect(access(markerFile)).rejects.toThrow();
  });

  it('rejects startup when every automatic port is occupied before prepare', async () => {
    const dataDir = await createDataDirectory();
    const occupiedPort = await occupyAvailablePort();
    const markerFile = path.join(dataDir, 'prepare-ran');
    const workflow = createWorkflow(dataDir, {
      prepareCommand: `node -e ${JSON.stringify(
        `require('node:fs').writeFileSync(${JSON.stringify(markerFile)}, 'ran')`
      )}`,
    });
    const manager = new RuntimeManager(
      createConfig(dataDir, { start: occupiedPort, end: occupiedPort })
    );

    await expect(manager.start(workflow, 'app')).rejects.toThrow(
      `No available runtime port in configured range ${occupiedPort}-${occupiedPort}`
    );
    expect(manager.getState(workflow.id, 'app')).toEqual({ status: 'stopped' });
    await expect(access(markerFile)).rejects.toThrow();
  });
});
