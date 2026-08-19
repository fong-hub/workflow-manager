# Workflow Foundry

一个独立、通用、配置驱动的本地研发工作流管理服务。它扫描多个 Git 仓库的 worktree，将同一功能分支归组为工作流，为每个工作流启动独立验收环境，并以精确 Commit 快照编排多仓库发布。

## 核心规则

- 核心代码不认识任何具体业务、仓库名称或目标分支。
- 仓库、分支匹配、运行命令、端口池、检查命令、发布顺序全部来自 YAML。
- 验收绑定每个仓库的精确 Commit SHA；HEAD 变化后验收自动失效。
- 发布使用临时 release worktree，不修改用户本地主分支。
- Git push 永不使用 force；发布必须先通过预检并由用户二次确认。
- Codex 会话仅读取首行元数据，不读取会话正文。

## 快速开始

```bash
corepack pnpm install --frozen-lockfile
cp config/workflow-manager.example.yaml workflow-manager.local.yaml
# 编辑本机仓库路径和命令
corepack pnpm dev
```

打开：`http://127.0.0.1:4173`

服务 API：`http://127.0.0.1:4310`

也可以指定配置文件：

```bash
WORKFLOW_MANAGER_CONFIG=/absolute/path/config.yaml corepack pnpm dev
```

## 配置模型

- YAML 只配置服务、数据目录、端口池和可选会话来源。
- 本地 Git 仓库由页面手动注册，不扫描整个磁盘。
- 仓库组由页面创建，并通过搜索关联已注册仓库。
- 分支归组规则保存在仓库组 Registry 中。
- `runtime`：仓库级独立端口、准备命令、启动命令和访问 URL；未配置时该仓库仅参与代码、验收和发布。
- `release`：发布顺序、目标分支白名单和 Git 集成策略。
- `sources`：可选的会话发现来源。目前支持 Codex session metadata。

命令字符串是本机可信配置，会由本地 shell 执行。不要加载来源不可信的配置文件。



## 仓库注册与分组

仓库不再写入 YAML。打开页面右上角“仓库注册与分组”：

1. 输入本地 Git 仓库绝对路径并添加；服务只验证该路径，不扫描整个磁盘。
2. 使用名称、路径、ID 或 remote 搜索已注册仓库。
3. 创建仓库组，在组内搜索仓库并点击关联或解除关联。
4. 只有已经关联到仓库组的仓库才参与 worktree 扫描和工作流归组。

注册表保存在 `~/.workflow-manager/state.json`。删除 Registry 记录不会删除本地代码仓库。

## 仓库级选择性运行

同一个工作流中的仓库只共享分支归组、验收快照和发布计划，不会自动一起启动：

- 仓库配置了 `runtime`：页面提供该仓库独立的启动、停止、打开和日志操作。
- 仓库没有配置 `runtime`：页面标记为“仅代码”，不会被其他仓库的启动动作带起。
- 启动一个仓库只分配该仓库自己的端口、PID 和日志，不隐式启动同工作流中的其他仓库。

这允许前端 worktree 单独运行并继续访问 SIT 后端，而后端和契约仓库只保留代码改动。

## API

- `GET /api/workflows`
- `POST /api/workflows/:id/repositories/:repositoryId/runtime/start`
- `POST /api/workflows/:id/repositories/:repositoryId/runtime/stop`
- `GET /api/workflows/:id/repositories/:repositoryId/runtime/log`
- `POST /api/workflows/:id/accept`
- `POST /api/workflows/:id/release/preflight`
- `POST /api/workflows/:id/release`

## 当前限制

- 运行进程登记目前保存在服务内存中；服务重启后会重新扫描端口，但不会接管旧进程。
- 跨仓库发布不具备原子性；前序仓库成功、后序仓库失败时会返回部分发布结果。
- 自动会话关联只是提示。会话从主工作区启动、随后才创建 worktree 时，应该以后续显式绑定能力作为最终事实来源。

## 独立 worktree 发布规则

- 发布只能基于验收快照中的精确 Commit；未提交文件不会被发布。
- 没有验收快照或验收后 HEAD 变化时，依赖验收 Commit 的预检项显示为“阻塞”，不会伪装成已执行。
- `fast-forward` 仅适合目标分支是验收 Commit 祖先的线性分支。
- 独立 worktree 向持续前进的 SIT 分支发布，默认推荐 `cherry-pick`：服务从最新目标分支创建临时 release worktree，再顺序 cherry-pick 目标分支尚未包含的验收 Commit。
- `merge` 用于明确需要保留合并关系的场景。
- 目标分支已包含验收 Commit 时，预检会提示没有独有 Commit，避免把“无需发布”误判为 fast-forward 失败。
# workflow-manager
