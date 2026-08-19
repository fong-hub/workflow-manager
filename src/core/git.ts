import path from 'node:path';

import { runFile } from './command.js';
import type { RepositoryConfig, WorkflowRepository } from './types.js';

interface RawWorktree {
  path: string;
  headCommit: string;
  branch?: string;
  detached: boolean;
  prunable: boolean;
}

/** Parses the stable porcelain worktree format emitted by Git. */
export function parseWorktreePorcelain(output: string): RawWorktree[] {
  const records = output.trim().split(/\n\n+/).filter(Boolean);
  return records.map((record) => {
    const result: RawWorktree = {
      path: '',
      headCommit: '',
      detached: false,
      prunable: false,
    };
    for (const line of record.split('\n')) {
      if (line.startsWith('worktree ')) result.path = line.slice(9);
      else if (line.startsWith('HEAD ')) result.headCommit = line.slice(5);
      else if (line.startsWith('branch ')) {
        result.branch = line.slice(7).replace(/^refs\/heads\//, '');
      } else if (line === 'detached') result.detached = true;
      else if (line.startsWith('prunable')) result.prunable = true;
    }
    return result;
  });
}

async function getWorktreeState(
  repository: RepositoryConfig,
  worktree: RawWorktree
): Promise<WorkflowRepository> {
  const status = await runFile('git', ['status', '--porcelain=v1'], {
    cwd: worktree.path,
    allowFailure: true,
  });
  const upstream = await runFile(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { cwd: worktree.path, allowFailure: true }
  );

  let ahead = 0;
  let behind = 0;
  const upstreamName = upstream.exitCode === 0 ? upstream.stdout.trim() : undefined;
  if (upstreamName) {
    const counts = await runFile(
      'git',
      ['rev-list', '--left-right', '--count', `HEAD...${upstreamName}`],
      { cwd: worktree.path, allowFailure: true }
    );
    if (counts.exitCode === 0) {
      const [left = '0', right = '0'] = counts.stdout.trim().split(/\s+/);
      ahead = Number(left);
      behind = Number(right);
    }
  }

  const dirtyFiles = status.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  return {
    repositoryId: repository.id,
    repositoryLabel: repository.label,
    role: repository.role,
    repositoryPath: repository.path,
    worktreePath: path.resolve(worktree.path),
    branch: worktree.branch ?? '(detached)',
    headCommit: worktree.headCommit,
    detached: worktree.detached,
    prunable: worktree.prunable,
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
    ...(upstreamName ? { upstream: upstreamName } : {}),
    ahead,
    behind,
    ...(repository.release ? { release: repository.release } : {}),
    ...(repository.runtime ? { runtime: repository.runtime } : {}),
    checks: repository.checks,
  };
}

/** Discovers every registered worktree for a configured repository. */
export async function scanRepositoryWorktrees(
  repository: RepositoryConfig
): Promise<WorkflowRepository[]> {
  const result = await runFile('git', ['worktree', 'list', '--porcelain'], {
    cwd: repository.path,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Cannot scan repository ${repository.id}: ${result.stderr.trim()}`
    );
  }
  return Promise.all(
    parseWorktreePorcelain(result.stdout).map((worktree) =>
      getWorktreeState(repository, worktree)
    )
  );
}

/** Returns a normalized workflow key from a branch name. */
export function normalizeBranch(
  branch: string,
  stripPrefixes: string[]
): string {
  const prefix = stripPrefixes.find((candidate) => branch.startsWith(candidate));
  return prefix ? branch.slice(prefix.length) : branch;
}

/** Checks whether a branch should be included by configured expressions. */
export function branchIncluded(branch: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => new RegExp(pattern).test(branch));
}
