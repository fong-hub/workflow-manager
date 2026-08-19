import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { ReleaseManager } from '../src/core/release.js';
import { WorkflowStore } from '../src/core/store.js';
import type { AppConfig, Workflow } from '../src/core/types.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe('release preflight', () => {
  it('blocks integration checks without acceptance and explains dirty files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-release-'));
    temporaryDirectories.push(root);
    const repositoryPath = path.join(root, 'repository');
    await execFileAsync('mkdir', ['-p', repositoryPath]);
    const git = (...args: string[]) =>
      execFileAsync('git', args, { cwd: repositoryPath });
    await git('init', '-q');
    await git('config', 'user.email', 'workflow@example.test');
    await git('config', 'user.name', 'Workflow Test');
    await writeFile(path.join(repositoryPath, 'README.md'), 'base\n', 'utf8');
    await git('add', 'README.md');
    await git('commit', '-qm', 'base');
    await git('branch', '-M', 'integration');
    await git('branch', 'codex/test');
    await writeFile(path.join(repositoryPath, 'TARGET.md'), 'target\n', 'utf8');
    await git('add', 'TARGET.md');
    await git('commit', '-qm', 'target advances');
    await git('remote', 'add', 'origin', repositoryPath);
    await git('switch', '-q', 'codex/test');
    const head = (await git('rev-parse', 'HEAD')).stdout.trim();

    const dataDir = path.join(root, 'data');
    const store = new WorkflowStore(dataDir);
    await store.initialize();
    const repository = await store.addRepository({
      id: 'app',
      label: 'Application',
      role: 'application',
      path: repositoryPath,
      remote: 'origin',
      checks: [],
      release: {
        order: 10,
        defaultTargetBranch: 'integration',
        allowedTargetBranches: ['integration'],
        strategy: 'fast-forward',
      },
    });
    await store.addGroup({
      id: 'product',
      label: 'Product',
      repositoryIds: [repository.id],
    });
    const config: AppConfig = {
      version: 1,
      configPath: path.join(root, 'config.yaml'),
      server: { host: '127.0.0.1', port: 4310, dataDir },
      runtime: {
        portRange: { start: 3290, end: 3299 },
        stopTimeoutMs: 1000,
        startupTimeoutMs: 5000,
      },
      sources: [],
      workspaces: [],
    };
    const workflow: Workflow = {
      id: 'product::test',
      key: 'test',
      title: 'Test',
      workspaceId: 'product',
      workspaceLabel: 'Product',
      repositories: [
        {
          repositoryId: repository.id,
          repositoryLabel: repository.label,
          role: repository.role,
          repositoryPath,
          worktreePath: repositoryPath,
          branch: 'codex/test',
          headCommit: head,
          detached: false,
          prunable: false,
          dirty: true,
          dirtyFiles: ['src/changed.ts'],
          upstream: 'origin/integration',
          ahead: 0,
          behind: 1,
          release: repository.release,
          checks: [],
        },
      ],
      acceptanceStale: false,
      runtimes: {},
    };

    const checks = await new ReleaseManager(config, store).preflight(workflow, [
      {
        repositoryId: repository.id,
        targetBranch: 'integration',
        strategy: 'cherry-pick',
      },
    ]);

    expect(checks.find((check) => check.id === 'accepted')?.status).toBe('failed');
    expect(checks.find((check) => check.id === 'acceptance-current')?.status).toBe('blocked');
    expect(checks.find((check) => check.id === `clean:${repository.id}`)?.detail).toContain('src/changed.ts');
    expect(checks.find((check) => check.id === `integration:${repository.id}`)?.status).toBe('blocked');
  });
});
