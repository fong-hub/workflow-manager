import {
  Boxes,
  Check,
  FolderGit2,
  GitBranch,
  LoaderCircle,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type {
  RegisteredRepository,
  RepositoryGroup,
  RepositoryRole,
} from '../../core/types';
import { api } from '../lib/api';

interface RegistryPanelProps {
  onClose: () => void;
  onChanged: () => Promise<void>;
}

export function RegistryPanel({ onClose, onChanged }: RegistryPanelProps) {
  const [tab, setTab] = useState<'repositories' | 'groups'>('repositories');
  const [repositories, setRepositories] = useState<RegisteredRepository[]>([]);
  const [groups, setGroups] = useState<RepositoryGroup[]>([]);
  const [repositoryQuery, setRepositoryQuery] = useState('');
  const [groupRepositoryQuery, setGroupRepositoryQuery] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState<string>();
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [role, setRole] = useState<RepositoryRole>('other');
  const [newGroupLabel, setNewGroupLabel] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const load = async () => {
    const [repositoryResult, groupResult] = await Promise.all([
      api.listRepositories(),
      api.listGroups(),
    ]);
    setRepositories(repositoryResult.repositories);
    setGroups(groupResult.groups);
    setSelectedGroupId((current) =>
      current && groupResult.groups.some((group) => group.id === current)
        ? current
        : groupResult.groups[0]?.id
    );
  };

  useEffect(() => {
    void load().catch((loadError) =>
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    );
  }, []);

  const selectedGroup = groups.find((group) => group.id === selectedGroupId);
  const visibleRepositories = useMemo(() => {
    const normalized = repositoryQuery.trim().toLowerCase();
    if (!normalized) return repositories;
    return repositories.filter((repository) =>
      [repository.label, repository.id, repository.path, repository.remoteUrl ?? '']
        .join('\n')
        .toLowerCase()
        .includes(normalized)
    );
  }, [repositories, repositoryQuery]);
  const associationRepositories = useMemo(() => {
    const normalized = groupRepositoryQuery.trim().toLowerCase();
    if (!normalized) return repositories;
    return repositories.filter((repository) =>
      [repository.label, repository.id, repository.path]
        .join('\n')
        .toLowerCase()
        .includes(normalized)
    );
  }, [groupRepositoryQuery, repositories]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(undefined);
    try {
      await action();
      await load();
      await onChanged();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(undefined);
    }
  };

  const addRepository = async () => {
    if (!path.trim()) return;
    await run('add-repository', async () => {
      await api.addRepository({
        path: path.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
        role,
      });
      setPath('');
      setLabel('');
      setRole('other');
    });
  };

  const addGroup = async () => {
    if (!newGroupLabel.trim()) return;
    await run('add-group', async () => {
      const result = await api.addGroup(newGroupLabel.trim());
      setNewGroupLabel('');
      setSelectedGroupId(result.group.id);
    });
  };

  const toggleRepository = async (repositoryId: string) => {
    if (!selectedGroup) return;
    const associated = selectedGroup.repositoryIds.includes(repositoryId);
    const repositoryIds = associated
      ? selectedGroup.repositoryIds.filter((id) => id !== repositoryId)
      : [...selectedGroup.repositoryIds, repositoryId];
    await run(`associate:${repositoryId}`, async () => {
      await api.updateGroup(selectedGroup.id, { repositoryIds });
    });
  };

  return (
    <div className="registry-backdrop" role="presentation">
      <section className="registry-panel" role="dialog" aria-modal="true" aria-label="仓库注册与分组">
        <header className="registry-header">
          <div>
            <span className="eyebrow">LOCAL REPOSITORY REGISTRY</span>
            <h2>仓库注册与工作流分组</h2>
            <p>仓库由页面维护，通用服务配置不再绑定具体项目路径。</p>
          </div>
          <button className="icon-button" onClick={onClose} type="button" title="关闭">
            <X size={19} />
          </button>
        </header>

        <div className="registry-tabs">
          <button className={tab === 'repositories' ? 'active' : ''} onClick={() => setTab('repositories')} type="button">
            <FolderGit2 size={16} />仓库库 <span>{repositories.length}</span>
          </button>
          <button className={tab === 'groups' ? 'active' : ''} onClick={() => setTab('groups')} type="button">
            <Boxes size={16} />仓库组 <span>{groups.length}</span>
          </button>
        </div>

        {error && <div className="registry-error">{error}</div>}

        {tab === 'repositories' ? (
          <div className="registry-content repositories-view">
            <section className="registry-form">
              <div className="registry-form-title">
                <Plus size={17} />
                <div><strong>添加本地 Git 仓库</strong><span>只验证你手动输入的路径，不扫描整个磁盘。</span></div>
              </div>
              <div className="registry-form-grid">
                <label className="path-field">
                  <span>本地路径</span>
                  <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/absolute/path/to/repository" />
                </label>
                <label>
                  <span>显示名称</span>
                  <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="留空则使用目录名" />
                </label>
                <label>
                  <span>角色</span>
                  <select value={role} onChange={(event) => setRole(event.target.value as RepositoryRole)}>
                    <option value="other">Other</option>
                    <option value="application">Application</option>
                    <option value="service">Service</option>
                    <option value="contract">Contract</option>
                  </select>
                </label>
                <button className="primary-action" disabled={!path.trim() || Boolean(busy)} onClick={addRepository} type="button">
                  {busy === 'add-repository' ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
                  验证并添加
                </button>
              </div>
            </section>

            <div className="registry-search">
              <Search size={16} />
              <input value={repositoryQuery} onChange={(event) => setRepositoryQuery(event.target.value)} placeholder="搜索名称、路径、ID 或 remote…" />
            </div>

            <div className="registered-repository-list">
              {visibleRepositories.map((repository) => {
                const relatedGroups = groups.filter((group) => group.repositoryIds.includes(repository.id));
                return (
                  <article className="registered-repository" key={repository.id}>
                    <div className="registered-repository-icon"><FolderGit2 size={18} /></div>
                    <div className="registered-repository-main">
                      <div><strong>{repository.label}</strong><span className="role-tag">{repository.role}</span></div>
                      <code>{repository.path}</code>
                      <span>{repository.remoteUrl ?? `remote: ${repository.remote}`}</span>
                      <div className="group-badges">
                        {relatedGroups.length > 0
                          ? relatedGroups.map((group) => <span key={group.id}>{group.label}</span>)
                          : <em>尚未关联仓库组</em>}
                      </div>
                    </div>
                    <button
                      className="danger-icon"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        if (!window.confirm(`确认移除仓库“${repository.label}”？不会删除本地代码。`)) return;
                        void run(`remove:${repository.id}`, () => api.removeRepository(repository.id));
                      }}
                      type="button"
                      title="从 Registry 移除"
                    >
                      {busy === `remove:${repository.id}` ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
                    </button>
                  </article>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="registry-content groups-view">
            <aside className="group-sidebar">
              <div className="create-group">
                <input value={newGroupLabel} onChange={(event) => setNewGroupLabel(event.target.value)} placeholder="新仓库组名称" />
                <button disabled={!newGroupLabel.trim() || Boolean(busy)} onClick={addGroup} type="button">
                  {busy === 'add-group' ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}
                </button>
              </div>
              <div className="group-list">
                {groups.map((group) => (
                  <button className={selectedGroupId === group.id ? 'active' : ''} onClick={() => setSelectedGroupId(group.id)} key={group.id} type="button">
                    <Boxes size={15} /><span><strong>{group.label}</strong><small>{group.repositoryIds.length} repositories</small></span>
                  </button>
                ))}
              </div>
            </aside>

            <section className="group-association">
              {selectedGroup ? (
                <>
                  <div className="group-association-head">
                    <div><span className="eyebrow">REPOSITORY GROUP</span><h3>{selectedGroup.label}</h3><code>{selectedGroup.id}</code></div>
                    <button
                      className="danger-icon"
                      onClick={() => {
                        if (!window.confirm(`确认删除仓库组“${selectedGroup.label}”？仓库本身不会删除。`)) return;
                        void run(`remove-group:${selectedGroup.id}`, () => api.removeGroup(selectedGroup.id));
                      }}
                      type="button"
                      title="删除仓库组"
                    ><Trash2 size={15} /></button>
                  </div>
                  <div className="registry-search">
                    <Search size={16} />
                    <input value={groupRepositoryQuery} onChange={(event) => setGroupRepositoryQuery(event.target.value)} placeholder="搜索并关联已注册仓库…" />
                  </div>
                  <div className="association-list">
                    {associationRepositories.map((repository) => {
                      const checked = selectedGroup.repositoryIds.includes(repository.id);
                      return (
                        <button
                          className={checked ? 'associated' : ''}
                          disabled={Boolean(busy)}
                          onClick={() => toggleRepository(repository.id)}
                          key={repository.id}
                          type="button"
                        >
                          <span className="association-check">{checked && <Check size={14} />}</span>
                          <FolderGit2 size={17} />
                          <span><strong>{repository.label}</strong><code>{repository.path}</code></span>
                          <em>{checked ? '已关联' : '点击关联'}</em>
                        </button>
                      );
                    })}
                  </div>
                  <div className="matching-summary">
                    <GitBranch size={15} />
                    <span>分支前缀：{selectedGroup.matching.stripBranchPrefixes.join(' · ') || '不处理'}</span>
                  </div>
                </>
              ) : (
                <div className="registry-empty"><Boxes size={28} /><strong>创建第一个仓库组</strong><span>仓库必须关联到组后才会参与工作流扫描。</span></div>
              )}
            </section>
          </div>
        )}
      </section>
    </div>
  );
}
