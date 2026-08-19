import path from 'node:path';

import { runFile } from './command.js';
import { expandHome } from './config.js';
import { WorkflowStore } from './store.js';
import type {
  CheckConfig,
  RegisteredRepository,
  RepositoryReleaseConfig,
  RepositoryRole,
  RepositoryRuntimeConfig,
} from './types.js';

export interface RegisterRepositoryInput {
  path: string;
  label?: string;
  role?: RepositoryRole;
  remote?: string;
  runtime?: RepositoryRuntimeConfig;
  release?: RepositoryReleaseConfig;
  checks?: CheckConfig[];
}

/** Validates and registers local Git repositories without scanning the filesystem. */
export class RepositoryRegistry {
  constructor(private readonly store: WorkflowStore) {}

  list(query = ''): RegisteredRepository[] {
    return this.store.listRepositories(query);
  }

  async register(input: RegisterRepositoryInput): Promise<RegisteredRepository> {
    const requestedPath = path.resolve(expandHome(input.path));
    const rootResult = await runFile(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: requestedPath, allowFailure: true }
    );
    if (rootResult.exitCode !== 0) {
      throw new Error(`Not a Git repository: ${requestedPath}`);
    }
    const repositoryPath = path.resolve(rootResult.stdout.trim());
    const duplicate = this.store
      .listRepositories()
      .find((repository) => repository.path === repositoryPath);
    if (duplicate) return duplicate;

    const remote = input.remote?.trim() || 'origin';
    const remoteResult = await runFile(
      'git',
      ['remote', 'get-url', remote],
      { cwd: repositoryPath, allowFailure: true }
    );
    const label = input.label?.trim() || path.basename(repositoryPath);
    return this.store.addRepository({
      label,
      role: input.role ?? 'other',
      path: repositoryPath,
      remote,
      checks: input.checks ?? [],
      ...(remoteResult.exitCode === 0
        ? { remoteUrl: remoteResult.stdout.trim() }
        : {}),
      ...(input.runtime ? { runtime: input.runtime } : {}),
      ...(input.release ? { release: input.release } : {}),
    });
  }

  async remove(repositoryId: string): Promise<void> {
    await this.store.removeRepository(repositoryId);
  }
}
