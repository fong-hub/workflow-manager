/** Supported repository roles. Roles affect ordering only through configuration. */
export type RepositoryRole = 'application' | 'service' | 'contract' | 'other';

/** Strategy used to place an accepted commit onto a configured target branch. */
export type ReleaseStrategy = 'fast-forward' | 'merge' | 'cherry-pick';

/** A configured validation command. */
export interface CheckConfig {
  /** Stable check identifier. */
  id: string;
  /** Human-readable check label. */
  label: string;
  /** Trusted local shell command. */
  command: string;
}

/** Runtime commands for one repository. */
export interface RepositoryRuntimeConfig {
  /** Deprecated compatibility field; repository runtimes are now explicitly controlled. */
  primary: boolean;
  /** Directory relative to the selected worktree. */
  workingDirectory: string;
  /** Optional command run before the managed process starts. */
  prepareCommand?: string;
  /** Managed long-running command. Supports ${port} and ${worktree}. */
  startCommand: string;
  /** Optional URL used by the UI to open or probe the runtime. */
  healthCheckUrl?: string;
}

/** Release policy for one repository. */
export interface RepositoryReleaseConfig {
  /** Lower values release first. */
  order: number;
  /** Default remote target branch. */
  defaultTargetBranch: string;
  /** Branches users are allowed to select. */
  allowedTargetBranches: string[];
  /** Integration strategy for temporary release worktrees. */
  strategy: ReleaseStrategy;
}

/** Generic repository configuration. */
export interface RepositoryConfig {
  id: string;
  label: string;
  role: RepositoryRole;
  path: string;
  remote: string;
  release?: RepositoryReleaseConfig;
  runtime?: RepositoryRuntimeConfig;
  checks: CheckConfig[];
}

/** Branch matching rules for grouping worktrees into one workflow. */
export interface MatchingConfig {
  stripBranchPrefixes: string[];
  includeBranchPatterns: string[];
}

/** A logical group of repositories that participate in workflows together. */
export interface WorkspaceConfig {
  id: string;
  label: string;
  matching: MatchingConfig;
  repositories: RepositoryConfig[];
}

/** A repository explicitly registered by the local user. */
export interface RegisteredRepository extends RepositoryConfig {
  /** Optional resolved remote URL for display and search. */
  remoteUrl?: string;
  createdAt: string;
  updatedAt: string;
}

/** A user-managed group that associates registered repositories. */
export interface RepositoryGroup {
  id: string;
  label: string;
  matching: MatchingConfig;
  repositoryIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** External workflow discovery source. */
export interface SourceConfig {
  id: string;
  type: 'codex-sessions';
  enabled: boolean;
  sessionsGlob: string;
}

/** Root service configuration. */
export interface AppConfig {
  version: 1;
  configPath: string;
  server: {
    host: string;
    port: number;
    dataDir: string;
  };
  runtime: {
    portRange: { start: number; end: number };
    stopTimeoutMs: number;
    startupTimeoutMs: number;
  };
  sources: SourceConfig[];
  workspaces: WorkspaceConfig[];
}

/** Git state for one worktree participating in a workflow. */
export interface WorkflowRepository {
  repositoryId: string;
  repositoryLabel: string;
  role: RepositoryRole;
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  headCommit: string;
  detached: boolean;
  prunable: boolean;
  dirty: boolean;
  /** Porcelain paths that currently make the worktree dirty. */
  dirtyFiles: string[];
  upstream?: string;
  ahead: number;
  behind: number;
  release?: RepositoryReleaseConfig;
  runtime?: RepositoryRuntimeConfig;
  checks: CheckConfig[];
}

/** Codex session metadata used as a discovery hint. */
export interface SessionHint {
  id: string;
  cwd: string;
  branch?: string;
  repositoryUrl?: string;
  updatedAt: string;
}

/** Acceptance snapshot pinned to exact repository commits. */
export interface AcceptanceSnapshot {
  acceptedAt: string;
  commits: Record<string, string>;
  note?: string;
}

/** Current managed runtime state. */
export interface RuntimeState {
  status: 'stopped' | 'preparing' | 'starting' | 'running' | 'failed';
  port?: number;
  pid?: number;
  url?: string;
  startedAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  error?: string;
  logFile?: string;
}

/** Aggregated workflow returned to the management UI. */
export interface Workflow {
  id: string;
  key: string;
  title: string;
  workspaceId: string;
  workspaceLabel: string;
  repositories: WorkflowRepository[];
  session?: SessionHint;
  acceptance?: AcceptanceSnapshot;
  acceptanceStale: boolean;
  /** Independently managed runtime state keyed by repository id. */
  runtimes: Record<string, RuntimeState>;
}

/** Result from one release preflight rule. */
export interface PreflightCheck {
  id: string;
  label: string;
  status: 'passed' | 'failed' | 'warning' | 'blocked';
  detail: string;
  repositoryId?: string;
}

/** Configured target for a repository release. */
export interface ReleaseTargetSelection {
  repositoryId: string;
  targetBranch: string;
  /** Optional per-release override; defaults to repository policy. */
  strategy?: ReleaseStrategy;
}
