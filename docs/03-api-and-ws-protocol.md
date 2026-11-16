# 03 HTTP API、WebSocket 协议与通知队列契约

本文档定义 `agent-hub` 控制面（默认入口 `https://ahub.bobocai.win`）对外暴露的全部 REST 接口、Durable Object `NodeHub` 的双向 WebSocket 帧格式、Cloudflare Queues 通知载荷以及标准错误码。机器可读 Schema 见 [run-create.schema.json](schemas/run-create.schema.json)、[run-record.schema.json](schemas/run-record.schema.json) 与 [ws-frames.schema.json](schemas/ws-frames.schema.json)。

## 1. 通用协议约定

### 1.1 认证方式

| 入口范围 | 认证头 / 凭证 | 说明 |
| --- | --- | --- |
| Web 浏览器控制台与管理接口 | `Cf-Access-Jwt-Assertion` 请求头、同源 `Cookie: CF_Authorization` 或 `Authorization: Bearer ahub_adm_<secret>` | 生产环境由 Cloudflare Access 拦截验证并注入 JWT；单域名部署下 `/api/*` 与 `/ws/*` 对机器路径配置 `Bypass` 后，浏览器同源携 `CF_Authorization` Cookie 发起请求，Worker 强制校验同源 `Origin` / `Sec-Fetch-Site` 并对 JWT 执行 RS256 JWKS、`exp` 与 `CF_ACCESS_AUD` 验签；本地联调可开启 `admin` Token 回退 |
| 调用端 CLI（`client` / `admin`） | `Authorization: Bearer ahub_cli_<secret>` | `client` Key 同时受 `bound_node_id` 与 `allowed_nodes_json` 交集节点范围（覆盖全量 REST 接口与 `/ws/stream` 帧过滤）、创建者归属（`created_by_key_id`）、`allow_unsandboxed` 与 `max_depth_limit` 约束 |
| 节点守护端（`node`） | `Authorization: Bearer ahub_nod_<secret>` | 仅可操作 `bound_node_id` 对应的连接、认领与上报接口 |

### 1.2 幂等与血统透传请求头

- `Idempotency-Key`（可选，推荐所有 `POST /api/v1/runs` 调用携带）：相同 `Idempotency-Key` 在载荷一致时返回已有 `Run`（`200` / `202`）而不重复创建；若相同 Key 对应的关键参数（`node_id`、`workdir`、`agent`、`prompt`）不一致，返回 `409 IDEMPOTENCY_CONFLICT`。
- 血统字段：`POST /api/v1/runs` 请求体支持可选字段 `parent_run_id`（`ahub` CLI 会自动从环境变量 `AHUB_RUN_ID` 读取并填入）。服务端据此查询父任务校验 `depth + 1 <= max_depth` 与 `(node_id, workdir)` 环路。

### 1.3 统一响应信封

成功响应均返回 JSON（流式下载 `/dl/*` 与 `/skill/SKILL.md` 除外）；错误响应统一格式为：

```json
{
  "ok": false,
  "error": {
    "code": "WORKDIR_AMBIGUOUS",
    "message": "Multiple workspaces matched project key 'my-skills'.",
    "details": {
      "candidates": [
        "cnb/my-skills",
        "github/my-skills"
      ]
    }
  }
}
```

## 2. REST API 端点清单

### 2.1 节点与工作区目录

| 方法与路径 | 允许 Scope | 功能说明 | 关键请求/响应约定 |
| --- | --- | --- | --- |
| `GET /api/v1/nodes` | `admin`, `client` | 列出所有已注册节点及其在线态、可用 Agent、模型简称和已上报工作区 | 响应 `nodes[]`（按 `client` Key 的 `bound_node_id` 与 `allowed_nodes_json` 自动过滤可见范围） |
| `PATCH /api/v1/nodes/:id` | `admin` | 修改节点显示名、`status`（如设为 `draining` 停止派发新任务）或 `max_concurrency` | 请求体 `{display_name?, status?, max_concurrency?}` |
| `POST /api/v1/nodes/:id/claim` | `node` | 节点认领待执行任务（WS `hub.wake` 后及重连握手后必调） | 请求 `{conn_nonce, busy_workdirs?}`；返回 `claimed_runs[]`（已加租约锁定的完整任务列表） |
| `POST /api/v1/runs/:id/heartbeat` | `node` | 为运行中的任务续期 `90s` 租约，并检查是否已被取消 | 请求 `{lease_owner}`；返回 `{ok: true, status, should_abort: boolean, lease_expires_at}` |
| `POST /api/v1/runs/:id/approval` | `node` | 上报 `needs_approval` 持久检查点（尤其用于子进程退出型的远控审批） | 请求 `{lease_owner, remote_control_url?, native_session_id?, resolved_model?, resolved_effort?, summary?, output_md?, output_bytes?, duration_ms?}`；原子持久化字段、回填 `threads.native_session_id` 并续期租约 |
| `POST /api/v1/runs/:id/complete` | `node` | 上报任务终态（`done` / `failed` / `cancelled`）与完整输出 | 请求 `{lease_owner, status, native_session_id?, resolved_model?, resolved_effort?, summary, output_md, output_bytes, duration_ms, error_code?, error_message?}` |

### 2.2 会话线程（Threads）

| 方法与路径 | 允许 Scope | 功能说明 | 关键请求/响应约定 |
| --- | --- | --- | --- |
| `GET /api/v1/threads` | `admin`, `client` | 分页查询会话列表，支持 `?node_id=&status=active|archived&q=&limit=50&cursor=` | 按 `pinned DESC, sort_order ASC, updated_at DESC` 排序（`client` Key 仅见本人创建且在允许节点内的线程） |
| `PATCH /api/v1/threads/:id` | `admin`, `client` | 更新会话标题、归档状态或置顶顺序 | 请求 `{title?, status?, pinned?, sort_order?}`（`client` Key 强制校验节点权限与线程归属） |
| `POST /api/v1/threads/:id/fork` | `admin`, `client` | 将已有会话分叉到新节点或新工作区，建立独立 `Thread` | 请求 `{node_id, workdir, agent?, title?}`；校验源/目标节点权限与线程归属，携带原会话最新一轮摘要作为首条上下文提示 |

### 2.3 任务执行与编排（Runs）

| 方法与路径 | 允许 Scope | 功能说明 | 关键请求/响应约定 |
| --- | --- | --- | --- |
| `POST /api/v1/runs` | `admin`, `client` | 创建并入队一个 `Run`（未传 `thread_id` 时自动新建 `Thread`）。见 [run-create.schema.json](schemas/run-create.schema.json) | 支持查询参数 `?wait_ms=0..45000`。若在 `wait_ms` 内到达终态或 `needs_approval` 直接返回 `200`；超时仍在跑返回 `202` 含 `run` 快照（绝不超过 `45000ms`，防止触发 Cloudflare 100s `524`） |
| `GET /api/v1/runs` | `admin`, `client` | 按条件筛选任务列表，支持 `?node_id=&thread_id=&status=&root_run_id=&limit=50` | 返回 `runs[]` 摘要列表（不含大体积 `output_md`） |
| `GET /api/v1/runs/:id` | `admin`, `client` | 查询单条任务详情与输出，支持 `?view=summary|full&tail_bytes=16384` | `view=summary` 时按 `tail_bytes` 截断返回 `output_preview` 与 `truncated: true` |
| `GET /api/v1/runs/:id/events` | `admin`, `client` | 增量拉取过程事件，支持 `?after_seq=0&limit=200` | 返回 `events[]` 与 `next_seq` |
| `PATCH /api/v1/runs/:id` | `admin`, `client` | 仅限任务仍处于 `queued` 时调整目标 `node_id`、`workdir`、`model`、`effort` 或 `priority_order` | 若任务已被认领离开 `queued` 返回 `409 INVALID_STATE_TRANSITION`；改派 `node_id`/`workdir` 仅限尚未建连的单轮新会话（已建连或多轮会话须走 `/fork`，否则返回 `409 INVALID_STATE_TRANSITION`），并同步校验委派环路（`409 DELEGATION_CYCLE_DETECTED`）与同步更新 `threads(node_id, workdir, project_key)` |
| `POST /api/v1/runs/reorder` | `admin`, `client` | 批量重排同节点待执行队列的 `priority_order`（供前端 `@dnd-kit` 拖拽排序） | 请求 `{node_id, ordered_run_ids: string[]}`（`client` Key 校检节点权限与队列条目归属） |
| `POST /api/v1/runs/:id/resolve` | `admin`, `client` | 人工在远控完成审批后手动放行结算处于 `needs_approval` 的任务 | 可选请求 `{summary?}`；CAS 置 `status='done'`、释放租约、向 `NodeHub` 发 `hub.abort(approval_resolved)` 解锁本地 `workdir` 并广播 `run.updated` |
| `POST /api/v1/runs/:id/cancel` | `admin`, `client` | 取消单个任务或整棵衍生任务树 | 请求 `{cascade?: boolean, reason?: string}`；`queued` 直接变 `cancelled`，运行中任务立即经 DO 下发 `hub.abort` |

### 2.4 凭证管理与自举分发

| 方法与路径 | 允许 Scope | 功能说明 | 关键请求/响应约定 |
| --- | --- | --- | --- |
| `GET /api/v1/auth/me` | `admin`, `client`, `node` | 返回当前凭证或 Cloudflare Access 会话解析后的主体信息 | 响应 `{ok: true, principal: {kind, scope, bound_node_id, allowed_nodes, allow_unsandboxed, max_depth_limit}}`；浏览器无本地 Token 时用于静默探测 Access 会话态 |
| `GET /api/v1/keys` | `admin` | 列出所有 API Key 元数据（只返回 `key_prefix` 与脱敏 `notify_webhook_host`/`has_webhook`，绝不返回明文 `token` 或 Webhook 密钥） | 支持 `?scope=&include_revoked=false` |
| `POST /api/v1/keys` | `admin` | 签发新的 `admin`、`client` 或 `node` 凭证 | 请求 `{name, scope, bound_node_id?, allowed_nodes?, allow_unsandboxed?, max_depth_limit?, webhook_url?, webhook_key?}`；`webhook_url`/`webhook_key` 仅允许 `client` Key 设置，经 `WEBHOOK_ENCRYPTION_KEY` 加密后落库；仅本次响应返回明文 `token` |
| `PATCH /api/v1/keys/:id` | `admin` | 增量更新未吊销凭证的节点绑定与独立 Bot Webhook 配置 | 请求 `{allowed_nodes?, bound_node_id?, allow_unsandboxed?, max_depth_limit?, webhook_url?, webhook_key?, clear_webhook?}`；支持 `1:1`、`N:1` 与 `M:N` 多 Bot 与节点映射调整，仅返回更新后的脱敏 `key` |
| `DELETE /api/v1/keys/:id` | `admin` | 吊销指定凭证（立即写入 `revoked_at` 并踢掉关联在线节点 WS） | 响应 `{ok: true, revoked_at}` |
| `GET /dl/install.sh` | 公开 | 一键安装脚本（供新机器与外部助手沙箱拉取 `ahub`） | 返回 `text/x-sh` |
| `GET /dl/bootstrap.md` | 公开 | 面向本地 Coding Agent 的节点安装、升级、配置初始化与系统服务托管二合一自举指南 | 返回 `text/markdown; charset=utf-8`（自动注入当前 `HUB_PUBLIC_URL`） |
| `GET /dl/version.json` | 公开 | 最新版本及各平台 SHA-256 校验表（供 `ahub update` 使用） | 返回 `{version, released_at, assets: {darwin_arm64: {url, sha256}, ...}}` |
| `GET /dl/ahub-<os>-<arch>` | 公开 | 分发编译好的静态 Go 二进制或重定向至 Release 资产 | 二进制流或 `302` |
| `GET /skill/SKILL.md` | 公开 | 返回最新配套 Agent Skill 文档 | 返回 `text/markdown; charset=utf-8` |

## 3. Durable Objects WebSocket 双向协议

控制面在 Durable Object `NodeHub` 中利用 **WebSocket Hibernation API** 托管两类长连接，全部帧均采用 UTF-8 JSON 文本帧。完整字段约束见 [ws-frames.schema.json](schemas/ws-frames.schema.json)。

### 3.1 节点专属通道：`wss://ahub.bobocai.win/ws/node`

连接握手必须携带 `Authorization: Bearer ahub_nod_<secret>`。`NodeHub` 从凭证解析出绑定的 `node_id`，拒绝节点越权自报 ID。

**Node -> Hub 帧**：

1. `node.hello`（建连首帧必发，后台异步目录探测就绪后可增量重发刷新）：上报 `conn_nonce`、`version`、`os`、`arch`、`max_concurrency`、`capabilities`（含 `agents.<agent>` 下的 `enabled`、`available`、`default_model`、`default_effort`、`catalog_status` (`pending` | `ready` | `fallback`) 与 `models: [{id, label, efforts, default_effort}]` 结构化目录及兼容 `aliases`）以及 `workspaces`（扫描到的项目短名与规范绝对路径列表）。
2. `node.ping`：每 `25s` 发送一次，附带当前本机活跃任务 ID 列表 `active_run_ids`，同时续期节点 `last_seen_at` 及活跃任务租约。
3. `run.event` / `run.events`：实时转发 Agent 执行事件。单条帧 `run.event` 含 `run_id`、`seq`（单调递增）、`kind`（`status` | `tool_use` | `turn_end` | `approval_needed` | `stderr_warn` | `system`）、`payload` 与 `ts`；节点守护端每 `250ms` 或积满 `100` 条打包发送批量帧 `run.events`（`{type: "run.events", run_id, events: [{seq, kind, payload, ts}]}`），其中 `approval_needed` 恒定立即刷新（`0ms`），`status` 仅在单任务 `250ms` 窗口前沿立即刷新（窗口期内连续突发的 `status` 自动并入 `250ms` 批量帧，防止高频状态刷屏绕过聚合冲击 `NodeHub` DO 与 D1）。`NodeHub` 将事件批量落入 D1 `run_events`（`INSERT OR IGNORE`）并原样广播给订阅该任务的 `/ws/stream` 客户端。
4. `run.state`：即时同步 `claimed -> running` 或 `running -> needs_approval`（附 `remote_control_url`）状态切换。

**Hub -> Node 帧**：

1. `hub.welcome`：确认连接接受与心跳周期（`heartbeat_interval_ms: 25000`），附带当前是否存在积压队列标志 `has_pending_runs`。
2. `hub.wake`：通知节点有新任务或重试指令待拉取（含 `reason: "run_queued" | "reconcile"` 与提示 `run_id`）。节点收到后立即并发安全地调用 `POST /api/v1/nodes/:id/claim`。
3. `hub.abort`：要求节点立即终止指定 `run_id`（含 `reason`）。节点对目标子进程组先发 `SIGTERM`，若 `5 秒` 内未退出则补发 `SIGKILL`。

### 3.2 前端与 `ahub wait` 实时订阅通道：`wss://ahub.bobocai.win/ws/stream`

支持两种订阅粒度：
- 全局工作台订阅（Web UI）：不传 `run_id`（需通过 Cloudflare Access 或 `admin` 鉴权），接收全机群节点上下线（`node.status`）、任务状态变更（`run.updated`）及当前打开会话的事件增量（`run.event`）。
- 单任务等待订阅（`ahub wait` / `client`）：传 `?run_id=run_xxx`（需有该任务读权限），接收 `run.event`、`run.updated`，并在任务到达终态或 `needs_approval` 时收到终结帧后由客户端主动断开。

**Hub -> Client 帧**：
- `snapshot`：建连瞬间下发当前最新快照（包含 `nodes`、可选 `threads` 与 `runs`，避免连接建立与首次 REST 拉取之间的竞态丢帧）。
- `node.status`：节点状态变更增量。
- `run.updated`：任意 `Run` 状态、耗时或摘要变更。
- `run.event` / `run.events`：实时执行流事件增量（单条或批量）。
- `error`：鉴权失效或订阅非法对象提示。

## 4. Cloudflare Queues 通知载荷契约

队列名固定为 `ahub-outbound-notify`（死信队列 `ahub-outbound-notify-dlq`）。

### 4.1 队列消息格式（入队条件与体量控制）

仅当 `runs.notify_policy_json` 中指定了有效目标（如 `{"target":"grok"}`）且任务进入 `done`、`failed`、`cancelled` 或 `needs_approval` 时，Worker 才投递队列消息。消息体严格控制在 `4 KB` 以内：

```json
{
  "run_id": "run_01J...",
  "thread_id": "thr_01J...",
  "root_run_id": "run_01J...",
  "node_id": "macmini",
  "workdir": "~/workspace/dds",
  "agent": "agy",
  "status": "done",
  "target": "grok",
  "attempt": 1
}
```

### 4.2 Grok Routine Webhook 回调格式与多 Bot 隔离路由

Queue Consumer 从 D1 按 `runs.created_by_key_id` 关联查询签发该任务的 `api_keys` 路由配置（目标选路顺序如下），随后发送 `POST` JSON：

1. **专属 Bot Webhook（优先）**：若 `runs.created_by_key_id` 关联到未吊销的 `client` 凭证且 `notify_webhook_ciphertext` 非空，则以 Worker Secret `WEBHOOK_ENCRYPTION_KEY` 解密得到该 Bot 专属 `webhook_url` 与可选 `webhook_key`。
2. **Fail-Closed 隔离保护**：若 `created_by_key_id` 对应凭证已被吊销（`revoked_at IS NOT NULL`）或专属 Webhook 解密失败（如缺失/轮换错误的 `WEBHOOK_ENCRYPTION_KEY`），Consumer **严禁回退至全局 `GROK_WEBHOOK_URL`**，必须直接将 `runs.notify_status` 标记为 `'failed'` 并 `ack()` 防止跨 Bot 串信泄露。
3. **全局环境变量兜底**：仅当任务由非独立 Bot 凭证创建或对应 Key 未配置专属密文时，才回退使用环境变量 `GROK_WEBHOOK_URL` / `GROK_WEBHOOK_KEY`（通用 `webhook` 目标优先 `WEBHOOK_URL`）。

发送时若存在 `webhook_key` 附带认证头 `Authorization: Bearer <webhook_key>`，载荷结构如下：

```json
{
  "event": "ahub_run_completed",
  "hub_url": "https://ahub.bobocai.win",
  "run_id": "run_01J...",
  "thread_id": "thr_01J...",
  "root_run_id": "run_01J...",
  "node_id": "macmini",
  "workdir": "~/workspace/dds",
  "agent": "agy",
  "status": "done",
  "resolved_model": "gemini-4-carbon-high",
  "resolved_effort": "high",
  "native_session_id": "9956aa05-c359-49b6-8462-30ee454ee29f",
  "duration_ms": 18420,
  "remote_control_url": "",
  "summary": "已完成模块边界梳理，详见完整输出。",
  "output_bytes": 4820,
  "fetch_full_cmd": "ahub result run_01J... --full --json"
}
```

重试策略：HTTP 非 `2xx` 时抛出异常由 Cloudflare Queues 按指数退避自动重试，最多 `5` 次；超过 `5` 次转入 `ahub-outbound-notify-dlq` 并将 `runs.notify_status` 标为 `failed`。

## 5. 标准错误码表

| 错误码 | HTTP 状态 | 语义说明 | 调用方恢复建议 |
| --- | --- | --- | --- |
| `UNAUTHORIZED` | `401` | 缺少或无效的认证凭证 | 检查 `AHUB_TOKEN` 或重新登录 Cloudflare Access |
| `FORBIDDEN_SCOPE` | `403` | 当前 Key 无权操作目标节点、禁止关闭 `--sandbox` 或越权访问他方数据 | 联系管理员在 Web 控制台调整 Key 权限 |
| `NODE_NOT_FOUND` | `404` | 指定 `node_id` 不存在 | 调用 `ahub nodes --json` 获取最新节点清单 |
| `NODE_DRAINING` | `409` | 目标节点正处于维护排水状态，拒绝新任务入队 | 改派其他节点或等待节点恢复 `online` |
| `WORKDIR_NOT_FOUND` | `400` | 目标节点上未匹配到对应的项目短名或路径 | 核对 `ahub nodes --json` 返回的 `workspaces` |
| `WORKDIR_AMBIGUOUS` | `400` | 传入的项目短名在节点上命中多个同名目录 | 从 `error.details.candidates` 中选取带前缀路径重发 |
| `DEPTH_LIMIT_EXCEEDED` | `409` | 跨机衍生调用深度超过 `max_depth` | 停止继续委派，在当前上下文汇总结果返回上级 |
| `DELEGATION_CYCLE_DETECTED` | `409` | 同一 `root_run_id` 祖先链试图回环调用已持锁的 `(node_id, workdir)` | 禁止循环派单，直接由当前节点处理或返回 |
| `IDEMPOTENCY_CONFLICT` | `409` | 重复的 `Idempotency-Key` 携带了不一致的参数 | 更换新的幂等键或复用原请求参数 |
| `INVALID_STATE_TRANSITION` | `409` | 操作与当前 `status` 冲突（如试图修改已认领任务、改派多轮已建连会话或覆盖终态） | 重新查询 `GET /api/v1/runs/:id` 对齐状态；多轮会话改派请改用 `/fork` |
| `LEASE_CONFLICT` | `409` | 节点心跳、审批检查点或完成上报携带的 `lease_owner` 与云端当前租约不匹配 | 立即停止本地目录占用等待下次认领 |
| `APPROVAL_TIMEOUT` | `—`（任务 `error_code`） | 处于 `needs_approval` 状态的任务超过单轮 `timeout_sec` 上限仍未获批放行 | 检查远控或工作区变更后视需要重派新任务 |
| `NODE_LEASE_EXPIRED` | `410` | 节点心跳租约超时未续期，任务已被回收标为失败 | 检查节点在线状态与本地工作区后决定是否重发 |
| `INTERNAL_ERROR` | `500` | 服务端配置缺失（如未注入 `WEBHOOK_ENCRYPTION_KEY`）或加解密异常 | 检查 Worker Secret 与服务端日志并修复配置后重试 |
