# TODO

## Todo

## Doing

## Done

- [x] `RFC-0001 Slice 1b`（`912ed81`）：交付 Web 协同板四栏 `@dnd-kit` 看板（`todo`/`in_progress`/`blocked`/`done` 跨栏拖拽、列内排序与乐观回滚）、「近期主题」快速跳转与键盘快捷键面板

- [x] `RFC-0001 Slice 1a`（`9736292`）：交付跨机协同板（[0008_board_coordination_and_questions.sql](./apps/hub-worker/migrations/0008_board_coordination_and_questions.sql)、`board_topics` / `board_messages` / `board_events`、阻塞式问答 `ahub board` CLI、`--as <profile>` 归属标识、`error.next` 恢复建议、Board-First 三工作区控制台与统一「收件箱」）

- [x] `c8cb336`：上线「汇流派发枢（Mux Chevron Hub）」SVG 品牌图标与全平台 PWA 图标体系（零外部依赖 Chrome CDP 单源生成脚本 `apps/web/scripts/generate-icons.mjs` 与主题自适应 `BrandMark.tsx`）

- [x] `v0.1.8`（`6dfca57`）：治理原生通知高频噪声与合并防抖（[0007_node_default_notify_events.sql](./apps/hub-worker/migrations/0007_node_default_notify_events.sql)、`agy`/`claude`/`grok` 子代理事件过滤、`nodes.default_notify_events` 精细筛选与 `60s` 静默聚合 / `300s` 同会话冷却）

- [x] 优化 `agent-hub` Web 页面的移动端体验（补齐 `viewport-fit=cover` 与四向安全区适配、`Input`/`Textarea` 移动端 `>= 16px` 防 iOS 缩放与标识符输入属性、顶栏连接指示点/右抽屉态势角标/窄屏更多菜单、左抽屉禁用工作区拖拽并修复分叉与队列跳转抽屉收起闭环、右抽屉 5-Tab 单行横向滚动与自动定位、全量高频按钮与弹窗控件 `>= 44px` 触控热区、`MouseSensor` + `TouchSensor` 防滚动误触、Markdown 宽表局部横向滚动容器与阅读态 Composer 一键收折，同步更新 [05-web-frontend-spec.md](./docs/05-web-frontend-spec.md)、[lint-hygiene.mjs](./evals/web/lint-hygiene.mjs) 与 [cdp-runtime-eval.mjs](./evals/web/cdp-runtime-eval.mjs) 移动端评测与变异门禁）

- [x] `v0.1.7`（`71ee56a`）：交付独立「原生活动」账本与零依赖标准 Web Push 通知渠道（新增 [0006_native_activity_and_web_push.sql](./apps/hub-worker/migrations/0006_native_activity_and_web_push.sql)、`progress` 事件类型与 30 天 Cron 清理、只读 `ahub activity` CLI、统一多渠道投递明细账本 `notification_deliveries` 及单通道重推、RFC 8291/8292 [web-push.ts](./apps/hub-worker/src/web-push.ts)、零回源 [sw.js](./apps/web/public/sw.js) / [manifest.webmanifest](./apps/web/public/manifest.webmanifest) 与三栏「原生活动」视图 [NativeActivityPane.tsx](./apps/web/src/components/workbench/NativeActivityPane.tsx) / [BrowserNotifyDialog.tsx](./apps/web/src/components/workbench/BrowserNotifyDialog.tsx)）

- [x] `v0.1.6`（`e573ce4`）：扩展 `ahub native-emit` 支持 `grok` 与 `omp` 官方 Hook、`idle_prompt` 过滤及 `agy` `ask_question` 交互提问识别（[0005_native_events_allow_grok.sql](./apps/hub-worker/migrations/0005_native_events_allow_grok.sql)）

- [x] 交付节点绑定默认 Grok Bot 通知通道与 Agent 原生事件实时推送（新增 [0004_node_default_notify_and_native_events.sql](./apps/hub-worker/migrations/0004_node_default_notify_and_native_events.sql)、`POST /api/v1/nodes/:id/native-events`、`ahub native-emit` 的 `claude`/`codex`/`agy`/`pi` 官方 Hook 适配器；实现 `admin` 与 `client` 作用域隔离通知路由、`client` 节点元数据最小权限裁剪、凭据隔离及 Web 节点默认通道绑定与吊销实时失效徽章，通过 Mutation Gate 1/2、`make eval-fast` 与 `make eval-ui` Chromium CDP 实测）

- [x] 优化配套 skills 与控面边界，使 Grok Bot 在 `ahub run` 派发阶段即向用户脱敏展示下发指令正文、结束回调不拉取原始未脱敏 `prompt`，并在控制面 REST/WS/CLI 统一脱敏与限长（更新 [skills/ahub/SKILL.md](./skills/ahub/SKILL.md)、[client-bootstrap.md](./apps/hub-worker/src/client-bootstrap.md)、[OnboardingKeysDialogs.tsx](./apps/web/src/components/workbench/OnboardingKeysDialogs.tsx) 与 [README.md](./README.md)；扩展 [run-record.schema.json](./docs/schemas/run-record.schema.json) 与 `docs/02`–`05` 契约；收敛对称的 [redact.ts](./apps/hub-worker/src/redact.ts)（<=250 行）与 [redact.go](./internal/redact/redact.go)（<=250 行），保持 `POST /api/v1/nodes/:id/claim` 明文执行与 `$VAR` 占位符保留，通过 `make test-unit`、`make eval-fast`、`make eval-ui` 与 `make eval-agent` 验证）

- [x] 重构 Web 左侧「节点与会话」面板（[apps/web/src/components/workbench/FleetThreadsPane.tsx](./apps/web/src/components/workbench/FleetThreadsPane.tsx)）：将上下分栏改为「会话」与「节点」双标签页切换模式（默认「会话」并保留拖拽排序、置顶、分叉及 `tab` 选择器隔离），「节点」页全高展示在线状态/并发/可用 Agent 与一键全部收起/展开控制，并支持按节点独立收起/展开工作目录列表；同步更新 [docs/05-web-frontend-spec.md](./docs/05-web-frontend-spec.md) 与 [evals/web/cdp-runtime-eval.mjs](./evals/web/cdp-runtime-eval.mjs) 评测断言并通过 Mutation Gate 与 Chromium CDP 实测

- [x] 使 Web 任务中心的 Agent、模型与推理强度选项同所选 `node` 节点的本地真实配置保持一致（扩展 `docs/02`–`docs/05` 与 Schema `ultra`/`auto` 枚举及结构化 `capabilities.agents`；实现守护端 `internal/daemon/capabilities.go` 4s 限时非阻塞异步探测与脱敏目录缓存；补齐 `codex` `-c model_reasoning_effort`、`agy` 基础型号/独立 `orchestrator` 映射与 Web `node -> agent -> model -> effort` 四级联动；通过 Mutation Gate 1/2、`make eval-fast` 与 `make eval-ui` Chromium CDP 实测）

- [x] 修复 `agy` 会话默认落入 `CLI Project`（`default-cli-project`）导致归类错位与项目级权限失效的问题（交付 [internal/runner/agy_project.go](./internal/runner/agy_project.go) `ResolveAgyProjectID`、在 [internal/runner/adapters.go](./internal/runner/adapters.go) `BuildCommandSpec` 自动注入 `--project <project_id>`、[internal/runner/agy_project_test.go](./internal/runner/agy_project_test.go)、更新 `docs/04-ahub-cli-and-node-daemon.md` §4.2，并完成 Mutation Gate 与本机真实 `agy` `project_id` 实测）

- [x] Web 任务中心桌面端 UI/UX 审查与优化：补齐下发任务完整 CLI 命令预览/复制与通知通道配置及状态徽章；重构「节点控制 -> 已上报工作区」完整路径展示、关键词筛选、一键复制路径与直接派发；修复 `.ahub-markdown` 排版、多工作区折叠、结构化过程事件展开与 WebSocket 状态单调合并（[apps/web](./apps/web)）
- [x] 交付 Grok Bot 与纯调用端一句话自举指南及产品化接入改造（新增公开端点 `GET /dl/client-bootstrap.md`、Go CLI `ahub auth login --token-stdin` 与脱敏 `ahub auth status [--verify]`、同机多 Bot `AHUB_CONFIG_DIR` 隔离规范、Web「接入 Bot / Skill」与 `client` Key 自举词/Routine 回调词一键生成，以及 `docs/03`–`05` 与 `README.md` 文档同步，通过 Mutation Gate、`make eval-fast` 与 `make eval-ui` 实测）
- [x] 将节点上的安装/更新过程包装成一段可直接丢给 Agent 完成的自举 Prompt（交付 `GET /dl/bootstrap.md` 自举指南、`ahub node init` / `ahub node status` 幂等脱敏原语、Linux 服务升级重启与 macOS 隔离属性清理、Web「接入节点」弹窗修复与 Prompt 复制，以及 [README.md](./README.md) 入口文档更新）
- [x] 多 Bot 独立加密 Webhook 投递与 `client` API Key 节点亲和绑定（`0002_multi_bot_webhooks.sql`、AES-256-GCM 密文存储、队列按触发 Key 路由）
- [x] Cloudflare Access 单域名零口令鉴权（同源 `CF_Authorization` Cookie 自动提取、RS256 JWKS 验签、非幂等请求与 WebSocket 升级跨站防护、前端 `/api/v1/auth/me` 自动探活）
- [x] macOS `AhubDaemon.app` 固定签名（CDHash）TCC 宿主包装、`SIGHUP` 优雅排空热重载，以及 `ahub node serve` 握手/心跳/工作区扫描防假死自愈机制
