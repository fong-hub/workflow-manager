import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { runFile } from './command.js';
import { WorkflowStore } from './store.js';
import type {
  AppConfig,
  PreflightCheck,
  ReleaseStrategy,
  ReleaseTargetSelection,
  Workflow,
  WorkflowRepository,
} from './types.js';

export interface RepositoryReleaseResult {
  repositoryId: string;
  targetBranch: string;
  strategy: ReleaseStrategy;
  status: 'released' | 'failed' | 'skipped';
  detail: string;
}

export interface ReleaseResult {
  status: 'released' | 'partially-released' | 'failed';
  startedAt: string;
  finishedAt: string;
  logFile: string;
  repositories: RepositoryReleaseResult[];
}

interface ResolvedReleaseSelection {
  targetBranch: string;
  strategy: ReleaseStrategy;
}

function selectionMap(
  workflow: Workflow,
  selections: ReleaseTargetSelection[]
): Map<string, ResolvedReleaseSelection> {
  const selected = new Map(
    selections.map((selection) => [
      selection.repositoryId,
      {
        targetBranch: selection.targetBranch,
        strategy:
          selection.strategy ??
          workflow.repositories.find(
            (repository) => repository.repositoryId === selection.repositoryId
          )?.release?.strategy ??
          'cherry-pick',
      },
    ])
  );
  for (const repository of workflow.repositories) {
    if (repository.release && !selected.has(repository.repositoryId)) {
      selected.set(repository.repositoryId, {
        targetBranch: repository.release.defaultTargetBranch,
        strategy: repository.release.strategy,
      });
    }
  }
  return selected;
}

async function shell(command: string, cwd: string, log: NodeJS.WritableStream) {
  return new Promise<number | null>((resolve, reject) => {
    log.write(`\n$ ${command}\n`);
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

/** Performs generic Git safety checks before a configured release. */
export class ReleaseManager {
  constructor(
    private readonly config: AppConfig,
    private readonly store: WorkflowStore
  ) {}

  async preflight(
    workflow: Workflow,
    selections: ReleaseTargetSelection[]
  ): Promise<PreflightCheck[]> {
    const checks: PreflightCheck[] = [];
    const targets = selectionMap(workflow, selections);
    const acceptanceUsable = Boolean(
      workflow.acceptance && !workflow.acceptanceStale
    );

    checks.push({
      id: 'accepted',
      label: '存在验收 Commit 快照',
      status: workflow.acceptance ? 'passed' : 'failed',
      detail: workflow.acceptance
        ? `验收时间：${workflow.acceptance.acceptedAt}`
        : '当前工作流尚未验收。请先提交全部改动，再在“概览”中绑定验收 Commit。',
    });
    checks.push({
      id: 'acceptance-current',
      label: '验收 Commit 与当前 HEAD 一致',
      status: !workflow.acceptance
        ? 'blocked'
        : workflow.acceptanceStale
          ? 'failed'
          : 'passed',
      detail: !workflow.acceptance
        ? '等待验收快照，当前检查未执行。'
        : workflow.acceptanceStale
          ? '至少一个仓库在验收后产生了新的 Commit，需要重新验收。'
          : '所有仓库当前 HEAD 与验收快照一致。',
    });

    for (const repository of workflow.repositories) {
      if (!repository.release) continue;
      const selection = targets.get(repository.repositoryId);
      const targetBranch = selection?.targetBranch;
      const strategy = selection?.strategy ?? repository.release.strategy;
      const common = { repositoryId: repository.repositoryId };
      const dirtySummary = repository.dirtyFiles.slice(0, 5).join('、');
      checks.push({
        id: `clean:${repository.repositoryId}`,
        label: `${repository.repositoryLabel} worktree 已提交`,
        status: repository.dirty ? 'failed' : 'passed',
        detail: repository.dirty
          ? `存在 ${repository.dirtyFiles.length} 个未提交文件：${dirtySummary}${repository.dirtyFiles.length > 5 ? ' 等' : ''}`
          : '没有未提交或未跟踪的文件。',
        ...common,
      });
      checks.push({
        id: `target:${repository.repositoryId}`,
        label: `${repository.repositoryLabel} 目标分支允许发布`,
        status:
          targetBranch &&
          repository.release.allowedTargetBranches.includes(targetBranch)
            ? 'passed'
            : 'failed',
        detail: targetBranch
          ? `目标分支：${targetBranch}`
          : '尚未选择目标分支。',
        ...common,
      });
      if (!targetBranch) continue;

      const repositoryConfig = this.findRepositoryConfig(
        workflow.workspaceId,
        repository.repositoryId
      );
      const fetchResult = await runFile(
        'git',
        ['fetch', repositoryConfig.remote, targetBranch],
        { cwd: repository.repositoryPath, allowFailure: true }
      );
      checks.push({
        id: `fetch:${repository.repositoryId}`,
        label: `${repository.repositoryLabel} 可读取目标分支`,
        status: fetchResult.exitCode === 0 ? 'passed' : 'failed',
        detail:
          fetchResult.exitCode === 0
            ? `${repositoryConfig.remote}/${targetBranch}`
            : fetchResult.stderr.trim(),
        ...common,
      });
      if (fetchResult.exitCode !== 0) continue;

      const acceptedCommit = workflow.acceptance?.commits[repository.repositoryId];
      if (!acceptanceUsable || !acceptedCommit) {
        checks.push({
          id: `integration:${repository.repositoryId}`,
          label: `${repository.repositoryLabel} 可按 ${strategy} 集成`,
          status: 'blocked',
          detail: !workflow.acceptance
            ? '等待验收 Commit，集成检查未执行。'
            : workflow.acceptanceStale
              ? '验收快照已失效，请重新验收后再检查。'
              : '验收快照中缺少该仓库的 Commit。',
          ...common,
        });
        continue;
      }

      checks.push(
        await this.checkIntegration(
          repository,
          repositoryConfig.remote,
          targetBranch,
          acceptedCommit,
          strategy
        )
      );
    }
    return checks;
  }

  private async checkIntegration(
    repository: WorkflowRepository,
    remote: string,
    targetBranch: string,
    acceptedCommit: string,
    strategy: ReleaseStrategy
  ): Promise<PreflightCheck> {
    const targetRef = `${remote}/${targetBranch}`;
    const common = {
      id: `integration:${repository.repositoryId}`,
      label: `${repository.repositoryLabel} 可按 ${strategy} 集成`,
      repositoryId: repository.repositoryId,
    };

    if (strategy === 'fast-forward') {
      const targetIsAncestor = await runFile(
        'git',
        ['merge-base', '--is-ancestor', targetRef, acceptedCommit],
        { cwd: repository.repositoryPath, allowFailure: true }
      );
      if (targetIsAncestor.exitCode === 0) {
        return {
          ...common,
          status: 'passed',
          detail: `${acceptedCommit.slice(0, 10)} 可以直接推进 ${targetBranch}。`,
        };
      }
      const sourceIsAncestor = await runFile(
        'git',
        ['merge-base', '--is-ancestor', acceptedCommit, targetRef],
        { cwd: repository.repositoryPath, allowFailure: true }
      );
      const counts = await runFile(
        'git',
        ['rev-list', '--left-right', '--count', `${acceptedCommit}...${targetRef}`],
        { cwd: repository.repositoryPath, allowFailure: true }
      );
      const [sourceOnly = '0', targetOnly = '0'] = counts.stdout
        .trim()
        .split(/\s+/);
      return {
        ...common,
        status: 'failed',
        detail:
          sourceIsAncestor.exitCode === 0
            ? `目标分支领先验收 Commit ${targetOnly} 个提交，fast-forward 没有可推进内容。请选择 cherry-pick，或先基于最新目标分支整理功能提交。`
            : `功能分支与目标分支已分叉（功能独有 ${sourceOnly}，目标独有 ${targetOnly}）。独立 worktree 发布建议选择 cherry-pick。`,
      };
    }

    const commits = await runFile(
      'git',
      ['rev-list', '--reverse', `${targetRef}..${acceptedCommit}`],
      { cwd: repository.repositoryPath, allowFailure: true }
    );
    if (commits.exitCode !== 0) {
      return {
        ...common,
        status: 'failed',
        detail: commits.stderr.trim() || '无法计算待发布 Commit。',
      };
    }
    const commitList = commits.stdout.trim().split('\n').filter(Boolean);
    if (commitList.length === 0) {
      return {
        ...common,
        status: 'warning',
        detail: `目标分支已经包含或领先验收 Commit，没有独有 Commit 需要 ${strategy}。`,
      };
    }
    return {
      ...common,
      status: 'passed',
      detail:
        strategy === 'cherry-pick'
          ? `将从最新 ${targetRef} 临时 worktree 顺序 cherry-pick ${commitList.length} 个验收 Commit。`
          : `将把包含 ${commitList.length} 个独有 Commit 的验收分支合并到最新 ${targetRef}。`,
    };
  }

  async release(
    workflow: Workflow,
    selections: ReleaseTargetSelection[]
  ): Promise<ReleaseResult> {
    const preflight = await this.preflight(workflow, selections);
    const blocking = preflight.filter(
      (check) => check.status === 'failed' || check.status === 'blocked'
    );
    if (blocking.length > 0) {
      throw new Error(
        `发布预检未通过：${blocking.map((check) => check.label).join('、')}`
      );
    }
    if (!workflow.acceptance) throw new Error('工作流尚未验收');

    const startedAt = new Date().toISOString();
    const logDirectory = path.join(
      this.config.server.dataDir,
      'logs',
      workflow.id.replaceAll(/[^a-zA-Z0-9_.-]/g, '_')
    );
    await mkdir(logDirectory, { recursive: true, mode: 0o700 });
    const logFile = path.join(logDirectory, `release-${Date.now()}.log`);
    const log = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
    const targets = selectionMap(workflow, selections);
    const releasable = workflow.repositories
      .filter((repository) => repository.release)
      .sort((a, b) => (a.release?.order ?? 0) - (b.release?.order ?? 0));
    const results: RepositoryReleaseResult[] = [];
    let halted = false;

    for (const repository of releasable) {
      const selection = targets.get(repository.repositoryId)!;
      if (halted) {
        results.push({
          repositoryId: repository.repositoryId,
          targetBranch: selection.targetBranch,
          strategy: selection.strategy,
          status: 'skipped',
          detail: '前序仓库发布失败，本仓库未执行。',
        });
        continue;
      }
      try {
        await this.releaseRepository(
          workflow,
          repository,
          selection.targetBranch,
          workflow.acceptance.commits[repository.repositoryId]!,
          selection.strategy,
          log
        );
        results.push({
          repositoryId: repository.repositoryId,
          targetBranch: selection.targetBranch,
          strategy: selection.strategy,
          status: 'released',
          detail: `已按 ${selection.strategy} 推送到 ${selection.targetBranch}。`,
        });
      } catch (error) {
        halted = true;
        const message = error instanceof Error ? error.message : String(error);
        log.write(`\n[release-error] ${message}\n`);
        results.push({
          repositoryId: repository.repositoryId,
          targetBranch: selection.targetBranch,
          strategy: selection.strategy,
          status: 'failed',
          detail: message,
        });
      }
    }
    log.end();

    const releasedCount = results.filter(
      (result) => result.status === 'released'
    ).length;
    const finalStatus = halted
      ? releasedCount > 0
        ? 'partially-released'
        : 'failed'
      : 'released';
    return {
      status: finalStatus,
      startedAt,
      finishedAt: new Date().toISOString(),
      logFile,
      repositories: results,
    };
  }

  private async releaseRepository(
    workflow: Workflow,
    repository: WorkflowRepository,
    targetBranch: string,
    acceptedCommit: string,
    strategy: ReleaseStrategy,
    log: NodeJS.WritableStream
  ): Promise<void> {
    const repositoryConfig = this.findRepositoryConfig(
      workflow.workspaceId,
      repository.repositoryId
    );
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), `workflow-manager-${repository.repositoryId}-`)
    );
    const releaseWorktree = path.join(tempRoot, 'worktree');
    try {
      const add = await runFile(
        'git',
        [
          'worktree',
          'add',
          '--detach',
          releaseWorktree,
          `${repositoryConfig.remote}/${targetBranch}`,
        ],
        { cwd: repository.repositoryPath, allowFailure: true }
      );
      log.write(add.stdout);
      log.write(add.stderr);
      if (add.exitCode !== 0) throw new Error('创建临时发布 worktree 失败');

      if (strategy === 'fast-forward') {
        const reset = await runFile('git', ['reset', '--hard', acceptedCommit], {
          cwd: releaseWorktree,
          allowFailure: true,
        });
        log.write(reset.stdout);
        log.write(reset.stderr);
        if (reset.exitCode !== 0) throw new Error('定位验收 Commit 失败');
      } else if (strategy === 'merge') {
        const merge = await runFile(
          'git',
          ['merge', '--no-edit', acceptedCommit],
          { cwd: releaseWorktree, allowFailure: true }
        );
        log.write(merge.stdout);
        log.write(merge.stderr);
        if (merge.exitCode !== 0) throw new Error('合并验收 Commit 失败');
      } else {
        const commits = await runFile(
          'git',
          [
            'rev-list',
            '--reverse',
            `${repositoryConfig.remote}/${targetBranch}..${acceptedCommit}`,
          ],
          { cwd: repository.repositoryPath, allowFailure: true }
        );
        if (commits.exitCode !== 0) throw new Error('无法计算待发布 Commit');
        const commitList = commits.stdout.trim().split('\n').filter(Boolean);
        if (commitList.length > 0) {
          const cherryPick = await runFile('git', ['cherry-pick', ...commitList], {
            cwd: releaseWorktree,
            allowFailure: true,
          });
          log.write(cherryPick.stdout);
          log.write(cherryPick.stderr);
          if (cherryPick.exitCode !== 0) throw new Error('Cherry-pick 验收 Commit 失败');
        }
      }

      if (repository.runtime?.prepareCommand) {
        const code = await shell(
          repository.runtime.prepareCommand,
          path.resolve(releaseWorktree, repository.runtime.workingDirectory),
          log
        );
        if (code !== 0) throw new Error(`准备命令失败，退出码 ${code}`);
      }
      for (const check of repository.checks) {
        const code = await shell(check.command, releaseWorktree, log);
        if (code !== 0) {
          throw new Error(`${check.label} 失败，退出码 ${code}`);
        }
      }

      const push = await runFile(
        'git',
        ['push', repositoryConfig.remote, `HEAD:${targetBranch}`],
        { cwd: releaseWorktree, allowFailure: true }
      );
      log.write(push.stdout);
      log.write(push.stderr);
      if (push.exitCode !== 0) throw new Error('Git push 被远端拒绝');
    } finally {
      await runFile('git', ['worktree', 'remove', '--force', releaseWorktree], {
        cwd: repository.repositoryPath,
        allowFailure: true,
      });
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  private findRepositoryConfig(workspaceId: string, repositoryId: string) {
    const group = this.store.getGroup(workspaceId);
    if (!group?.repositoryIds.includes(repositoryId)) {
      throw new Error(
        `仓库未关联到当前组：${workspaceId}/${repositoryId}`
      );
    }
    const repository = this.store.getRepository(repositoryId);
    if (!repository) {
      throw new Error(`仓库配置不存在：${workspaceId}/${repositoryId}`);
    }
    return repository;
  }
}
