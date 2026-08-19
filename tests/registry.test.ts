import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { RepositoryRegistry } from '../src/core/registry.js';
import { WorkflowStore } from '../src/core/store.js';
import type { WorkspaceConfig } from '../src/core/types.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function createGitRepository(root: string, name: string): Promise<string> {
  const repositoryPath = path.join(root, name);
  await execFileAsync('mkdir', ['-p', repositoryPath]);
  await execFileAsync('git', ['init', '-q'], { cwd: repositoryPath });
  await execFileAsync('git', ['config', 'user.email', 'workflow@example.test'], {
    cwd: repositoryPath,
  });
  await execFileAsync('git', ['config', 'user.name', 'Workflow Test'], {
    cwd: repositoryPath,
  });
  await writeFile(path.join(repositoryPath, 'README.md'), `${name}\n`, 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repositoryPath });
  await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repositoryPath });
  return repositoryPath;
}

describe('repository registry', () => {
  it('registers a manually supplied Git path and searches it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-registry-'));
    temporaryDirectories.push(root);
    const repositoryPath = await createGitRepository(root, 'sample-repository');
    const store = new WorkflowStore(path.join(root, 'data'));
    await store.initialize();
    const registry = new RepositoryRegistry(store);

    const repository = await registry.register({
      path: repositoryPath,
      label: 'Sample Application',
      role: 'application',
    });

    expect(repository.path).toBe(await realpath(repositoryPath));
    expect(registry.list('application')).toHaveLength(1);
    expect(registry.list('missing')).toHaveLength(0);
    expect((await registry.register({ path: repositoryPath })).id).toBe(
      repository.id
    );
  });

  it('migrates legacy YAML workspaces into persisted groups once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-migration-'));
    temporaryDirectories.push(root);
    const repositoryPath = await createGitRepository(root, 'legacy-repository');
    const seed: WorkspaceConfig[] = [
      {
        id: 'legacy-group',
        label: 'Legacy Group',
        matching: {
          stripBranchPrefixes: ['codex/'],
          includeBranchPatterns: ['^codex/'],
        },
        repositories: [
          {
            id: 'legacy-repository',
            label: 'Legacy Repository',
            role: 'other',
            path: repositoryPath,
            remote: 'origin',
            checks: [],
          },
        ],
      },
    ];
    const dataDir = path.join(root, 'data');
    const store = new WorkflowStore(dataDir);
    await store.initialize(seed);

    expect(store.listRepositories()).toHaveLength(1);
    expect(store.listGroups()[0]?.repositoryIds).toHaveLength(1);

    const reloaded = new WorkflowStore(dataDir);
    await reloaded.initialize([]);
    expect(reloaded.getWorkspaceConfigs()[0]?.repositories).toHaveLength(1);
    if (process.platform !== 'win32') {
      expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(dataDir, 'state.json'))).mode & 0o777).toBe(0o600);
    }
  });
});
