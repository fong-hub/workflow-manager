import type {
  PreflightCheck,
  RegisteredRepository,
  ReleaseTargetSelection,
  RepositoryGroup,
  Workflow,
} from '../../core/types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed: ${response.status}`);
  return payload;
}

export const api = {
  listRepositories: (query = '') =>
    request<{ repositories: RegisteredRepository[] }>(
      `/api/repositories${query ? `?q=${encodeURIComponent(query)}` : ''}`
    ),
  addRepository: (input: {
    path: string;
    label?: string;
    role?: RegisteredRepository['role'];
  }) =>
    request<{ repository: RegisteredRepository }>('/api/repositories', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  removeRepository: (repositoryId: string) =>
    request<void>(`/api/repositories/${encodeURIComponent(repositoryId)}`, {
      method: 'DELETE',
    }),
  listGroups: () => request<{ groups: RepositoryGroup[] }>('/api/groups'),
  addGroup: (label: string) =>
    request<{ group: RepositoryGroup }>('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),
  updateGroup: (groupId: string, patch: Partial<Pick<RepositoryGroup, 'label' | 'repositoryIds' | 'matching'>>) =>
    request<{ group: RepositoryGroup }>(`/api/groups/${encodeURIComponent(groupId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  removeGroup: (groupId: string) =>
    request<void>(`/api/groups/${encodeURIComponent(groupId)}`, {
      method: 'DELETE',
    }),
  listWorkflows: (force = false) =>
    request<{ workflows: Workflow[] }>(`/api/workflows${force ? '?refresh=true' : ''}`),
  startRuntime: (workflowId: string, repositoryId: string) =>
    request(
      `/api/workflows/${encodeURIComponent(workflowId)}/repositories/${encodeURIComponent(repositoryId)}/runtime/start`,
      { method: 'POST' }
    ),
  stopRuntime: (workflowId: string, repositoryId: string) =>
    request(
      `/api/workflows/${encodeURIComponent(workflowId)}/repositories/${encodeURIComponent(repositoryId)}/runtime/stop`,
      { method: 'POST' }
    ),
  readLog: (workflowId: string, repositoryId: string) =>
    request<{ log: string }>(
      `/api/workflows/${encodeURIComponent(workflowId)}/repositories/${encodeURIComponent(repositoryId)}/runtime/log`
    ),
  accept: (workflowId: string, note: string) =>
    request<{ workflow: Workflow }>(
      `/api/workflows/${encodeURIComponent(workflowId)}/accept`,
      { method: 'POST', body: JSON.stringify({ note }) }
    ),
  rename: (workflowId: string, title: string) =>
    request<{ workflow: Workflow }>(
      `/api/workflows/${encodeURIComponent(workflowId)}`,
      { method: 'PATCH', body: JSON.stringify({ title }) }
    ),
  preflight: (workflowId: string, targets: ReleaseTargetSelection[]) =>
    request<{ checks: PreflightCheck[] }>(
      `/api/workflows/${encodeURIComponent(workflowId)}/release/preflight`,
      { method: 'POST', body: JSON.stringify({ targets }) }
    ),
  release: (workflowId: string, targets: ReleaseTargetSelection[]) =>
    request<{ result: unknown }>(
      `/api/workflows/${encodeURIComponent(workflowId)}/release`,
      { method: 'POST', body: JSON.stringify({ targets, confirmed: true }) }
    ),
};
