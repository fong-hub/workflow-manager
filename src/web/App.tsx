import {
  Activity,
  ArrowUpRight,
  Box,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Code2,
  GitBranch,
  LoaderCircle,
  PanelRightClose,
  Play,
  RefreshCw,
  Rocket,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  PreflightCheck,
  ReleaseStrategy,
  ReleaseTargetSelection,
  Workflow,
} from '../core/types';
import { RegistryPanel } from './components/RegistryPanel';
import { api } from './lib/api';

type ViewFilter = 'all' | 'running' | 'pending' | 'accepted' | 'stale';

function shortSha(commit: string): string {
  return commit.slice(0, 8);
}

function aggregateRuntimeStatus(workflow: Workflow) {
  const states = Object.values(workflow.runtimes);
  if (states.some((runtime) => runtime.status === 'running')) return 'running';
  if (states.some((runtime) => runtime.status === 'preparing')) return 'preparing';
  if (states.some((runtime) => runtime.status === 'starting')) return 'starting';
  if (states.some((runtime) => runtime.status === 'failed')) return 'failed';
  return 'stopped';
}

function runtimeLabel(workflow: Workflow): string {
  const status = aggregateRuntimeStatus(workflow);
  const runningCount = Object.values(workflow.runtimes).filter(
    (runtime) => runtime.status === 'running'
  ).length;
  if (status === 'running') return `${runningCount} 个仓库运行中`;
  if (status === 'preparing') return '准备环境';
  if (status === 'starting') return '启动中';
  if (status === 'failed') return '启动失败';
  if (workflow.acceptanceStale) return '代码已变化';
  if (workflow.acceptance) return '已验收';
  return Object.keys(workflow.runtimes).length > 0 ? '可选择启动' : '仅代码工作流';
}

function workflowTone(workflow: Workflow): string {
  const status = aggregateRuntimeStatus(workflow);
  if (status === 'running') return 'running';
  if (status === 'failed' || workflow.acceptanceStale) return 'danger';
  if (workflow.acceptance) return 'accepted';
  return 'idle';
}

function RepositoryPill({ workflow }: { workflow: Workflow }) {
  return (
    <div className="repo-strip">
      {workflow.repositories.map((repository) => (
        <div className="repo-pill" key={`${repository.repositoryId}:${repository.worktreePath}`}>
          <span className={`repo-dot ${repository.dirty ? 'dirty' : 'clean'}`} />
          <span>{repository.repositoryLabel}</span>
          <code>{shortSha(repository.headCommit)}</code>
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`metric ${accent ? 'metric-accent' : ''}`}>
      <span>{label}</span>
      <strong>{String(value).padStart(2, '0')}</strong>
    </div>
  );
}

function WorkflowCard({
  workflow,
  selected,
  onSelect,
}: {
  workflow: Workflow;
  selected: boolean;
  onSelect: () => void;
}) {
  const tone = workflowTone(workflow);
  return (
    <button
      className={`workflow-card ${selected ? 'selected' : ''}`}
      onClick={onSelect}
      type="button"
    >
      <div className="card-rail">
        <span className={`status-beacon ${tone}`} />
        <span className="rail-line" />
        <span className="repo-count">{workflow.repositories.length}</span>
      </div>
      <div className="card-content">
        <div className="card-topline">
          <span className={`status-label ${tone}`}>{runtimeLabel(workflow)}</span>
          <span className="workspace-label">{workflow.workspaceLabel}</span>
        </div>
        <h3>{workflow.title}</h3>
        <div className="branch-line">
          <GitBranch size={14} />
          <code>{workflow.key}</code>
        </div>
        <RepositoryPill workflow={workflow} />
        <div className="card-footer">
          <span>
            {workflow.session ? `会话 ${workflow.session.id.slice(0, 8)}` : '未关联会话'}
          </span>
          {Object.values(workflow.runtimes).some((runtime) => runtime.status === 'running') ? (
            <span className="runtime-port">
              {Object.values(workflow.runtimes).filter((runtime) => runtime.status === 'running').length} RUNNING
            </span>
          ) : (
            <span>{workflow.repositories.some((repo) => repo.dirty) ? '有未提交变更' : '工作区干净'}</span>
          )}
          <ChevronRight size={16} />
        </div>
      </div>
    </button>
  );
}

function CheckRow({ check }: { check: PreflightCheck }) {
  const Icon = check.status === 'passed'
    ? CheckCircle2
    : check.status === 'warning' || check.status === 'blocked'
      ? CircleAlert
      : XCircle;
  return (
    <div className={`check-row ${check.status}`}>
      <Icon size={17} />
      <div>
        <strong>{check.label}</strong>
        <span>{check.detail}</span>
      </div>
    </div>
  );
}

function DetailPanel({
  workflow,
  onClose,
  onRefresh,
}: {
  workflow: Workflow;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<'overview' | 'runtime' | 'release'>('overview');
  const [busy, setBusy] = useState<string>();
  const [log, setLog] = useState('');
  const [logRepositoryId, setLogRepositoryId] = useState<string>();
  const [note, setNote] = useState('');
  const [preflight, setPreflight] = useState<PreflightCheck[]>([]);
  const [error, setError] = useState<string>();
  const [runtimePorts, setRuntimePorts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      workflow.repositories
        .filter((repository) => repository.runtime)
        .map((repository) => [
          repository.repositoryId,
          workflow.runtimes[repository.repositoryId]?.port?.toString() ?? '',
        ])
    )
  );
  const runtimePortsWorkflowId = useRef(workflow.id);
  const [targets, setTargets] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      workflow.repositories
        .filter((repository) => repository.release)
        .map((repository) => [
          repository.repositoryId,
          repository.release!.defaultTargetBranch,
        ])
    )
  );
  const [strategies, setStrategies] = useState<Record<string, ReleaseStrategy>>(() =>
    Object.fromEntries(
      workflow.repositories
        .filter((repository) => repository.release)
        .map((repository) => [
          repository.repositoryId,
          repository.release!.strategy,
        ])
    )
  );

  useEffect(() => {
    setPreflight([]);
    setError(undefined);
    setRuntimePorts((current) => {
      const workflowChanged = runtimePortsWorkflowId.current !== workflow.id;
      runtimePortsWorkflowId.current = workflow.id;
      return Object.fromEntries(
        workflow.repositories
          .filter((repository) => repository.runtime)
          .map((repository) => [
            repository.repositoryId,
            workflowChanged
              ? workflow.runtimes[repository.repositoryId]?.port?.toString() ?? ''
              : current[repository.repositoryId] ?? '',
          ])
      );
    });
    setTargets(
      Object.fromEntries(
        workflow.repositories
          .filter((repository) => repository.release)
          .map((repository) => [
            repository.repositoryId,
            repository.release!.defaultTargetBranch,
          ])
      )
    );
    setStrategies(
      Object.fromEntries(
        workflow.repositories
          .filter((repository) => repository.release)
          .map((repository) => [
            repository.repositoryId,
            repository.release!.strategy,
          ])
      )
    );
  }, [workflow.id, workflow.repositories, workflow.runtimes]);


  const selectedTargets = useMemo<ReleaseTargetSelection[]>(
    () => Object.entries(targets).map(([repositoryId, targetBranch]) => ({
      repositoryId,
      targetBranch,
      ...(strategies[repositoryId]
        ? { strategy: strategies[repositoryId] }
        : {}),
    })),
    [strategies, targets]
  );

  const runAction = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setError(undefined);
    try {
      await action();
      await onRefresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(undefined);
    }
  };

  const refreshLog = async (repositoryId: string) => {
    const busyKey = `log:${repositoryId}`;
    setBusy(busyKey);
    setLogRepositoryId(repositoryId);
    try {
      const result = await api.readLog(workflow.id, repositoryId);
      setLog(result.log || '暂无日志。');
    } finally {
      setBusy(undefined);
    }
  };

  const doPreflight = async () => {
    setBusy('preflight');
    setError(undefined);
    try {
      const result = await api.preflight(workflow.id, selectedTargets);
      setPreflight(result.checks);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(undefined);
    }
  };

  const doRelease = async () => {
    if (!window.confirm('确认将已验收的精确 Commit 推送到所选目标分支？该操作会写入远端仓库。')) return;
    await runAction('release', () => api.release(workflow.id, selectedTargets));
  };

  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <div>
          <span className="eyebrow">WORKFLOW / {workflow.workspaceId}</span>
          <h2>{workflow.title}</h2>
          <code>{workflow.key}</code>
        </div>
        <button className="icon-button" onClick={onClose} title="关闭" type="button">
          <PanelRightClose size={19} />
        </button>
      </div>

      <div className="detail-tabs">
        <button className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>概览</button>
        <button className={activeTab === 'runtime' ? 'active' : ''} onClick={() => setActiveTab('runtime')}>验收环境</button>
        <button className={activeTab === 'release' ? 'active' : ''} onClick={() => setActiveTab('release')}>发布计划</button>
      </div>

      {error && (
        <div className="error-banner"><CircleAlert size={17} /><span>{error}</span><button onClick={() => setError(undefined)}><X size={14} /></button></div>
      )}

      <div className="detail-scroll">
        {activeTab === 'overview' && (
          <>
            <section className="panel-section status-overview">
              <div>
                <span>当前状态</span>
                <strong>{runtimeLabel(workflow)}</strong>
              </div>
              <div>
                <span>验收快照</span>
                <strong>{workflow.acceptance ? new Date(workflow.acceptance.acceptedAt).toLocaleString() : '尚未验收'}</strong>
              </div>
              <div>
                <span>会话关联</span>
                <strong>{workflow.session?.id.slice(0, 13) ?? '未关联'}</strong>
              </div>
            </section>

            <section className="panel-section">
              <div className="section-title"><Box size={17} /><h3>仓库矩阵</h3></div>
              <div className="repository-list">
                {workflow.repositories.map((repository) => (
                  <div className="repository-row" key={`${repository.repositoryId}:${repository.worktreePath}`}>
                    <div className="repo-icon"><Code2 size={17} /></div>
                    <div className="repo-main">
                      <strong>{repository.repositoryLabel}</strong>
                      <code>{repository.branch}</code>
                      <span title={repository.worktreePath}>{repository.worktreePath}</span>
                    </div>
                    <div className="repo-state">
                      <code>{shortSha(repository.headCommit)}</code>
                      <span className={repository.dirty ? 'tag danger' : 'tag clean'}>
                        {repository.dirty ? 'DIRTY' : 'CLEAN'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel-section acceptance-block">
              <div className="section-title"><ShieldCheck size={17} /><h3>验收闸门</h3></div>
              {workflow.acceptanceStale && (
                <div className="stale-warning">验收后分支 HEAD 已变化，旧验收快照自动失效。</div>
              )}
              <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="验收备注（可选）" />
              <button
                className="primary-action"
                disabled={Boolean(busy) || workflow.repositories.some((repository) => repository.dirty)}
                onClick={() => runAction('accept', () => api.accept(workflow.id, note))}
                type="button"
              >
                {busy === 'accept' ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
                将当前所有 Commit 标记为验收通过
              </button>
            </section>
          </>
        )}

        {activeTab === 'runtime' && (
          <>
            <section className="runtime-policy">
              <Server size={20} />
              <div>
                <strong>仓库级独立运行</strong>
                <span>只启动你选择的仓库；同一工作流中的其他仓库不会被隐式启动。</span>
              </div>
            </section>
            <div className="repository-runtime-list">
              {workflow.repositories.map((repository) => {
                const runtime = workflow.runtimes[repository.repositoryId] ?? { status: 'stopped' as const };
                const startBusy = busy === `start:${repository.repositoryId}`;
                const stopBusy = busy === `stop:${repository.repositoryId}`;
                const logBusy = busy === `log:${repository.repositoryId}`;
                if (!repository.runtime) {
                  return (
                    <section className="repository-runtime code-only" key={repository.repositoryId}>
                      <div className="repository-runtime-head">
                        <div className="repo-icon"><Code2 size={17} /></div>
                        <div>
                          <strong>{repository.repositoryLabel}</strong>
                          <code>{repository.branch}</code>
                        </div>
                        <span className="code-only-tag">仅代码</span>
                      </div>
                      <p>该仓库未配置 Runtime，不会因为其他仓库启动而自动运行。</p>
                    </section>
                  );
                }
                return (
                  <section className="repository-runtime" key={repository.repositoryId}>
                    <div className="repository-runtime-head">
                      <div className={`runtime-orb small ${runtime.status}`}><Server size={18} /></div>
                      <div>
                        <strong>{repository.repositoryLabel}</strong>
                        <code>{repository.branch}</code>
                      </div>
                      <span className={`runtime-state ${runtime.status}`}>{runtime.status}</span>
                    </div>
                    <div className="repository-runtime-meta">
                      <span className={runtime.error ? 'runtime-error' : ''}>
                        {runtime.error ?? runtime.url ?? '启动后自动分配独立端口'}
                      </span>
                      <code>{runtime.pid ? `PID ${runtime.pid}` : 'STOPPED'}</code>
                    </div>
                    <label className="runtime-port-field">
                      <span>运行端口</span>
                      <input
                        disabled={Boolean(busy) || ['running', 'preparing', 'starting'].includes(runtime.status)}
                        inputMode="numeric"
                        max={65535}
                        min={1}
                        onChange={(event) => setRuntimePorts((current) => ({
                          ...current,
                          [repository.repositoryId]: event.target.value,
                        }))}
                        placeholder="留空则自动分配"
                        type="number"
                        value={runtimePorts[repository.repositoryId] ?? ''}
                      />
                      <small>启动前校验占用；留空时从配置端口池自动选择。</small>
                    </label>
                    <div className="repository-runtime-actions">
                      <button
                        className="primary-action"
                        disabled={Boolean(busy) || ['running', 'preparing', 'starting'].includes(runtime.status)}
                        onClick={() => {
                          const value = runtimePorts[repository.repositoryId]?.trim() ?? '';
                          const port = value ? Number(value) : undefined;
                          if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
                            setError('运行端口必须是 1 到 65535 之间的整数。');
                            return;
                          }
                          void runAction(
                            `start:${repository.repositoryId}`,
                            () => api.startRuntime(workflow.id, repository.repositoryId, port)
                          );
                        }}
                        type="button"
                      >
                        {startBusy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
                        启动此仓库
                      </button>
                      <button
                        className="secondary-action"
                        disabled={Boolean(busy) || runtime.status === 'stopped'}
                        onClick={() => runAction(`stop:${repository.repositoryId}`, () => api.stopRuntime(workflow.id, repository.repositoryId))}
                        type="button"
                      >
                        {stopBusy ? <LoaderCircle className="spin" size={16} /> : <CircleStop size={16} />}
                        停止
                      </button>
                      {runtime.url && (
                        <a className="secondary-action" href={runtime.url} target="_blank" rel="noreferrer">
                          <ArrowUpRight size={16} />打开
                        </a>
                      )}
                      <button
                        className="secondary-action"
                        disabled={Boolean(busy)}
                        onClick={() => refreshLog(repository.repositoryId)}
                        type="button"
                      >
                        <RefreshCw className={logBusy ? 'spin' : ''} size={16} />日志
                      </button>
                    </div>
                  </section>
                );
              })}
            </div>
            {logRepositoryId && (
              <section className="panel-section log-section">
                <div className="section-title log-title">
                  <div><SquareTerminal size={17} /><h3>{logRepositoryId} 运行日志</h3></div>
                  <button onClick={() => refreshLog(logRepositoryId)} disabled={busy === `log:${logRepositoryId}`}>
                    <RefreshCw className={busy === `log:${logRepositoryId}` ? 'spin' : ''} size={15} />刷新
                  </button>
                </div>
                <pre>{log || '暂无日志。'}</pre>
              </section>
            )}
          </>
        )}

        {activeTab === 'release' && (
          <>
            {(!workflow.acceptance || workflow.acceptanceStale || workflow.repositories.some((repository) => repository.dirty)) && (
              <section className="release-blocker-summary">
                <CircleAlert size={18} />
                <div>
                  <strong>当前还不能发布</strong>
                  <span>
                    {!workflow.acceptance
                      ? '请先提交全部改动，并在概览中将当前 Commit 标记为验收通过。'
                      : workflow.acceptanceStale
                        ? '验收后仓库 HEAD 已变化，需要重新验收。'
                        : '存在未提交文件，发布只能基于已提交的精确 Commit。'}
                  </span>
                </div>
                <button onClick={() => setActiveTab('overview')} type="button">前往概览</button>
              </section>
            )}
            <section className="release-sequence">
              <span className="eyebrow">CONFIGURED RELEASE SEQUENCE</span>
              {workflow.repositories
                .filter((repository) => repository.release)
                .sort((a, b) => a.release!.order - b.release!.order)
                .map((repository, index, array) => (
                  <div className="release-node" key={repository.repositoryId}>
                    <span className="sequence-number">{String(index + 1).padStart(2, '0')}</span>
                    <div>
                      <strong>{repository.repositoryLabel}</strong>
                      <code>{shortSha(repository.headCommit)}</code>
                    </div>
                    <div className="release-selectors">
                      <select
                        value={targets[repository.repositoryId]}
                        onChange={(event) => {
                          setPreflight([]);
                          setTargets((current) => ({ ...current, [repository.repositoryId]: event.target.value }));
                        }}
                      >
                        {repository.release!.allowedTargetBranches.map((branch) => <option key={branch}>{branch}</option>)}
                      </select>
                      <select
                        value={strategies[repository.repositoryId]}
                        onChange={(event) => {
                          setPreflight([]);
                          setStrategies((current) => ({
                            ...current,
                            [repository.repositoryId]: event.target.value as ReleaseStrategy,
                          }));
                        }}
                      >
                        <option value="cherry-pick">cherry-pick</option>
                        <option value="fast-forward">fast-forward</option>
                        <option value="merge">merge</option>
                      </select>
                    </div>
                    {index < array.length - 1 && <span className="sequence-line" />}
                  </div>
                ))}
            </section>
            <div className="action-grid release-actions">
              <button className="secondary-action" disabled={Boolean(busy)} onClick={doPreflight} type="button">
                {busy === 'preflight' ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}
                运行发布预检
              </button>
              <button
                className="danger-action"
                disabled={Boolean(busy) || preflight.length === 0 || preflight.some((check) => check.status === 'failed' || check.status === 'blocked')}
                onClick={doRelease}
                type="button"
              >
                {busy === 'release' ? <LoaderCircle className="spin" size={17} /> : <Rocket size={17} />}
                推送已验收代码
              </button>
            </div>
            {preflight.length > 0 && (
              <section className="panel-section check-list">
                <div className="section-title"><ShieldCheck size={17} /><h3>预检结果</h3></div>
                {preflight.map((check) => <CheckRow check={check} key={check.id} />)}
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

export function App() {
  const [update, setUpdate] = useState<{ version: string; install: () => Promise<void> }>();
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [filter, setFilter] = useState<ViewFilter>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [registryOpen, setRegistryOpen] = useState(false);
  const refreshing = useRef(false);

  const refresh = useCallback(async (force = false) => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const result = await api.listWorkflows(force);
      setWorkflows(result.workflows);
      setError(undefined);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      refreshing.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    void import('@tauri-apps/plugin-updater').then(async ({ check }) => {
      const available = await check();
      if (!available) return;
      setUpdate({
        version: available.version,
        install: async () => {
          await available.downloadAndInstall();
          const { relaunch } = await import('@tauri-apps/plugin-process');
          await relaunch();
        },
      });
    }).catch(() => undefined);
  }, []);

  const selected = workflows.find((workflow) => workflow.id === selectedId);
  const counts = useMemo(
    () => ({
      running: workflows.filter((workflow) => Object.values(workflow.runtimes).some((runtime) => runtime.status === 'running')).length,
      pending: workflows.filter((workflow) => !workflow.acceptance && !workflow.acceptanceStale).length,
      accepted: workflows.filter((workflow) => workflow.acceptance && !workflow.acceptanceStale).length,
      stale: workflows.filter((workflow) => workflow.acceptanceStale).length,
    }),
    [workflows]
  );

  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return workflows.filter((workflow) => {
      const queryMatched =
        !normalizedQuery ||
        workflow.title.toLowerCase().includes(normalizedQuery) ||
        workflow.key.toLowerCase().includes(normalizedQuery) ||
        workflow.repositories.some((repository) => repository.branch.toLowerCase().includes(normalizedQuery));
      if (!queryMatched) return false;
      if (filter === 'running') return Object.values(workflow.runtimes).some((runtime) => runtime.status === 'running');
      if (filter === 'pending') return !workflow.acceptance;
      if (filter === 'accepted') return Boolean(workflow.acceptance && !workflow.acceptanceStale);
      if (filter === 'stale') return workflow.acceptanceStale;
      return true;
    });
  }, [filter, query, workflows]);

  return (
    <main className="app-shell">
      {update && <div className="update-banner"><span>新版本 {update.version} 已发布</span><button disabled={installingUpdate} onClick={() => { setInstallingUpdate(true); void update.install(); }} type="button">{installingUpdate ? '正在安装…' : '立即升级'}</button></div>}
      <div className="grain" />
      <header className="topbar">
        <div className="brand-mark"><span>WF</span></div>
        <div className="brand-copy">
          <span>LOCAL DELIVERY CONTROL</span>
          <strong>Workflow Foundry</strong>
        </div>
        <div className="topbar-spacer" />
        <div className="service-indicator"><span /><div><strong>服务在线</strong><small>127.0.0.1:4310</small></div></div>
        <button className="icon-button" title="仓库注册与分组" type="button" onClick={() => setRegistryOpen(true)}><Settings2 size={19} /></button>
      </header>

      <section className="dashboard-head">
        <div>
          <span className="eyebrow">WORKTREE OPERATIONS / LIVE INDEX</span>
          <h1>把每次修改，变成一条可验收的生产线。</h1>
          <p>会话、仓库、独立运行环境和多仓库发布，由本地 Registry 与通用规则驱动。</p>
        </div>
        <div className="metrics">
          <Metric label="全部工作流" value={workflows.length} />
          <Metric label="运行中" value={counts.running} accent />
          <Metric label="待验收" value={counts.pending} />
          <Metric label="验收有效" value={counts.accepted} />
        </div>
      </section>

      <section className="control-bar">
        <div className="search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索分支、工作流或仓库…" /></div>
        <div className="filters">
          {([
            ['all', '全部'],
            ['running', '运行中'],
            ['pending', '待验收'],
            ['accepted', '已通过'],
            ['stale', `已变化 ${counts.stale || ''}`],
          ] as Array<[ViewFilter, string]>).map(([value, label]) => (
            <button className={filter === value ? 'active' : ''} key={value} onClick={() => setFilter(value)} type="button">{label}</button>
          ))}
        </div>
        <button className="scan-button" onClick={() => void refresh(true)} disabled={loading} type="button"><RefreshCw className={loading ? 'spin' : ''} size={16} />扫描工作流</button>
      </section>

      {error && <div className="page-error"><CircleAlert size={18} />{error}</div>}

      <section className={`workspace ${selected ? 'with-detail' : ''}`}>
        <div className="workflow-grid">
          {loading && workflows.length === 0 ? (
            <div className="empty-state"><LoaderCircle className="spin" size={28} /><strong>正在扫描 Git worktree</strong><span>读取配置中的仓库和会话元数据…</span></div>
          ) : visible.length === 0 ? (
            <div className="empty-state"><Activity size={28} /><strong>没有匹配的工作流</strong><span>调整过滤条件或检查配置中的分支匹配规则。</span></div>
          ) : (
            visible.map((workflow) => (
              <WorkflowCard key={workflow.id} workflow={workflow} selected={selectedId === workflow.id} onSelect={() => setSelectedId(workflow.id)} />
            ))
          )}
        </div>
        {selected && <DetailPanel workflow={selected} onClose={() => setSelectedId(undefined)} onRefresh={refresh} />}
      </section>

      <footer className="footer-line"><span><Activity size={13} />自动刷新 15s</span><span>Registry 驱动 · 非强制推送 · Commit 级验收</span></footer>
      {registryOpen && (
        <RegistryPanel
          onClose={() => setRegistryOpen(false)}
          onChanged={() => refresh(true)}
        />
      )}
    </main>
  );
}
