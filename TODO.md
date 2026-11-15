# TODO

## Todo

## Doing

## Done

- [x] 重构 Web 左侧「节点与会话」面板（[apps/web/src/components/workbench/FleetThreadsPane.tsx](./apps/web/src/components/workbench/FleetThreadsPane.tsx)）：将上下分栏改为「会话」与「节点」双标签页切换模式（默认「会话」并保留拖拽排序、置顶、分叉及 `tab` 选择器隔离），「节点」页全高展示在线状态/并发/可用 Agent 与一键全部收起/展开控制，并支持按节点独立收起/展开工作目录列表；同步更新 [docs/05-web-frontend-spec.md](./docs/05-web-frontend-spec.md) 与 [evals/web/cdp-runtime-eval.mjs](./evals/web/cdp-runtime-eval.mjs) 评测断言并通过 Mutation Gate 与 Chromium CDP 实测

- [x] 使 Web 任务中心的 Agent、模型与推理强度选项同所选 `node` 节点的本地真实配置保持一致（扩展 `docs/02`–`docs/05` 与 Schema `ultra`/`auto` 枚举及结构化 `capabilities.agents`；实现守护端 `internal/daemon/capabilities.go` 4s 限时非阻塞异步探测与脱敏目录缓存；补齐 `codex` `-c model_reasoning_effort`、`agy` 基础型号/独立 `orchestrator` 映射与 Web `node -> agent -> model -> effort` 四级联动；通过 Mutation Gate 1/2、`make eval-fast` 与 `make eval-ui` Chromium CDP 实测）

- [x] 修复 `agy` 会话默认落入 `CLI Project`（`default-cli-project`）导致归类错位与项目级权限失效的问题（交付 [internal/runner/agy_project.go](./internal/runner/agy_project.go) `ResolveAgyProjectID`、在 [internal/runner/adapters.go](./internal/runner/adapters.go) `BuildCommandSpec` 自动注入 `--project <project_id>`、[internal/runner/agy_project_test.go](./internal/runner/agy_project_test.go)、更新 `docs/04-ahub-cli-and-node-daemon.md` §4.2，并完成 Mutation Gate 与本机真实 `agy` `project_id` 实测）

- [x] Web 任务中心桌面端 UI/UX 审查与优化：补齐下发任务完整 CLI 命令预览/复制与通知通道配置及状态徽章；重构「节点控制 -> 已上报工作区」完整路径展示、关键词筛选、一键复制路径与直接派发；修复 `.ahub-markdown` 排版、多工作区折叠、结构化过程事件展开与 WebSocket 状态单调合并（[apps/web](./apps/web)）
- [x] 将节点上的安装/更新过程包装成一段可直接丢给 Agent 完成的自举 Prompt（交付 `GET /dl/bootstrap.md` 自举指南、`ahub node init` / `ahub node status` 幂等脱敏原语、Linux 服务升级重启与 macOS 隔离属性清理、Web「接入节点」弹窗修复与 Prompt 复制，以及 [README.md](./README.md) 入口文档更新）
- [x] 多 Bot 独立加密 Webhook 投递与 `client` API Key 节点亲和绑定（`0002_multi_bot_webhooks.sql`、AES-256-GCM 密文存储、队列按触发 Key 路由）
- [x] Cloudflare Access 单域名零口令鉴权（同源 `CF_Authorization` Cookie 自动提取、RS256 JWKS 验签、非幂等请求与 WebSocket 升级跨站防护、前端 `/api/v1/auth/me` 自动探活）
- [x] macOS `AhubDaemon.app` 固定签名（CDHash）TCC 宿主包装、`SIGHUP` 优雅排空热重载，以及 `ahub node serve` 握手/心跳/工作区扫描防假死自愈机制
