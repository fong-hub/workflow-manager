import { describe, expect, it } from 'vitest';

import {
  branchIncluded,
  normalizeBranch,
  parseWorktreePorcelain,
} from '../src/core/git.js';

describe('git worktree discovery', () => {
  it('parses porcelain records', () => {
    const records = parseWorktreePorcelain(`worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo/.worktrees/task\nHEAD def456\nbranch refs/heads/codex/task\nprunable gitdir file missing\n`);
    expect(records).toEqual([
      {
        path: '/repo',
        headCommit: 'abc123',
        branch: 'main',
        detached: false,
        prunable: false,
      },
      {
        path: '/repo/.worktrees/task',
        headCommit: 'def456',
        branch: 'codex/task',
        detached: false,
        prunable: true,
      },
    ]);
  });

  it('normalizes configured branch prefixes', () => {
    expect(normalizeBranch('codex/fix-price', ['codex/', 'fix/'])).toBe('fix-price');
    expect(normalizeBranch('release/sit', ['codex/'])).toBe('release/sit');
  });

  it('filters branches with configured expressions', () => {
    expect(branchIncluded('codex/task', ['^codex/'])).toBe(true);
    expect(branchIncluded('main', ['^codex/'])).toBe(false);
    expect(branchIncluded('main', [])).toBe(true);
  });
});
