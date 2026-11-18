# 03 HTTP API、WebSocket 协议与通知队列契约

本文档定义 `agent-hub` 控制面（默认入口 `https://ahub.bobocai.win`）对外暴露的全部 REST 接口、Durable Object `NodeHub` 的双向 WebSocket 帧格式、Cloudflare Queues 通知载荷以及标准错误码。机器可读 Schema 见 [run-create.schema.json](schemas/run-create.schema.json)、[run-record.schema.json](schemas/run-record.schema.json)、[native-event.schema.json](schemas/native-event.schema.json) 与 [ws-frames.schema.json](schemas/ws-frames.schema.json)。

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
| `GET /api/v1/nodes` | `admin`, `client` | 列出所有已注册节点及其在线态、可用 Agent、模型简称及已上报工作区；仅 `admin` Scope 额外返回脱敏默认通知通道状态（`default_notify_key_id`、`default_notify_key_name`、`default_notify_webhook_host`、`default_notify_valid`） | 响应 `nodes[]`（按 `client` Key 的 `bound_node_id` 与 `allowed_nodes_json` 自动过滤可见范围；`client` Scope 一律省略上述 `default_notify_*` 字段） |
| `PATCH /api/v1/nodes/:id` | `admin` | 修改节点显示名、`status`（如设为 `draining` 停止派发新任务）、`max_concurrency` 或节点默认通知通道 `default_notify_key_id` | 请求体 `{display_name?, status?, max_concurrency?, default_notify_key_id?}`；绑定非空 `default_notify_key_id` 时强制校验目标为未吊销、已配置 Webhook 且允许访问该节点的 `client` Key，传 `null` 或 `""` 解绑 |
| `POST /api/v1/nodes/:id/native-events` | `node` | 节点上报脱离 `ahub` 运行的本地 Agent 官方 Hook / 扩展 / 阶段里程碑原生事件（`event_kind` 支持 `interaction_needed \| turn_summary \| progress`，`agent` 支持 `agy \| pi \| omp \| codex \| claude \| grok`） | 仅允许 `bound_node_id == :id` 的节点凭证调用；按 `(node_id, event_id)` 幂等去重，入库前二次脱敏；多渠道扇出写入 `notification_deliveries`（`bot_webhook` 按 `nodes.default_notify_key_id` Fail-Closed 校验，节点未绑定时仅跳过 Bot 通道且**不阻断 `web_push`**；若没有任何匹配渠道则保留 `skipped` `NODE_DEFAULT_CHANNEL_UNBOUND` 或 `failed` `DEFAULT_CHANNEL_INVALID_OR_REVOKED`）；当 `!deduplicated` 时经 `NodeHub` DO 向全局 `admin` `/ws/stream` 广播 `native_event.upserted`（含 `open_interaction_count`） |
| `POST /api/v1/nodes/:id/claim` | `node` | 节点认领待执行任务（WS `hub.wake` 后及重连握手后必调） | 请求 `{conn_nonce, busy_workdirs?}`；返回 `claimed_runs[]`（**全系统唯一返回原始未脱敏 `prompt` 的接口**，供节点本地执行；伴随广播至 `/ws/stream` 的 `run.updated` 帧仍须对 `prompt` 脱敏并截断至 `<= 1200` 字符） |
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
| `GET /api/v1/runs` | `admin`, `client` | 按条件筛选任务列表，支持 `?node_id=&thread_id=&status=&root_run_id=&limit=50` | 返回 `runs[]` 摘要列表（不含大体积 `output_md`；`prompt` 统一经凭据脱敏并截断至 `<= 1200` 字符；可附带 `deliveries_summary: { total, sent, queued, failed }`） |
| `GET /api/v1/runs/:id` | `admin`, `client` | 查询单条任务详情与输出，支持 `?view=summary|full&tail_bytes=16384` | `view=summary`（默认）按 `tail_bytes` 截断返回 `output_preview` 与 `truncated: true`，同时将 `prompt` 脱敏并截断至 `<= 1200` 字符；`view=full` 返回完整 `output_md` 与完整脱敏后的 `prompt`（保留 `$VAR` / `<PLACEHOLDER>` 占位符，绝不回传未脱敏真实凭据）；可附带 `deliveries_summary` |
| `GET /api/v1/runs/:id/events` | `admin`, `client` | 增量拉取过程事件，支持 `?after_seq=0&limit=200` | 返回 `events[]` 与 `next_seq` |
| `PATCH /api/v1/runs/:id` | `admin`, `client` | 仅限任务仍处于 `queued` 时调整目标 `node_id`、`workdir`、`model`、`effort` 或 `priority_order` | 若任务已被认领离开 `queued` 返回 `409 INVALID_STATE_TRANSITION`；改派 `node_id`/`workdir` 仅限尚未建连的单轮新会话（已建连或多轮会话须走 `/fork`，否则返回 `409 INVALID_STATE_TRANSITION`），并同步校验委派环路（`409 DELEGATION_CYCLE_DETECTED`）与同步更新 `threads(node_id, workdir, project_key)` |
| `POST /api/v1/runs/reorder` | `admin`, `client` | 批量重排同节点待执行队列的 `priority_order`（供前端 `@dnd-kit` 拖拽排序） | 请求 `{node_id, ordered_run_ids: string[]}`（`client` Key 校检节点权限与队列条目归属） |
| `POST /api/v1/runs/:id/resolve` | `admin`, `client` | 人工在远控完成审批后手动放行结算处于 `needs_approval` 的任务 | 可选请求 `{summary?}`；CAS 置 `status='done'`、释放租约、向 `NodeHub` 发 `hub.abort(approval_resolved)` 解锁本地 `workdir` 并广播 `run.updated` |
| `POST /api/v1/runs/:id/cancel` | `admin`, `client` | 取消单个任务或整棵衍生任务树 | 请求 `{cascade?: boolean, reason?: string}`；`queued` 直接变 `cancelled`，运行中任务立即经 DO 下发 `hub.abort` |

> **`RunRecord.prompt` 控制面脱敏与截断边界**：除节点认领接口 `POST /api/v1/nodes/:id/claim`（`node` Scope）返回原始未脱敏 `prompt`、以及 `GET /api/v1/runs/:id?view=full` 返回完整脱敏 `prompt` 外，其余全部控制面 REST 接口（含 `POST /api/v1/runs` 及其 `wait_ms` 长轮询返回、`GET /api/v1/runs`、`GET /api/v1/runs/:id?view=summary`、`PATCH /api/v1/runs/:id`、`POST /api/v1/runs/reorder`、`POST /api/v1/runs/:id/resolve`、`POST /api/v1/runs/:id/cancel`、`POST /api/v1/threads/:id/fork`、`POST /api/v1/runs/:id/approval`、`POST /api/v1/runs/:id/complete`）与 `/ws/stream` 推送的 `RunRecord.prompt` 均统一经凭据脱敏并截断至最多 `1200` 字符（超出附加 `\n...[truncated]`），且不额外新增 `prompt_preview` 重复字段，以维持 [run-record.schema.json](schemas/run-record.schema.json) 紧凑契约。

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
| `GET /dl/client-bootstrap.md` | 公开 | 面向外部助手（如 Grok Bot）与纯 `client` 调用端 Agent 的 CLI/Skill 安装、原地升级（`--no-restart`）、同机多 Bot 凭据隔离（`AHUB_TOKEN` / `AHUB_CONFIG_DIR`）与沙箱冷重建自愈指南 | 返回 `text/markdown; charset=utf-8`（自动注入当前 `HUB_PUBLIC_URL`，严禁引导执行 `ahub node` 守护子命令） |
| `GET /dl/version.json` | 公开 | 最新版本及各平台 SHA-256 校验表（供 `ahub update` 使用） | 返回 `{version, released_at, assets: {darwin_arm64: {url, sha256}, ...}}` |
| `GET /dl/ahub-<os>-<arch>` | 公开 | 分发编译好的静态 Go 二进制或重定向至 Release 资产 | 二进制流或 `302` |
| `GET /skill/SKILL.md` | 公开 | 返回最新配套 Agent Skill 文档 | 返回 `text/markdown; charset=utf-8` |

### 2.5 原生活动与投递明细（`admin` Scope）

> **强制作用域隔离**：以下全部接口均执行 `requireScope(principal, ["admin"])`；任意 `client` 或 `node` 凭证调用一律返回 `403 FORBIDDEN_SCOPE`。`NotificationDeliveryRecord` 结构字段固定为：`id`、`source_kind`、`source_id`、`trigger_event`、`node_id`、`channel_kind`、`channel_id`、`channel_label`、`target_host`、`route_mode`、`status`、`attempts`、`http_status`、`error_code`、`error_message`、`sent_at`、`created_at`、`updated_at`（详见 [ws-frames.schema.json](schemas/ws-frames.schema.json)）。

| 方法与路径 | 允许 Scope | 功能说明 | 关键请求/响应约定 |
| --- | --- | --- | --- |
| `GET /api/v1/native-events` | `admin` | 分页查询原生交互会话活动记录及 `deliveries_summary` | 查询参数：`?node_id=&agent=&event_kind=&notify_status=&unacked_only=false&q=&limit=50&before_ts=&before_id=`（`limit` 夹逼 `1..100`）；`unacked_only=true` 仅返回 `event_kind = 'interaction_needed'` 且派生 `attention_state === 'open'` 的记录；响应 `200 { ok: true, events: NativeEventView[], open_interaction_count: number, next_cursor: { before_ts: string, before_id: string } \| null }` |
| `GET /api/v1/native-events/:id` | `admin` | 查询单条原生活动详情及其逐渠道投递账本 | 不存在返回 `404 NOT_FOUND`；响应 `200 { ok: true, event: NativeEventView, deliveries: NotificationDeliveryRecord[] }` |
| `POST /api/v1/native-events/:id/ack` | `admin` | 幂等确认指定 `interaction_needed`（或同会话未确认互动）已处理 | 可选请求体 `{ scope?: "single" \| "session" }`（默认 `"single"`）；`"session"` 且 `native_session_id != ''` 时一并确认同 `(node_id, agent, native_session_id)` 下全部未确认 `interaction_needed`；广播 `native_event.upserted` 至全局 `admin` `/ws/stream`，返回 `200 { ok: true, event: NativeEventView, acked_count: number, open_interaction_count: number }` |
| `POST /api/v1/native-events/:id/redeliver` | `admin` | 对原生事件的失败通道或指定 `delivery_id` 重新入队投递 | 可选请求体 `{ delivery_id?: string }`（指定时校验归属 `('native_event', :id)`，否则 `404 NOT_FOUND`）；重置目标明细为 `'queued'`、重算外层 `notify_status`、投递 `{ kind: "delivery", delivery_id }` 并广播 `delivery.updated` 与 `native_event.upserted`，返回 `200 { ok: true, event: NativeEventView, deliveries: NotificationDeliveryRecord[], requeued_count: number }` |
| `GET /api/v1/runs/:id/deliveries` | `admin` | 查询指定受控 `Run` 的多渠道通知投递账本明细 | 任务不存在返回 `404 NOT_FOUND`；返回 `200 { ok: true, deliveries: NotificationDeliveryRecord[] }` |
| `POST /api/v1/runs/:id/redeliver` | `admin` | 对受控 `Run` 的失败通道或指定 `delivery_id` 重新入队投递（供 `InspectorPane` 单通道重推复用） | 可选请求体 `{ delivery_id?: string }`（校验归属 `('run', :id)`，否则 `404 NOT_FOUND`）；重置目标明细为 `'queued'`、重算 `runs.notify_status`、投递 `{ kind: "delivery", delivery_id }` 并广播 `delivery.updated` 与 `run.updated`，返回 `200 { ok: true, run: RunRecord, deliveries: NotificationDeliveryRecord[], requeued_count: number }` |

### 2.6 浏览器 Web Push 订阅管理（`admin` Scope）

> **强制作用域隔离**：以下 6 个接口同样全部执行 `requireScope(principal, ["admin"])`；`client` 与 `node` 凭证调用一律返回 `403 FORBIDDEN_SCOPE`。

| 方法与路径 | 允许 Scope | 功能说明 | 关键请求/响应约定 |
| --- | --- | --- | --- |
| `GET /api/v1/push/config` | `admin` | 查询控制面 Web Push VAPID 就绪状态与公钥 | 若 `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_JWK` 与 `VAPID_SUBJECT` 均已配置，返回 `200 { ok: true, enabled: true, vapid_public_key: string }`；否则返回 `200 { ok: true, enabled: false, vapid_public_key: null, reason: "VAPID_NOT_CONFIGURED" }` |
| `GET /api/v1/push-subscriptions` | `admin` | 列出已注册浏览器推送设备（支持 `?include_revoked=false`） | 返回 `200 { ok: true, subscriptions: WebPushSubscriptionRecord[] }`；仅含脱敏元数据（`id`、`label`、`endpoint_host`、`endpoint_sha256_prefix` 12 位十六进制、`node_filter`、`event_filter`、`enabled`、`failure_count`、`last_sent_at`、`last_error_code`、`last_error_message`、`revoked_at`、`created_at`、`updated_at`），**绝不回传密文、完整 `endpoint`、`p256dh` 或 `auth`** |
| `POST /api/v1/push-subscriptions` | `admin` | 注册或按 `endpoint_sha256` 幂等刷新浏览器推送订阅 | 请求 `{ label, subscription: { endpoint, keys: { p256dh, auth } }, node_filter?: string[], event_filter?: string[] }`；强制校验 `https:` 与厂商 Push 域名 SSRF 白名单（`fcm.googleapis.com`、`*.push.apple.com`、`*.push.services.mozilla.com`、`*.notify.windows.com`；仅 `ALLOW_LOOPBACK_PUSH_FOR_TEST === "true"` 时放行 `http://127.0.0.1` / `localhost`）、`65B`（`0x04` 前缀）`p256dh`、`16B` `auth` 与有效 `event_filter` 键（默认 `["run_needs_approval", "run_failed", "native_interaction_needed"]`），不合规返回 `400 BAD_REQUEST`；新建返回 `201`，续订刷新清除 `revoked_at` 并返回 `200 { ok: true, subscription }` |
| `PATCH /api/v1/push-subscriptions/:id` | `admin` | 修改订阅设备显示名、启停开关、节点或事件过滤规则 | 请求 `{ label?, enabled?, node_filter?, event_filter? }`；不存在返回 `404 NOT_FOUND`，已吊销返回 `409 INVALID_STATE_TRANSITION`，成功返回 `200 { ok: true, subscription }` |
| `DELETE /api/v1/push-subscriptions/:id` | `admin` | 解绑并吊销指定浏览器推送订阅 | 不存在返回 `404 NOT_FOUND`；写入 `revoked_at = now, enabled = 0`，返回 `200 { ok: true, revoked_at }` |
| `POST /api/v1/push-subscriptions/:id/test` | `admin` | 同步发送一条测试 Web Push（`kind: "test"`）并立即回显上游网关结果 | 不存在返回 `404 NOT_FOUND`，已吊销返回 `409 INVALID_STATE_TRANSITION`，未配置 VAPID 返回 `400 BAD_REQUEST`；同步更新 `last_sent_at` / `failure_count` / `revoked_at`（遇 `404`/`410` 自动吊销），返回 `200 { ok: true, delivered: boolean, http_status: number \| null, error_code: string, error_message: string, subscription }` |

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

严格区分两种订阅粒度与权限边界：
- **全局工作台订阅（Web UI / `att.scope === "admin" && !att.runId`）**：不传 `run_id`（仅限 Cloudflare Access 或 `admin` Bearer Token；`client` / `node` 凭证一律拒绝 `403 FORBIDDEN_SCOPE`），接收全机群节点上下线（`node.status`）、任务状态变更（`run.updated`）、事件增量（`run.event` / `run.events`）、**原生活动增量（`native_event.upserted`）与投递账本增量（`delivery.updated`）**。
- **单任务等待订阅（`ahub wait` / `client` / `?run_id=<id>`）**：传 `?run_id=run_xxx`（需有该任务读权限），仅接收该 `run_id` 的 `run.event`、`run.events`、`run.updated` 与脱敏 `snapshot`（**绝不携带 `native_events`、`open_interaction_count`，也绝不转发 `native_event.upserted` 或 `delivery.updated`**），并在任务到达终态或 `needs_approval` 时由客户端主动断开。

**Hub -> Client 帧**：
- `snapshot`：建连瞬间下发当前最新快照（包含 `nodes`、可选 `threads` 与 `runs`，避免连接建立与首次 REST 拉取之间的竞态丢帧）；其中 `nodes[]` 按订阅方 `principal.scope` 过滤（`client` Scope 省略 `default_notify_*` 字段），`runs[]` 中的 `prompt` 统一脱敏并截断至 `<= 1200` 字符。**仅当 `att.scope === "admin" && !att.runId` 时**额外包含 `native_events`（最近最多 `100` 条 `NativeEventView`）与 `open_interaction_count`（`integer >= 0`）；`client` 或 `?run_id=` 连接严禁包含上述两字段。
- `node.status`：节点状态变更增量（推送给 `client` Scope 连接时同样省略 `default_notify_*` 字段）。
- `run.updated`：任意 `Run` 状态、耗时、摘要、`notify_status` 或 `deliveries_summary` 变更（含 `NodeHub` 接收 `run.state` 后生成的增量帧，以及 `notify-queue.ts` 在更新 D1 `runs.notify_status` / `deliveries_summary` 后通过 `NodeHub` `/internal/broadcast-run` 补播的帧；`run.prompt` 统一脱敏并截断至 `<= 1200` 字符）。
- `run.event` / `run.events`：实时执行流事件增量（单条或批量）。
- `native_event.upserted`（**仅全局 `admin` 流**）：`{ type: "native_event.upserted", event: NativeEventView, open_interaction_count: number }`，在 `POST /api/v1/nodes/:id/native-events`（`!deduplicated`）、`POST /api/v1/native-events/:id/ack`、`/redeliver` 及队列更新聚合 `notify_status` 时即时推送。
- `delivery.updated`（**仅全局 `admin` 流**）：`{ type: "delivery.updated", delivery: NotificationDeliveryRecord }`，在重新入队或队列消费回写任意 `notification_deliveries` 行后即时推送。
- `error`：鉴权失效或订阅非法对象提示。

## 4. Cloudflare Queues 通知载荷契约

队列名固定为 `ahub-outbound-notify`（死信队列 `ahub-outbound-notify-dlq`）。

### 4.1 每渠道隔离队列消息与目标筛选规则

控制面在触发通知时先确定全部候选目标，向 D1 `notification_deliveries` 批量写入 `status = 'queued'` 的明细行，再按每行明细向 `NOTIFY_QUEUE` 投递独立的小体积消息（`< 256 B`）：

```json
{
  "kind": "delivery",
  "delivery_id": "dlv_01J..."
}
```

> 隔离原则：由于每条消息只负责一个 `(source_kind, source_id, trigger_event, channel_kind, channel_id)` 投递目标，单条 Web Push 返回 `503` / `429` 重试时绝不会重复触发已成功的 Bot Webhook 或其他浏览器设备。

目标入队规则如下：

- **受控 `Run` 任务通知**：
  - Bot Webhook：若 `runs.notify_policy_json` 显式指定有效目标（`target` 为 `"grok"` 或 `"webhook"` 且命中 `events` 过滤），任务进入 `done`、`failed`、`cancelled` 或首次进入 `needs_approval` 时生成对应 `bot_webhook` / `legacy_webhook` 投递行；若 `target == "none"`，**仅当**满足 `depth == 0` **且**发起方为人工控制面（`runs.created_by_key_id IS NULL`）或 `admin` API Key 时转入 `nodes.default_notify_key_id`（`route_mode = "node_default"`；失效则将 `runs.notify_status` 置为 `'failed'`）。`client` 静默任务与 `depth >= 1` 子任务绝不触发 `node_default`。
  - Web Push：仅当 `depth == 0` 时匹配 `enabled = 1 AND revoked_at IS NULL` 且 `node_filter_json` 覆盖目标节点的管理员订阅；其中人工/`admin` 任务按 `run_<status>` 过滤，**`client` Key 创建的 `depth == 0` 任务仅匹配 `needs_approval` 与 `failed`（绝不在 `done` / `cancelled` 弹窗）**，`depth >= 1` 子任务对 Web Push 完全静默。
- **节点原生 Agent 事件通知（`native_events`）**：
  - `POST /api/v1/nodes/:id/native-events` 在 `!deduplicated` 时：若节点存在有效的 `default_notify_key_id`，生成 `bot_webhook`（`route_mode = "node_default"`）投递行（未绑定时跳过 Bot 通道但**不阻断 Web Push**）；同时为所有匹配 `node_filter_json` 与 `native_<event_kind>`（`interaction_needed` / `turn_summary` / `progress`）的活跃 `web_push_subscriptions` 各自生成 `web_push` 投递行。若最终两者皆无匹配，按规则保留 `notify_status = 'skipped'`（`NODE_DEFAULT_CHANNEL_UNBOUND`）或 `'failed'`（`DEFAULT_CHANNEL_INVALID_OR_REVOKED`）。

### 4.2 Bot Webhook 回调格式与 Fail-Closed 隔离

Queue Consumer 从 D1 实时校验目标路由与 Key 状态（任何失效、解绑或解密失败均 **Fail-Closed**，严禁跨 Bot 或以全局 `GROK_WEBHOOK_URL` 绕过节点绑定）：

1. **任务发起方专属 Bot Webhook（`route_mode = "key"`）**：**仅当**发起方凭证为 `client` Scope API Key 且显式携带 `--notify` 时锁定 `route_mode = "key"`，Fail-Closed 仅使用 `runs.created_by_key_id` 对应的加密 Webhook（已吊销、未配置或解密失败直接将投递行标 `failed` 并 `ack()`，绝不回退 `node_default` 或全局 Webhook）。
2. **节点显式绑定的默认 Bot 通道（`route_mode = "node_default"` 及 `native_event` Bot 通道）**：投递瞬间从 `nodes.default_notify_key_id` 关联查询 `api_keys`，同时满足 `scope = 'client'`、`revoked_at IS NULL`、`notify_webhook_ciphertext != ''` 且 `allowed_nodes` 允许该 `node_id`；任一条件不满足或解绑，直接标 `failed`（`CHANNEL_UNBOUND_OR_REVOKED`）并 `ack()`，**严禁改用其他节点/其他 Bot 的通道或全局 `GROK_WEBHOOK_URL`**。
3. **人工 / `admin` 显式请求的兼容兜底（`route_mode = "global_legacy"`）**：当人工控制面入口或 `admin` Key 显式指定 `--notify grok` / `webhook` 且目标节点未绑定 `default_notify_key_id` 时，使用环境变量 `GROK_WEBHOOK_URL` / `WEBHOOK_URL`。

`ahub_native_event`（本地 Agent 原生会话互动、阶段里程碑或结束总结，`event_kind` 为 `interaction_needed | turn_summary | progress`）回调载荷如下（仅作只读用户通知，不代表自动放行或自动回复）：

```json
{
  "event": "ahub_native_event",
  "hub_url": "https://ahub.bobocai.win",
  "native_event_id": "evt_01J...",
  "event_id": "claude:sess_1:Stop:9f8e7d6c5b4a",
  "node_id": "macmini",
  "agent": "claude",
  "event_kind": "interaction_needed",
  "native_session_id": "sess_1",
  "workdir": "~/workspace/demo",
  "title": "需要人工确认",
  "summary": "请确认是否继续执行（敏感凭据已脱敏）。",
  "source": "claude-hook",
  "action_required": "notify_user_only",
  "created_at": "2026-11-17T12:00:00.000Z"
}
```

发送时若存在 `webhook_key` 附带认证头 `Authorization: Bearer <webhook_key>`，受控任务 `ahub_run_completed` 载荷结构如下：

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
  "prompt_preview": "请排查项目构建日志并给出根因摘要（其中敏感凭据已脱敏）。",
  "prompt_truncated": false,
  "summary": "已完成模块边界梳理，详见完整输出。",
  "output_bytes": 4820,
  "fetch_full_cmd": "ahub result run_01J... --full --json"
}
```

> 说明：`prompt_preview` 为服务端按凭据脱敏规则截断后的下发指令预览（上限 `1200` 字符），仅作异步回调上下文提示；外部 Bot（如 Grok Bot）应在 `ahub run` 下发时直接向用户展示指令原文，严禁任务完成后再调用 `ahub result` 回拉原始明文 `prompt`；`ahub result <run_id> --full --json` 仅用于显式诊断排查时拉取完整脱敏输出（`output_md`）与完整脱敏 `prompt`。

Bot Webhook 重试策略：HTTP 非 `2xx` 时抛出异常由 Cloudflare Queues 按指数退避自动重试，最多 `5` 次；超过 `5` 次转入 `ahub-outbound-notify-dlq` 并将该投递明细置 `failed`（`WEBHOOK_DELIVERY_FAILED`）、重算聚合 `notify_status`，同时调用 `NodeHub` DO 广播 `delivery.updated` 与 `run.updated` / `native_event.upserted`。

### 4.3 Web Push 出站格式（RFC 8291 / 8292）与响应处置

`web_push` 投递行由 `apps/hub-worker/src/web-push.ts` 基于 Workers 原生 `crypto.subtle` 执行端到端加密后直连浏览器厂商 Push 服务：

- **HTTP 请求头**：`Authorization: vapid t=<jwt>, k=<VAPID_PUBLIC_KEY>`（RFC 8292 `ES256`，`aud = new URL(endpoint).origin`，`exp = now + 12h`）、`Content-Type: application/octet-stream`、`Content-Encoding: aes128gcm`、`TTL: 86400`、`Urgency: high | normal`（`interaction_needed` / `needs_approval` / `failed` 用 `high`，其余用 `normal`）。
- **加密前明文 JSON 结构**（UTF-8 编码严格裁剪至 `<= 3072` 字节）：

```json
{
  "v": 1,
  "kind": "native_event",
  "id": "evt_01J...",
  "tag": "ahub-native-evt_01J...",
  "urgent": true,
  "title": "[macmini · claude] 需要人工确认",
  "body": "~/workspace/demo: 是否允许执行迁移检查？",
  "target_url": "/?pane=native&session=macmini:claude:sess_1&event=evt_01J...",
  "ts": "2026-11-18T05:30:00.000Z"
}
```

- **状态码处置与 DO 广播**：

| Push 网关状态码 | 明细 `status` | 订阅表副作用 | 队列策略 |
| --- | --- | --- | --- |
| `200` / `201` / `202` | `sent` | 更新 `last_sent_at = now`，清零 `failure_count` 与错误字段 | `message.ack()` |
| `404` / `410` | `failed`（`SUBSCRIPTION_EXPIRED`） | 自动写入 `revoked_at = now, enabled = 0` | **不重试**，`message.ack()` |
| `400` / `401` / `403` / `413` | `failed`（`PUSH_REJECTED_<status>`） | 递增 `failure_count`，记录响应原因 | **不重试**，`message.ack()` |
| `429` / `5xx` / 超时 | 重试期间保 `queued`，耗尽置 `failed` | 耗尽 5 次后递增 `failure_count`，写入 `PUSH_UPSTREAM_TIMEOUT` | 指数退避重试（最多 5 次） |

每次消费更新完成后（无论成功、确定性失败还是重试耗尽），`notify-queue.ts` 均重算 `runs` / `native_events` 的聚合 `notify_status` 与 `deliveries_summary`，并调用 `NodeHub` DO 内部接口向全局 `admin` `/ws/stream` 广播 `delivery.updated` 及最新的 `run.updated` / `native_event.upserted`。

## 5. 标准错误码表

| 错误码 | HTTP 状态 | 语义说明 | 调用方恢复建议 |
| --- | --- | --- | --- |
| `BAD_REQUEST` | `400` | 请求 JSON 格式非法、字段校验未通过、VAPID 未配置或 Push 端点未命中 SSRF 白名单 | 按响应 `error.message` 修正请求参数或服务端配置后重发 |
| `UNAUTHORIZED` | `401` | 缺少或无效的认证凭证 | 检查 `AHUB_TOKEN` 或重新登录 Cloudflare Access |
| `FORBIDDEN_SCOPE` | `403` | 当前 Key 无权操作目标节点、禁止关闭 `--sandbox`、跨节点上报或越权访问 `admin` 原生活动/Push 接口 | 联系管理员在 Web 控制台调整 Key 权限或改用 `admin` 凭证 |
| `NOT_FOUND` | `404` | 请求的目标资源（`run_id`、`thread_id`、`native_event_id`、`delivery_id` 或 `subscription_id`）不存在 | 刷新列表确认目标 ID 是否已过期或被清理 |
| `NODE_NOT_FOUND` | `404` | 指定 `node_id` 不存在 | 调用 `ahub nodes --json` 获取最新节点清单 |
| `NODE_DRAINING` | `409` | 目标节点正处于维护排水状态，拒绝新任务入队 | 改派其他节点或等待节点恢复 `online` |
| `WORKDIR_NOT_FOUND` | `400` | 目标节点上未匹配到对应的项目短名或路径 | 核对 `ahub nodes --json` 返回的 `workspaces` |
| `WORKDIR_AMBIGUOUS` | `400` | 传入的项目短名在节点上命中多个同名目录 | 从 `error.details.candidates` 中选取带前缀路径重发 |
| `DEPTH_LIMIT_EXCEEDED` | `409` | 跨机衍生调用深度超过 `max_depth` | 停止继续委派，在当前上下文汇总结果返回上级 |
| `DELEGATION_CYCLE_DETECTED` | `409` | 同一 `root_run_id` 祖先链试图回环调用已持锁的 `(node_id, workdir)` | 禁止循环派单，直接由当前节点处理或返回 |
| `IDEMPOTENCY_CONFLICT` | `409` | 重复的 `Idempotency-Key` 携带了不一致的参数 | 更换新的幂等键或复用原请求参数 |
| `INVALID_STATE_TRANSITION` | `409` | 操作与当前状态冲突（如试图修改已认领任务、改派多轮已建连会话、覆盖终态，或修改/测试已吊销 Push 订阅） | 重新查询详情对齐状态；多轮会话改派请改用 `/fork` |
| `LEASE_CONFLICT` | `409` | 节点心跳、审批检查点或完成上报携带的 `lease_owner` 与云端当前租约不匹配 | 立即停止本地目录占用等待下次认领 |
| `APPROVAL_TIMEOUT` | `—`（任务 `error_code`） | 处于 `needs_approval` 状态的任务超过单轮 `timeout_sec` 上限仍未获批放行 | 检查远控或工作区变更后视需要重派新任务 |
| `NODE_LEASE_EXPIRED` | `410` | 节点心跳租约超时未续期，任务已被回收标为失败 | 检查节点在线状态与本地工作区后决定是否重发 |
| `INTERNAL_ERROR` | `500` | 服务端配置缺失（如未注入 `WEBHOOK_ENCRYPTION_KEY`）或加解密异常 | 检查 Worker Secret 与服务端日志并修复配置后重试 |

### 5.1 投递与 Web Push 诊断状态码

以下状态码落盘于 `notification_deliveries.error_code`、`native_events.notify_error` 或 `GET /api/v1/push/config` 的 `reason` 字段：

| 诊断码 | 出现位置 | 语义说明 |
| --- | --- | --- |
| `VAPID_NOT_CONFIGURED` | `GET /api/v1/push/config`（`reason`） | 服务端尚未注入 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_JWK` / `VAPID_SUBJECT`，前端降级为页内提醒 |
| `NODE_DEFAULT_CHANNEL_UNBOUND` | `native_events.notify_error` | 节点未绑定 `default_notify_key_id` 且无任何匹配 Web Push 订阅，`notify_status` 记为 `skipped` |
| `DEFAULT_CHANNEL_INVALID_OR_REVOKED` | `native_events.notify_error` | 节点绑定的 `default_notify_key_id` 已吊销或无效，且无任何匹配 Web Push 订阅，`notify_status` 记为 `failed` |
| `CHANNEL_UNBOUND_OR_REVOKED` | `notification_deliveries.error_code` | 异步投递消费期复核发现目标 `api_keys` 已吊销、解绑或无加密 Webhook（Fail-Closed） |
| `WEBHOOK_DELIVERY_FAILED` | `notification_deliveries.error_code` | Bot / Legacy Webhook 投递在退避重试耗尽后仍返回非 `2xx` 或超时 |
| `SUBSCRIPTION_EXPIRED` | `notification_deliveries.error_code` | Push 网关返回 `404` / `410 Gone`，订阅已自动写入 `revoked_at` |
| `PUSH_REJECTED_<status>` | `notification_deliveries.error_code` | Push 网关返回确定性客户端错误（如 `400`、`401`、`403`、`413`），不重试 |
| `PUSH_UPSTREAM_TIMEOUT` | `notification_deliveries.error_code` | Push 网关返回 `429` / `5xx` 或网络超时，且 `5` 次退避重试均失败 |
