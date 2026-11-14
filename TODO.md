# TODO

## Todo

- [ ] 修复 `agy` 会话默认落入 `CLI Project`（`default-cli-project`）导致归类错位与项目级权限失效的问题
  - **`ahub` 未传 `--project`**：在 [internal/runner/adapters.go](./internal/runner/adapters.go) 的 `BuildCommandSpec` 与 `ExecuteRun` 中，`agy` 适配器仅设置 `cmd.Dir = run.Workdir` 并组装 `--output-format json`、`--sandbox`、`--model ...`、`--effort ...`、`-p=...`，未传 `--project <id_or_name>`。
  - **项目库与会话库对比**：桌面端创建的项目定义在 `~/.gemini/config/projects/<project-uuid>.json`（绑定工作区 `file:///path/to/workspace`），桌面端会话的 `project_id` 为对应 `<project-uuid>`；`ahub` 创建的会话虽然 `workspace_uris` 同样指向该工作区 URI，但 `agy` 启动日志记录 `Conversation using project ID: default-cli-project`（对应内置 `CLI Project`），后续按 `--conversation <id>` 续聊时也会始终沿用创建时锁定的 `default-cli-project`。
  - **连带副作用**：`agy` 日志记录 `ApplyProjectPermissionGrants: no grants for project "CLI Project", cleared project permissions`；落入 `CLI Project` 不仅导致左侧栏归类错位，还会使目标项目下单独配置的项目级权限策略（Project-Level Settings）无法生效。
- [ ] 使 Web 任务中心的 Agent、模型与推理强度选项同所选 `node` 节点的本地真实配置保持一致
  - **现状根因**：前端 [apps/web/src/components/workbench/ConversationPane.tsx](./apps/web/src/components/workbench/ConversationPane.tsx) 硬编码了静态 `AGENT_OPTIONS`、`MODEL_OPTIONS` 与 `EFFORT_OPTIONS`；守护端 [internal/daemon/daemon.go](./internal/daemon/daemon.go) 的 `probeCapabilities` 仅上报 `enabled`、`available`、`default_model` 与固定 `aliases`，未采集节点侧真实模型目录及各模型支持的推理档位。
  - **各 Agent 节点侧采集路径**：`agy` 通过 `agy models` 解析账号实时可用模型与显示名，将带 `-low`/`-medium`/`-high`/`-xhigh` 后缀的型号聚合为基础模型 + 可选档位，并保留 `gemini-pro-orchestrator` 等无档位独立模型（同步调整 [internal/runner/models.go](./internal/runner/models.go) 的 `ExpandAgyModel`）；`omp` 通过 `omp models --json` 读取已配置 Provider 的 `selector`、`name` 与单模型 `thinking` 数组；`pi` 通过 `pi --list-models` 解析已配置 Provider 的 `provider/model` 列表与 `thinking` 支持标记；`codex` 读取 `~/.codex/models_cache.json`（`visibility == "list"` 的 `slug`、`display_name`、`supported_reasoning_levels`）与 `~/.codex/config.toml` 自定义 Provider，并在 [internal/runner/adapters.go](./internal/runner/adapters.go) 补齐 `codex` 推理强度参数透传；`claude` 因无原生模型列举子命令，结合 `~/.claude/settings.json`、`node.json` 可选模型配置与预设别名兜底。
  - **契约与交互约束**：按契约先行同步更新 `docs/02`–`docs/05`、`docs/schemas/ws-frames.schema.json` 与 `docs/schemas/run-create.schema.json`（评估扩展 `effort` 枚举以兼容 `ultra`、`auto` 等节点档位）；守护端须比照 `scanWorkspacesBounded` 异步限时探测并缓存模型目录，通过 `node.hello` 增量刷新上报，严禁因外部 CLI 探测耗时阻塞 WebSocket 握手；Web 端按「`node` -> `agent` -> `model` -> `effort`」四级联动展示（不支持推理档位的模型自动隐藏或禁用强度选择，离线/未知目录时允许回退默认模型或手动输入）。
- [ ] 重构 Web 左侧「节点与会话」面板（[apps/web/src/components/workbench/FleetThreadsPane.tsx](./apps/web/src/components/workbench/FleetThreadsPane.tsx)）：将上下分栏改为「会话」与「节点」双标签页切换模式，并支持按节点收起/展开其下的工作目录列表（同步更新 `docs/05-web-frontend-spec.md` 与对应前端评测断言）

## Doing

## Done

- [x] Web 任务中心桌面端 UI/UX 审查与优化：补齐下发任务完整 CLI 命令预览/复制与通知通道配置及状态徽章；重构「节点控制 -> 已上报工作区」完整路径展示、关键词筛选、一键复制路径与直接派发；修复 `.ahub-markdown` 排版、多工作区折叠、结构化过程事件展开与 WebSocket 状态单调合并（[apps/web](./apps/web)）
- [x] 将节点上的安装/更新过程包装成一段可直接丢给 Agent 完成的自举 Prompt（交付 `GET /dl/bootstrap.md` 自举指南、`ahub node init` / `ahub node status` 幂等脱敏原语、Linux 服务升级重启与 macOS 隔离属性清理、Web「接入节点」弹窗修复与 Prompt 复制，以及 [README.md](./README.md) 入口文档更新）
- [x] 多 Bot 独立加密 Webhook 投递与 `client` API Key 节点亲和绑定（`0002_multi_bot_webhooks.sql`、AES-256-GCM 密文存储、队列按触发 Key 路由）
- [x] Cloudflare Access 单域名零口令鉴权（同源 `CF_Authorization` Cookie 自动提取、RS256 JWKS 验签、非幂等请求与 WebSocket 升级跨站防护、前端 `/api/v1/auth/me` 自动探活）
- [x] macOS `AhubDaemon.app` 固定签名（CDHash）TCC 宿主包装、`SIGHUP` 优雅排空热重载，以及 `ahub node serve` 握手/心跳/工作区扫描防假死自愈机制
