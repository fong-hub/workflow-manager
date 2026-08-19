import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  AcceptanceSnapshot,
  MatchingConfig,
  RegisteredRepository,
  RepositoryConfig,
  RepositoryGroup,
  WorkspaceConfig,
} from './types.js';

interface PersistedState {
  acceptances: Record<string, AcceptanceSnapshot>;
  titles: Record<string, string>;
  repositories: Record<string, RegisteredRepository>;
  groups: Record<string, RepositoryGroup>;
  migrations: Record<string, string>;
}

const EMPTY_STATE: PersistedState = {
  acceptances: {},
  titles: {},
  repositories: {},
  groups: {},
  migrations: {},
};

function slugify(input: string, fallback: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function uniqueId(base: string, existing: Record<string, unknown>): string {
  if (!existing[base]) return base;
  return `${base}-${randomUUID().slice(0, 6)}`;
}

/** Atomic local registry for repositories, groups, acceptance and UI metadata. */
export class WorkflowStore {
  private readonly filePath: string;
  private state: PersistedState = structuredClone(EMPTY_STATE);

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'state.json');
  }

  async initialize(seedWorkspaces: WorkspaceConfig[] = []): Promise<void> {
    const dataDirectory = path.dirname(this.filePath);
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await chmod(dataDirectory, 0o700);
    try {
      const loaded = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<PersistedState>;
      await chmod(this.filePath, 0o600);
      this.state = {
        acceptances: loaded.acceptances ?? {},
        titles: loaded.titles ?? {},
        repositories: loaded.repositories ?? {},
        groups: loaded.groups ?? {},
        migrations: loaded.migrations ?? {},
      };
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code !== 'ENOENT') throw error;
    }
    await this.seedFromLegacyConfig(seedWorkspaces);
    await this.persist();
  }

  listRepositories(query = ''): RegisteredRepository[] {
    const normalized = query.trim().toLowerCase();
    return Object.values(this.state.repositories)
      .filter((repository) => {
        if (!normalized) return true;
        return [
          repository.id,
          repository.label,
          repository.path,
          repository.remote,
          repository.remoteUrl ?? '',
        ].some((value) => value.toLowerCase().includes(normalized));
      })
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  }

  getRepository(repositoryId: string): RegisteredRepository | undefined {
    return this.state.repositories[repositoryId];
  }

  async addRepository(
    repository: Omit<RegisteredRepository, 'id' | 'createdAt' | 'updatedAt'> & {
      id?: string;
    }
  ): Promise<RegisteredRepository> {
    const now = new Date().toISOString();
    const baseId = slugify(repository.id ?? repository.label, 'repository');
    const id = uniqueId(baseId, this.state.repositories);
    const record: RegisteredRepository = {
      ...repository,
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.state.repositories[id] = record;
    await this.persist();
    return record;
  }

  async updateRepository(
    repositoryId: string,
    patch: Partial<Omit<RegisteredRepository, 'id' | 'createdAt'>>
  ): Promise<RegisteredRepository> {
    const current = this.state.repositories[repositoryId];
    if (!current) throw new Error(`Repository not found: ${repositoryId}`);
    const updated: RegisteredRepository = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.state.repositories[repositoryId] = updated;
    await this.persist();
    return updated;
  }

  async removeRepository(repositoryId: string): Promise<void> {
    if (!this.state.repositories[repositoryId]) {
      throw new Error(`Repository not found: ${repositoryId}`);
    }
    delete this.state.repositories[repositoryId];
    for (const group of Object.values(this.state.groups)) {
      group.repositoryIds = group.repositoryIds.filter((id) => id !== repositoryId);
      group.updatedAt = new Date().toISOString();
    }
    await this.persist();
  }

  listGroups(): RepositoryGroup[] {
    return Object.values(this.state.groups).sort((a, b) =>
      a.label.localeCompare(b.label, 'zh-CN')
    );
  }

  getGroup(groupId: string): RepositoryGroup | undefined {
    return this.state.groups[groupId];
  }

  async addGroup(input: {
    id?: string;
    label: string;
    matching?: MatchingConfig;
    repositoryIds?: string[];
  }): Promise<RepositoryGroup> {
    const now = new Date().toISOString();
    const baseId = slugify(input.id ?? input.label, 'group');
    const id = uniqueId(baseId, this.state.groups);
    const group: RepositoryGroup = {
      id,
      label: input.label.trim(),
      matching: input.matching ?? {
        stripBranchPrefixes: ['codex/', 'feature/', 'feat/', 'fix/'],
        includeBranchPatterns: ['^(codex|feature|feat|fix)/'],
      },
      repositoryIds: [...new Set(input.repositoryIds ?? [])],
      createdAt: now,
      updatedAt: now,
    };
    this.assertRepositoriesExist(group.repositoryIds);
    this.state.groups[id] = group;
    await this.persist();
    return group;
  }

  async updateGroup(
    groupId: string,
    patch: Partial<Pick<RepositoryGroup, 'label' | 'matching' | 'repositoryIds'>>
  ): Promise<RepositoryGroup> {
    const current = this.state.groups[groupId];
    if (!current) throw new Error(`Repository group not found: ${groupId}`);
    const repositoryIds = patch.repositoryIds
      ? [...new Set(patch.repositoryIds)]
      : current.repositoryIds;
    this.assertRepositoriesExist(repositoryIds);
    const updated: RepositoryGroup = {
      ...current,
      ...patch,
      repositoryIds,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.state.groups[groupId] = updated;
    await this.persist();
    return updated;
  }

  async removeGroup(groupId: string): Promise<void> {
    if (!this.state.groups[groupId]) {
      throw new Error(`Repository group not found: ${groupId}`);
    }
    delete this.state.groups[groupId];
    await this.persist();
  }

  getWorkspaceConfigs(): WorkspaceConfig[] {
    return this.listGroups().map((group) => ({
      id: group.id,
      label: group.label,
      matching: group.matching,
      repositories: group.repositoryIds
        .map((repositoryId) => this.state.repositories[repositoryId])
        .filter((repository): repository is RegisteredRepository => Boolean(repository))
        .map((repository) => this.toRepositoryConfig(repository)),
    }));
  }

  getAcceptance(workflowId: string): AcceptanceSnapshot | undefined {
    return this.state.acceptances[workflowId];
  }

  async setAcceptance(
    workflowId: string,
    acceptance: AcceptanceSnapshot
  ): Promise<void> {
    this.state.acceptances[workflowId] = acceptance;
    await this.persist();
  }

  getTitle(workflowId: string): string | undefined {
    return this.state.titles[workflowId];
  }

  async setTitle(workflowId: string, title: string): Promise<void> {
    this.state.titles[workflowId] = title;
    await this.persist();
  }

  private async seedFromLegacyConfig(workspaces: WorkspaceConfig[]): Promise<void> {
    if (
      workspaces.length === 0 ||
      this.state.migrations['legacy-workspaces-v1']
    ) {
      return;
    }
    for (const workspace of workspaces) {
      const repositoryIds: string[] = [];
      for (const repository of workspace.repositories) {
        const existing = Object.values(this.state.repositories).find(
          (candidate) => candidate.path === repository.path
        );
        if (existing) {
          repositoryIds.push(existing.id);
          continue;
        }
        const created = await this.addRepository({
          ...repository,
        });
        repositoryIds.push(created.id);
      }
      const existingGroup = Object.values(this.state.groups).find(
        (group) => group.id === workspace.id
      );
      if (existingGroup) {
        await this.updateGroup(existingGroup.id, {
          label: workspace.label,
          matching: workspace.matching,
          repositoryIds,
        });
      } else {
        await this.addGroup({
          id: workspace.id,
          label: workspace.label,
          matching: workspace.matching,
          repositoryIds,
        });
      }
    }
    this.state.migrations['legacy-workspaces-v1'] = new Date().toISOString();
  }

  private toRepositoryConfig(repository: RegisteredRepository): RepositoryConfig {
    return {
      id: repository.id,
      label: repository.label,
      role: repository.role,
      path: repository.path,
      remote: repository.remote,
      checks: repository.checks,
      ...(repository.release ? { release: repository.release } : {}),
      ...(repository.runtime ? { runtime: repository.runtime } : {}),
    };
  }

  private assertRepositoriesExist(repositoryIds: string[]): void {
    const missing = repositoryIds.filter((id) => !this.state.repositories[id]);
    if (missing.length > 0) {
      throw new Error(`Unknown repositories: ${missing.join(', ')}`);
    }
  }

  private async persist(): Promise<void> {
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}
