import path from 'node:path';

import {
  branchIncluded,
  normalizeBranch,
  scanRepositoryWorktrees,
} from './git.js';
import { discoverSessions } from './sessions.js';
import type {
  AppConfig,
  RuntimeState,
  SessionHint,
  Workflow,
  WorkflowRepository,
  WorkspaceConfig,
} from './types.js';
import { WorkflowStore } from './store.js';

export interface RuntimeStateReader {
  getState(workflowId: string, repositoryId: string): RuntimeState;
}

function selectSession(
  repositories: WorkflowRepository[],
  sessions: SessionHint[],
  workspace: WorkspaceConfig,
  key: string
): SessionHint | undefined {
  const worktreePaths = new Set(
    repositories.map((repository) => path.resolve(repository.worktreePath))
  );
  const exactCwd = sessions.find((session) =>
    worktreePaths.has(path.resolve(session.cwd))
  );
  if (exactCwd) return exactCwd;
  return sessions.find(
    (session) =>
      session.branch &&
      normalizeBranch(session.branch, workspace.matching.stripBranchPrefixes) === key
  );
}

/** Aggregates configured repositories and discovery sources into workflows. */
export class WorkflowService {
  private cachedWorkflows: Workflow[] | undefined;
  private cacheCreatedAt = 0;
  private activeScan: Promise<Workflow[]> | undefined;
  private readonly cacheTtlMs = 60_000;

  constructor(
    private readonly config: AppConfig,
    private readonly store: WorkflowStore,
    private readonly runtimes: RuntimeStateReader
  ) {}

  invalidate(): void {
    this.cachedWorkflows = undefined;
    this.cacheCreatedAt = 0;
  }

  async list(force = false): Promise<Workflow[]> {
    const now = Date.now();
    if (!force && this.cachedWorkflows && now - this.cacheCreatedAt < this.cacheTtlMs) {
      return this.decorateRuntime(this.cachedWorkflows);
    }
    if (!force && this.activeScan) return this.activeScan;
    this.activeScan = this.scan();
    try {
      const workflows = await this.activeScan;
      this.cachedWorkflows = workflows;
      this.cacheCreatedAt = Date.now();
      return this.decorateRuntime(workflows);
    } finally {
      this.activeScan = undefined;
    }
  }

  private async scan(): Promise<Workflow[]> {
    const sessions = await discoverSessions(this.config.sources);
    const workflows: Workflow[] = [];

    for (const workspace of this.store.getWorkspaceConfigs()) {
      const repositoryScans = await Promise.all(
        workspace.repositories.map((repository) =>
          scanRepositoryWorktrees(repository)
        )
      );
      const groups = new Map<string, WorkflowRepository[]>();

      for (const repositoryWorktrees of repositoryScans) {
        for (const worktree of repositoryWorktrees) {
          if (
            worktree.detached ||
            !branchIncluded(
              worktree.branch,
              workspace.matching.includeBranchPatterns
            )
          ) {
            continue;
          }
          const key = normalizeBranch(
            worktree.branch,
            workspace.matching.stripBranchPrefixes
          );
          const existing = groups.get(key) ?? [];
          existing.push(worktree);
          groups.set(key, existing);
        }
      }

      for (const [key, repositories] of groups) {
        const id = `${workspace.id}::${key}`;
        const acceptance = this.store.getAcceptance(id);
        const acceptanceStale = Boolean(
          acceptance &&
            repositories.some(
              (repository) =>
                acceptance.commits[repository.repositoryId] !==
                repository.headCommit
            )
        );
        const session = selectSession(repositories, sessions, workspace, key);
        workflows.push({
          id,
          key,
          title: this.store.getTitle(id) ?? key,
          workspaceId: workspace.id,
          workspaceLabel: workspace.label,
          repositories: repositories.sort((a, b) =>
            a.repositoryId.localeCompare(b.repositoryId)
          ),
          ...(session ? { session } : {}),
          ...(acceptance ? { acceptance } : {}),
          acceptanceStale,
          runtimes: Object.fromEntries(
            repositories
              .filter((repository) => repository.runtime)
              .map((repository) => [
                repository.repositoryId,
                this.runtimes.getState(id, repository.repositoryId),
              ])
          ),
        });
      }
    }

    return workflows.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  }

  private decorateRuntime(workflows: Workflow[]): Workflow[] {
    return workflows
      .map((workflow) => ({
        ...workflow,
        runtimes: Object.fromEntries(
          workflow.repositories
            .filter((repository) => repository.runtime)
            .map((repository) => [
              repository.repositoryId,
              this.runtimes.getState(workflow.id, repository.repositoryId),
            ])
        ),
      }))
      .sort((a, b) => {
        const aRunning = Object.values(a.runtimes).some(
          (runtime) => runtime.status === 'running'
        )
          ? 1
          : 0;
        const bRunning = Object.values(b.runtimes).some(
          (runtime) => runtime.status === 'running'
        )
          ? 1
          : 0;
        if (aRunning !== bRunning) return bRunning - aRunning;
        return a.title.localeCompare(b.title, 'zh-CN');
      });
  }

  async get(workflowId: string): Promise<Workflow | undefined> {
    return (await this.list()).find((workflow) => workflow.id === workflowId);
  }

  async accept(workflowId: string, note?: string): Promise<Workflow> {
    const workflow = await this.get(workflowId);
    if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
    if (workflow.repositories.some((repository) => repository.dirty)) {
      throw new Error('Cannot accept a workflow with uncommitted changes');
    }
    await this.store.setAcceptance(workflowId, {
      acceptedAt: new Date().toISOString(),
      commits: Object.fromEntries(
        workflow.repositories.map((repository) => [
          repository.repositoryId,
          repository.headCommit,
        ])
      ),
      ...(note?.trim() ? { note: note.trim() } : {}),
    });
    this.cachedWorkflows = undefined;
    return (await this.get(workflowId))!;
  }

  async rename(workflowId: string, title: string): Promise<Workflow> {
    if (!title.trim()) throw new Error('Workflow title cannot be empty');
    const workflow = await this.get(workflowId);
    if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
    await this.store.setTitle(workflowId, title.trim());
    this.cachedWorkflows = undefined;
    return (await this.get(workflowId))!;
  }
}
