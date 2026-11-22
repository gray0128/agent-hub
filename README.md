# <img src="apps/web/public/icons/icon.svg" width="28" height="28" alt="" valign="middle" /> agent-hub

`agent-hub` 是面向多设备、多本地 Coding Agent 的云端任务中心与跨机调度底座。云端控制面运行于 Cloudflare（Workers、Static Assets、D1、Durable Objects WebSocket Hibernation 与 Queues，默认实例域名 `https://ahub.bobocai.win`，可通过 `AHUB_URL` 自定义），边缘节点与调用端统一使用零外部依赖的 Go 静态单二进制 `ahub`。本文档说明节点自举安装与更新方式、仓库结构与规格文档索引。

## 核心设计原则

1. **Web 任务中心独立完备**：不依赖任何外部聊天机器人，浏览器端即可独立完成「协同板」（四栏看板、主题时间线与统一待办收件箱）、多机节点监控、任务派发、多轮会话续接、流式输出查看、权限审批跳转、拖拽编排队列与整树任务取消。
2. **跨机协同板与阻塞问答**：除受控任务流外，支持跨机共享结构化协同主题（5 态 `todo` / `in_progress` / `blocked` / `done` / `archived`、`external_ref`、`handoff` / `question` / `answer` / `artifact` 消息）与阻塞提问/人工应答（`ahub board ask --wait` / `ahub board wait`），并由系统自动在任务中心「收件箱」聚合待处理提问。
3. **统一 CLI 赋能任意 Agent**：外部助手（如 Grok Bot）与各机器上的本地 Agent 均通过同一个 `ahub` CLI 及配套 `SKILL.md` 调用任务中心与协同板，不再手拼 HTTP 请求或解析临时文本标记。
4. **纯出站零隧道节点**：各工作机无需公网 IP，也无需部署 `cloudflared`。本地守护进程 `ahub node serve` 仅维持单条出站 `wss://` 长连接并与云端 D1 租约状态机配合，确保机器休眠或断网期间的任务持久入队、上线自动补领。
5. **严格前端工程约束**：Web 控制台锁定 `shadcn/ui`（`radix-nova` 预设）、`lucide-react`、`motion/react`、`react-resizable-panels`、`@dnd-kit` 与 `zustand` 的「每类职责唯一库」白名单，组件源代码完全可控，杜绝重复依赖与模板化样式膨胀。

## 节点安装与日常更新（一句话 Agent 自举）

### 一句话交给本地 Agent 自动完成（推荐）

无论节点机器是**首次接入**还是**已有旧版需要升级**，直接将以下固定提示词复制给目标机器上的任意本地 Coding Agent（如 Antigravity、Claude Code、CodeBuddy、Cursor、Trae、Pi、OMP 或 Codex）：

```text
请读取 https://ahub.bobocai.win/dl/bootstrap.md 中的最新节点自举说明，直接代我完成本机 ahub 程序与配套技能的检测、下载安装或版本更新；若本机已配置节点守护则重启服务使新版本生效，若首次接入则自动完成基础初始化并引导我补齐节点 Token 启动系统托管服务。
```

- **自建域名**：若控制面部署在自定义域名，只需将提示词中的 `https://ahub.bobocai.win` 替换为对应的 `AHUB_URL`。
- **控制台一键带入 Token**：在 Web 控制台顶部点击「接入节点」，输入节点名称并签发 `node` Token 后，弹窗会自动生成已预填 `HUB_URL`、`node_id` 与节点 Token 的指令，可直接复制发给目标主机 Agent 一步完成激活。
- **自动分流与安全边界**：
  - **首次接入新节点**：Agent 自动拉取对应架构的零依赖 `ahub` 二进制（校验 `SHA-256` 并清理 macOS 隔离属性）、同步 `SKILL.md`、执行 `ahub node init` 自动探测主机名、工作区根目录与本机已安装 Agent（生成 `0600` 权限 `~/.config/ahub/node.json`），并通过 `--token-stdin` 写入节点 Token 后调用 `ahub node service install --activate` 启用系统托管（macOS `LaunchAgent` / Linux `systemd --user`）。
  - **已接入节点日常更新**：Agent 自动运行 `ahub update --json` 原地原子替换二进制并刷新 `SKILL.md`，执行 `ahub node init --json` 幂等补齐新装 Agent，再通过 `ahub node service install --activate --json` 重启守护进程使新版立即接管，全程保留既有 `node_id`、Token 与工作区配置。
  - **凭据隔离**：`bootstrap.md` 要求 Agent 全程严禁读取或打印 `~/.config/ahub/node.json` 与 `~/.config/ahub/credentials` 原文；状态探查统一使用脱敏的 `ahub node status --json`，节点 Token 仅通过标准输入管道传入。

### 终端手工安装与升级（兜底参考）

- **首次安装并接入节点**（macOS / Linux）：
  ```sh
  curl -fsSL https://ahub.bobocai.win/dl/install.sh | sh
  ahub skill install
  printf '%s' '<NODE_TOKEN>' | ahub node init --id <node_id> --token-stdin
  ahub node service install --activate
  ```
- **已接入节点原地升级并重启服务**：
  ```sh
  ahub update && ahub skill install && ahub node service install --activate
  ```
- **仅作为调用端 CLI 授权**（不运行节点守护进程）：
  ```sh
  curl -fsSL https://ahub.bobocai.win/dl/install.sh | sh
  ahub skill install
  printf '%s' '<CLIENT_OR_ADMIN_TOKEN>' | ahub auth login --url https://ahub.bobocai.win --token-stdin
  ```

## 外部助手接入（Grok Bot / 纯调用端自举）

云端助手（如 Grok Bot）或无节点守护职责的纯调用端环境，必须使用面向 `client` 角色的专属自举指南 `/dl/client-bootstrap.md`（而非节点端 `/dl/bootstrap.md`）：

- **角色与守护隔离**：严禁在云端 Bot 容器内执行 `ahub node init`、`ahub node serve` 或 `ahub node service`，统一使用 `ahub --url <HUB_URL> update --no-restart` 原地升级。
- **多 Bot 共享计算机 `$HOME` 防串台**：同一账号下的多个 Grok Bot 共享同一台持久云端 Linux `$HOME`。推荐为每个 Bot 独立配置平台环境变量 Secret `AHUB_TOKEN`；若使用本地文件登录，务必先导出 `AHUB_CONFIG_DIR="$HOME/.config/ahub-bots/<bot_slug>"` 再通过 `--token-stdin` 写入，避免不同 Bot 的节点白名单与加密 Webhook 互相覆盖。
- **容器冷重建自愈**：将跨机调度规范保存为 Grok Bot 平台原生 `ahub` Skill 时，自举指南会自动内置 `test -x "$HOME/.local/bin/ahub" || (curl -fsSL ... | sh && ...)` 探测头，容灾重建后首次触发即可自动恢复 CLI。
- **派单即展示指令原文**：`grok-bot` 应在调用 `ahub run` 下发任务时直接向用户展示脱敏后的下发指令正文，不再等待任务完成后由控制面或 `ahub result` 回传原始明文 `prompt`。

### 一句话交给 Grok Bot 自动接入（推荐）

若已在 Grok Bot Secrets 中填入该 Bot 专属的 `AHUB_TOKEN`（推荐无密模式），直接向 Bot 发送：

```text
请读取 https://ahub.bobocai.win/dl/client-bootstrap.md 中的最新调用端自举说明，直接代我完成本环境 ahub CLI 与配套 SKILL.md 的安装或升级（注意跳过节点守护重启）；校验 AHUB_TOKEN 连通性与可访问节点列表，并将该跨机调度规范保存为当前平台的「ahub」技能以便后续持续复用（全程严禁输出任何密钥原文）。
```

也可在 Web 控制台「密钥与 Webhook 管理」签发或查看 `client` Key，或点击顶部「接入节点 -> 接入 Bot / Skill」，一键复制已预填当前 `HUB_URL` 与隔离目录的一步自举提示词。

### 配套 Grok Bot Webhook Routine 回调指令

为 Bot 配置异步 Webhook 通知（配合 `ahub run --notify grok`）后，在对应 Routine Prompt 中填入以下处理规范：

```text
收到 agent-hub 的 `ahub_run_completed` 或 `ahub_native_event` Webhook 事件后，按以下规则处理并回复用户：
1. 若环境重建导致 `$HOME/.local/bin/ahub` 不存在，先执行：`export PATH="$HOME/.local/bin:$PATH"; test -x "$HOME/.local/bin/ahub" || (curl -fsSL https://ahub.bobocai.win/dl/install.sh | AHUB_URL=https://ahub.bobocai.win sh)`。
2. 收到 `ahub_run_completed` 汇报任意状态时，严禁再调 `ahub result` 拉取原始 `prompt`（完整指令已在派单时向用户展示），可按需引用事件中的脱敏 `prompt_preview` 作为只读上下文提示，严禁包含令牌、密码或其他凭据。
3. 当 `ahub_run_completed` 的 `status` 为 `needs_approval`：立即把事件中的 `remote_control_url` 原样发给用户，引导其打开放行或人工审批，并可附带事件中的脱敏 `prompt_preview` 提示。
4. 当 `ahub_run_completed` 的 `status` 为 `done`：汇报结果 `summary`、可续聊的 `thread_id` 与必要时的脱敏 `prompt_preview` 提示；若事件输出被截断且确需完整细节，调用 `ahub result <run_id> --full --json` 拉取完整输出后再总结。
5. 当 `ahub_run_completed` 的 `status` 为 `failed` 或 `cancelled`：清晰说明失败原因（`error_code` / `error_message`）、`run_id` 与必要时的脱敏 `prompt_preview` 提示。
6. 当收到 `ahub_native_event`（本地 Agent 原生会话通知）：仅作只读转达，展示 `node_id`、`agent`、`event_kind`（`interaction_needed` / `turn_summary`）、`workdir` 与脱敏后的 `title` / `summary`，严禁代用户审批、自动回复或发起新任务。
7. 回调轮内禁止擅自循环重试或嵌套调用 `ahub run`。
```

> **提示**：若 Grok Bot 中文桌面端在 Routine 详情面板未显示 Webhook URL 与 Bearer Key 字段，可使用同一账号访问 [`cursor.com/automations`](https://cursor.com/automations) 获取对应的 Webhook URL 与 Bearer Key，再填入 Web 控制台「API Keys 与 Bot Webhook 管理」。

## 仓库结构

```text
agent-hub/
├── AGENTS.md                         # 项目级契约治理、Go/前端门禁与安全准则
├── README.md                         # 项目入口、节点自举指南与文档索引
├── TODO.md                           # 项目待办与完成记录
├── apps/
│   ├── hub-worker/                   # Cloudflare Worker API、D1 迁移、DO NodeHub、Queue 消费者与 /dl/{bootstrap,client-bootstrap}.md
│   └── web/                          # React 19 + Vite + shadcn/ui (radix-nova) 控制台
├── cmd/
│   └── ahub/                         # Go CLI 与守护进程统一入口
├── internal/
│   ├── api/                          # REST 与 WebSocket 客户端
│   ├── cli/                          # 调用端命令实现（run / plan / retry / wait / result / cancel / resolve / nodes / board / activity / native-emit / auth）
│   ├── config/                       # 本地配置与 0600 凭据读写
│   ├── daemon/                       # node serve 守护循环、心跳续租与本地 workdir 互斥锁
│   ├── runner/                       # 进程组隔离、最小环境变量白名单与 Agent 适配器
│   ├── selfupdate/                   # SHA-256 原子自更新
│   └── service/                      # macOS LaunchAgent 与 Linux systemd --user 托管生成
├── skills/
│   └── ahub/
│       └── SKILL.md                  # 嵌入 ahub 二进制的 Agent 调用指南
├── evals/
│   ├── substrate/                    # Plane 1：ahub-fakeagent 与 I-1~I-15 混沌不变量套件
│   ├── formal/                       # Plane 1：D1/DO/Cron 状态机 TLA+ 模型检验
│   ├── agent-cli/                    # Plane 2：盲测沙箱、E-01~E-13 黄金场景与轨迹评分器
│   └── web/                          # Plane 3：前端反模式扫描与 CDP 运行时压测脚本
└── docs/
    ├── 01-architecture.md
    ├── 02-data-and-state-contracts.md
    ├── 03-api-and-ws-protocol.md
    ├── 04-ahub-cli-and-node-daemon.md
    ├── 05-web-frontend-spec.md
    ├── 06-roadmap-and-verification.md
    ├── 07-eval-framework.md
    └── schemas/
        ├── board.schema.json
        ├── native-event.schema.json
        ├── plan-create.schema.json
        ├── run-create.schema.json
        ├── run-record.schema.json
        └── ws-frames.schema.json
```

## 规格文档导航

| 文档 | 覆盖内容 | 适用读者 |
| --- | --- | --- |
| [01-architecture.md](docs/01-architecture.md) | 总体拓扑、Cloudflare 组件选型、物理会话亲和性、双保险投递、防递归门禁与三级权限模型 | 架构评审与全栈开发者 |
| [02-data-and-state-contracts.md](docs/02-data-and-state-contracts.md) | D1 SQLite DDL、状态机转换矩阵、CAS 条件、租约超时回收与 `workdir` 并发隔离契约 | 后端与存储实现者 |
| [03-api-and-ws-protocol.md](docs/03-api-and-ws-protocol.md) | REST API 端点、DO WebSocket 双向帧协议、Cloudflare Queues 通知载荷与标准错误码 | 前后端与 CLI 开发者 |
| [04-ahub-cli-and-node-daemon.md](docs/04-ahub-cli-and-node-daemon.md) | Go 单二进制 `ahub` 模块结构、调用端命令与退出码、`node serve` 适配器规范与 `SKILL.md` | Go 工程师与 Agent 集成方 |
| [05-web-frontend-spec.md](docs/05-web-frontend-spec.md) | 前端依赖白名单、`radix-nova` 视觉规范、三栏可调布局、`@dnd-kit` 拖拽与 `zustand` 状态切片 | 前端工程师与 UI 生成 Agent |
| [06-roadmap-and-verification.md](docs/06-roadmap-and-verification.md) | `wrangler.jsonc` 蓝图、Cloudflare 配额核算、四阶段可验证切片与端到端验收矩阵 | 实施与测试负责人 |
| [07-eval-framework.md](docs/07-eval-framework.md) | 基于第一性原理的三平面评测框架（底座不变量、盲测 Agent-CLI 轨迹、前端 CDP 与变异门禁） | 全栈开发与质量验收 |
| [board.schema.json](docs/schemas/board.schema.json) | 跨机协同板 REST API、主题/消息/事件与 `ErrorEnvelope` Schema | 接口校验与契约测试 |
| [native-event.schema.json](docs/schemas/native-event.schema.json) | 原生会话事件与通知投递状态 Schema | 接口校验与契约测试 |
| [plan-create.schema.json](docs/schemas/plan-create.schema.json) | `POST /api/v1/plans` 跨机 DAG 计划请求体 JSON Schema（Draft 2020-12） | 接口校验与契约测试 |
| [run-create.schema.json](docs/schemas/run-create.schema.json) | `POST /api/v1/runs` 请求体 JSON Schema（Draft 2020-12） | 接口校验与契约测试 |
| [run-record.schema.json](docs/schemas/run-record.schema.json) | `Run` 标准数据结构与 `ahub --json` 输出信封 Schema | 接口校验与契约测试 |
| [ws-frames.schema.json](docs/schemas/ws-frames.schema.json) | `/ws/node` 与 `/ws/stream` 双向 WebSocket JSON 帧联合 Schema | 协议编解码与契约测试 |

## 阅读顺序建议

1. 首次了解系统边界与设计取舍，先读 [01-architecture.md](docs/01-architecture.md)。
2. 开展 Cloudflare 后端开发前，依次核对 [02-data-and-state-contracts.md](docs/02-data-and-state-contracts.md) 与 [03-api-and-ws-protocol.md](docs/03-api-and-ws-protocol.md)。
3. 开展 Go 单二进制 `ahub` 开发，以 [04-ahub-cli-and-node-daemon.md](docs/04-ahub-cli-and-node-daemon.md) 与 [03-api-and-ws-protocol.md](docs/03-api-and-ws-protocol.md) 为准。
4. 开展 Web 任务中心前端开发，严格执行 [05-web-frontend-spec.md](docs/05-web-frontend-spec.md) 的依赖白名单与交互契约。
5. 部署与分阶段验收，遵循 [06-roadmap-and-verification.md](docs/06-roadmap-and-verification.md) 与 [07-eval-framework.md](docs/07-eval-framework.md)。
