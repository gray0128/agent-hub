# 04 Go 单二进制 `ahub` 与 Skill 规格

`ahub` 是使用 Go 1.24+ 编写的零外部依赖静态单二进制（`CGO_ENABLED=0`），同时承担「调用端 CLI」与「节点守护端 `ahub node serve`」两项职能。无论是运行在云端容器的外部助手（如 Grok Bot）、各台工作机上的本地 Coding Agent，还是常驻后台接收任务的节点守护进程，全部共享同一份可交叉编译的可执行文件。

## 1. 模块布局与构建契约

```text
cmd/ahub/main.go                 # 根命令分发与全局标志解析（--url / --token / --json）
internal/
├── config/                      # 读取 ~/.config/ahub/{credentials,node.json}（支持 AHUB_CONFIG_DIR 覆盖）
├── api/                         # REST 客户端 + /ws/node 与 /ws/stream WebSocket 客户端
├── cli/                         # 调用端命令（nodes / run / wait / result / resolve / cancel / threads / runs / activity / native-emit / skill / update）
├── daemon/                      # node serve 主循环、断线抖动退避重连、heartbeat 续租、needs_approval 租约驻留、本地 workdir 互斥锁、node.reload 哨兵监听
├── runner/                      # 进程组管控（Setpgid）、最小环境变量白名单、agy/pi/omp/codex/claude 适配器
├── service/                     # macOS LaunchAgent plist、Linux systemd --user unit 与 Windows ahub-shim.exe + schtasks 生成与启停
└── selfupdate/                  # /dl/version.json 校验、SHA-256 核对与跨平台原子自替换
skills/ahub/SKILL.md             # 通过 go:embed 内嵌于二进制中
```

### 跨平台编译目标

- `darwin/arm64`、`darwin/amd64`
- `linux/amd64`、`linux/arm64`
- `windows/amd64`

构建时统一注入 `-trimpath` 与 `-ldflags="-s -w -X main.version=<tag>"`，禁用 CGO 以保证容器内与各发行版开箱即用。

## 2. 凭据与配置解析顺序

调用端与守护端遵循统一的配置优先级（高优先级覆盖低优先级）：

1. 命令行标志：`--url`、`--token`
2. 环境变量：`AHUB_URL`（默认 `https://ahub.bobocai.win`）、`AHUB_TOKEN`
3. 凭据文件：`~/.config/ahub/credentials`（可通过环境变量 `AHUB_CONFIG_DIR` 重定向配置目录，权限强制校验或写入为 `0600`，JSON 格式 `{ "url": "...", "token": "..." }`）；节点运行配置保存在同目录下的 `node.json`（仅此两文件，不存在 `config.json`）。

> **节点守护端与原生 Hook 凭证隔离例外**：`ahub node serve` 与 `ahub native-emit` 除命令行显式传入 `--url` / `--token` 外，固定仅从 `node.json` 读取 `hub_url` 与 `token`，**显式忽略**环境变量 `AHUB_URL`、`AHUB_TOKEN` 与客户端 `credentials` 文件，防止本机同时配置了调用端 `client` 凭证时触发 `403 FORBIDDEN_SCOPE`。

## 3. 调用端 CLI 命令与退出码契约

### 3.1 全局约束

- **流分离原则**：传入 `--json` 时，`stdout` 仅允许输出一个合法的 JSON 对象（包括 `ahub activity --json` 返回 `{"ok": true, "events": [...], "open_interaction_count": N, "next_cursor": ...}`）；所有调试信息、等待心跳提示与错误堆栈统一写往 `stderr`。
- **防 Shell 截断**：`ahub run` 必须支持在结尾传入 `-` 从 `stdin` 读取多行原始 Prompt，严禁要求调用方将长代码块转义后塞入命令行参数。
- **上下文窗口保护**：`ahub result <run_id>` 默认只拉取 `summary` 与尾部最多 `16 KB` 预览（附带 `"truncated": true, "output_bytes": N`），只有显式指定 `--full` 时才拉取完整 `output_md`。
- **统一 `RunRecord` 脱敏与摘要截断边界**：所有返回 `RunRecord` 的调用端命令（`run`、`wait`、`result`、`runs`、`resolve`、`cancel`）均通过统一的本地净化函数处理：清空内部字段 `lease_owner`、对 `prompt` 执行 `redact` 凭据脱敏（保留 `$VAR` 与 `<PLACEHOLDER>` 占位符，并覆盖空格传参、`X-API-Key` 与带空格引号值），并在非 `--full` 模式下将 `prompt` 截断至不超过 `1536` UTF-8 字节；仅 `ahub result <run_id> --full` 请求服务端 `?view=full` 获取完整脱敏后的 `prompt` 与 `output_md`（仅作显式诊断排查用途，外部 Bot 应在 `ahub run` 下发时直接展示指令原文），调用端 CLI 绝不返回未脱敏凭据原文。
- **共享宿主多 Bot 凭据隔离**：当多个外部助手（如同一账号下共享云端 Linux 计算机 `$HOME` 的多个 Grok Bot）共用同一宿主文件系统时，严禁将不同 Bot 的 `client` Token 混写进默认 `~/.config/ahub/credentials`；优先在各 Bot / Routine 独立环境变量中注入 `AHUB_TOKEN`，若使用本地文件登录则必须按 Bot 隔离 `AHUB_CONFIG_DIR`（如 `~/.config/ahub-bots/<bot_slug>`）并通过 `ahub auth login --token-stdin` 写入，防止节点白名单与加密 Webhook 串台。

### 3.2 核心子命令列表

| 命令与常用参数 | 功能说明 |
| --- | --- |
| `ahub auth login [--url <url>] [--token <token> \| --token-stdin] [--json]` | 调用 `GET /api/v1/auth/me` 校验并写入 `0600` 凭据至 `<AHUB_CONFIG_DIR>/credentials`（默认 `~/.config/ahub/credentials`）；支持 `--token-stdin` 从标准输入安全读取 Token，`--json` 仅返回 `ok`、`url`、`credentials_path` 与 `principal`，绝不回显明文 Token |
| `ahub auth status [--verify] [--json]` | 零密钥泄露检查当前调用端凭据状态（返回 `ok`、`url`、`config_dir`、`credentials_path`、`credentials_exists`、`has_token` 与 `token_source` (`flag` \| `env` \| `file` \| `none`)）；传入 `--verify` 时额外调用 `GET /api/v1/auth/me` 返回 `verified: true` 与 `principal` |
| `ahub nodes [--online] [--json]` | 从云端读取节点清单、在线态、可用 Agent、模型简称及项目短名列表 |
| `ahub run -n <node> -d <dir> -a <agent> [-m <model@effort>] [--thread <thr_id>] [--no-sandbox] [--timeout 15m] [--wait 45s] [--notify grok] [--idempotency-key <k>] [--json] <prompt \| ->` | 创建任务并入队（未传 `--thread` 时新建会话）。CLI 自动读取环境中的 `AHUB_RUN_ID` 作为 `parent_run_id`。支持两阶段等待预算（默认 `--wait` 为 `45s`）：第一阶段使用 HTTP 长轮询 `?wait_ms=min(wait, 45000)`；若未设 `--notify` 且仍处于运行态且 `--wait > 45s`（或服务端提前返回 `202`），第二阶段以剩余预算无缝切入 `/ws/stream` 阻塞等待；若第二阶段发生鉴权/网络等真实传输错误则直接返回对应退出码（不误报 `24`），停机态（`done`/`failed`/`cancelled`/`needs_approval`）统一带 `5s` 有界超时拉取摘要预览；输出 `RunRecord` 经统一脱敏、清空 `lease_owner` 并截断 `prompt` 至 `1536` UTF-8 字节 |
| `ahub wait <run_id> [--timeout 15m] [--json]` | 连接 `/ws/stream?run_id=<id>` 零轮询阻塞等待任务到达终态或 `needs_approval`（停机态统一带 `5s` 超时拉取摘要预览，输出 `RunRecord` 经统一脱敏、清空 `lease_owner` 并截断 `prompt` 至 `1536` UTF-8 字节） |
| `ahub result <run_id> [--full] [--tail 16384] [--json]` | 读取指定任务的结果摘要、脱敏后的指令元数据 `prompt`（默认摘要模式超出 `1536` 字节截断，传 `--full` 仅用于显式排查完整脱敏正文与 `output_md`，绝不返回未脱敏明文并清空内部 `lease_owner`）、耗时、模型、`remote_control_url` 与输出正文 |
| `ahub resolve <run_id> [--summary <text>] [--json]` | 人工在远控完成审批后，将处于 `needs_approval` 的子进程退出型任务放行结算为 `done`，释放 `(node_id, workdir)` 租约与本地目录锁并继续调度排队任务（输出 `run` 经统一脱敏、清空 `lease_owner` 并截断 `prompt` 至 `1536` UTF-8 字节） |
| `ahub runs [--node <n>] [--status <s>] [--limit 20] [--json]` | 查看任务队列与历史列表（每条 `RunRecord` 均清空 `lease_owner`、对 `prompt` 脱敏并截断至 `1536` UTF-8 字节） |
| `ahub threads [--node <n>] [--q <keyword>] [--json]` | 查询历史会话线程 ID 以便跨轮续接 |
| `ahub activity [--node <n>] [--agent <a>] [--kind interaction_needed\|turn_summary\|progress] [--unacked] [--limit 20] [--json]` | 只读巡检各节点本地原生交互式会话活动记录（调用 `GET /api/v1/native-events`）；仅限 `admin` Scope 凭证调用（`client` / `node` 凭证一律返回 `403 FORBIDDEN_SCOPE`，退出码 `78`）；`--json` 时 `stdout` 仅输出单个合法 JSON 对象 |
| `ahub cancel <run_id> [--cascade] [--reason <text>] [--json]` | 取消单个任务；加 `--cascade` 时级联终止整棵 `root_run_id` 任务树（`cancelled_runs[]` 中每条 `RunRecord` 均经统一脱敏、清空 `lease_owner` 并截断 `prompt` 至 `1536` UTF-8 字节） |
| `ahub native-emit [--from-hook claude\|codex\|agy\|pi\|omp\|grok\|cli] [--config <path>] [--agent <a>] [--kind interaction_needed\|turn_summary\|progress] [--event-id <id>] [--session-id <sid>] [--dir <path>] [--title <text>] [--source <s>] [--summary <text\|->] [--include-transcript-summary] [--json]` | 供本机 Agent 官方 Hook / 扩展或长耗时任务主动里程碑调用：在 `node.json` 显式启用 `native_notify.enabled` 时，将脱离 `ahub` 运行的本地会话互动、回合总结或阶段里程碑（`--kind progress`）脱敏上报至 `POST /api/v1/nodes/:id/native-events`；严禁挂载 `PreToolUse` / `PostToolUse` 等高频工具调用钩子；若检测到 `AHUB_RUN_ID` / `AHUB_DEPTH` 非空或 Hook 重入标记则立即静默跳过防双推与循环；凭证仅读取 `--url` / `--token` 或 `node.json`（忽略 `AHUB_TOKEN` / `AHUB_URL` 与客户端 `credentials`） |
| `ahub skill print \| install [--dir <path>]` | 打印内嵌 `SKILL.md`，或将其安装到指定 Agent Skill 目录（如 `~/.agents/skills/ahub/SKILL.md`） |
| `ahub update [--check] [--target <path>] [--no-restart] [--json]` | 查询 `/dl/version.json` 并校验 SHA-256 原子替换当前二进制；默认在更新本机活跃二进制后自动向运行中的 `ahub node serve` 触发优雅排空重启（Unix 发 `SIGHUP`，Windows 写 `node.reload` 哨兵），或在未运行进程间回退系统服务重载（`--no-restart` 或指定 `--target` 时跳过重启） |
| `ahub node init [--id <node_id>] [--name <display_name>] [--url <hub_url>] [--token <token> \| --token-stdin] [--root <dir> ...] [--max-concurrency <n>] [--config <path>] [--force] [--json]` | 幂等创建或更新 `0600` 权限 `~/.config/ahub/node.json`，自动探测主机名、已有工作区根目录与本机已安装 Agent（`agy`/`pi`/`omp`/`codex`/`claude`），`--json` 输出脱敏（仅含布尔值 `has_token`） |
| `ahub node status [--config <path>] [--target-dir <dir>] [--json]` | 零密钥泄露检查节点配置文件、工作区根、已启用 Agent、`has_token`、系统服务托管状态及 macOS `AhubDaemon.app` 签名与代码目录一致性，供 Agent 自举与巡检调用 |
| `ahub node service install\|uninstall\|status [--bin <path>] [--config <path>] [--target-dir <dir>] [--recreate-app] [--activate] [--json]` | 生成、卸载或查询 macOS `LaunchAgent`（含冻结一次签名的 `~/Applications/AhubDaemon.app` 启动壳）、Linux `systemd --user` 单元与 Windows `ahub-node-runner.cmd` + `AhubNodeDaemon` 计划任务（配独立副本 `ahub-shim.exe`）；指定 `--activate` 时加载并重启守护进程使新版本立即生效；指定 `--recreate-app` 时显式重建 `.app` 壳 |

### 3.3 标准退出码

| 退出码 | 含义 | 适用场景与后续动作 |
| --- | --- | --- |
| `0` | 成功或已安全转交后台通知 | 任务到达 `done`；或指定 `--notify` 后超出 `--wait` 窗口，任务继续在后台跑并在 JSON 中返回 `"status": "running", "webhook_armed": true` |
| `10` | 任务执行失败 | 目标 `Run` 到达 `failed`（含节点租约过期或子进程非零退出） |
| `20` | 等待人工审批 | 目标 `Run` 到达 `needs_approval`，输出中包含 `remote_control_url`，应立即向用户展示放行链接 |
| `24` | 等待超时 | 未设置 `--notify` 的 `ahub run --wait` 或 `ahub wait` 达到等待上限，任务仍在执行中，可稍后用 `ahub wait` 续等 |
| `64` | 参数或目录解析错误 | 缺少必填参数、项目短名不存在（`WORKDIR_NOT_FOUND`）或重名需消歧（`WORKDIR_AMBIGUOUS`，输出候选路径） |
| `75` | 网络临时错误 | DNS、TLS 或控制面 `5xx` 瞬时不可达，支持调用方安全重试 |
| `78` | 策略拦截 | 递归深度超限（`DEPTH_LIMIT_EXCEEDED`）、环路检测拦截（`DELEGATION_CYCLE_DETECTED`）或 Token Scope 越权（`FORBIDDEN_SCOPE`，如 `client` / `node` 凭证调用 `admin` 专属的 `ahub activity`） |

## 4. 节点守护端 `ahub node` 规格

### 4.1 节点本地配置文件（`~/.config/ahub/node.json`）

```json
{
  "node_id": "macmini",
  "display_name": "Mac mini",
  "hub_url": "https://ahub.bobocai.win",
  "max_concurrency": 4,
  "project_roots": [
    "~/workspace",
    "~/projects"
  ],
  "skip_dirs": [
    "Library",
    "Applications",
    "node_modules"
  ],
  "remote_control_name": "macmini",
  "native_notify": {
    "enabled": false,
    "allowed_roots": [
      "~/workspace",
      "~/projects"
    ],
    "include_transcript_summary": false,
    "events": [
      "interaction_needed",
      "turn_summary",
      "progress"
    ]
  },
  "agents": {
    "agy": {
      "enabled": true,
      "command": "agy",
      "default_model": "gemini-4-hydrogen-high"
    },
    "pi": {
      "enabled": true,
      "command": "pi"
    },
    "omp": {
      "enabled": true,
      "command": "omp"
    },
    "codex": {
      "enabled": false,
      "command": "codex"
    },
    "claude": {
      "enabled": false,
      "command": "claude",
      "models": [
        "opus",
        "sonnet",
        "haiku"
      ]
    }
  }
}
```

### 4.2 多 Agent 适配器契约

节点守护进程统一在 `internal/runner` 中封装各本地 CLI 的无头调用、模型别名展开、思考强度映射与结构化输出解析：

| Agent | 无头调用命令模板 | 会话续接参数 | 输出解析规则 |
| --- | --- | --- | --- |
| `agy` | `agy --output-format json [--sandbox] [--project <project_id>] [--model <m>] [--effort <e>] [--print-timeout <t>] -p=<prompt>` | `--conversation <native_session_id>` | 解析单对象 JSON 提取 `status`、`conversation_id`、`response`、`error`；**严禁采信返回的累计耗时，必须由 Go 守护端 `time.Since(startedAt)` 单调计时**；当 `status == "NEEDS_HUMAN_APPROVAL"` 时只读探测远控守护状态（严禁调用 `start` 覆写系统守护配置）并回填 `remote_control_url`，不可达时保持空串并在结果摘要与诊断事件中注明原因 |
| `pi` | `pi --mode json -p --approve [--model <m>] [--thinking <e>] <prompt>` | `--session <native_session_id>` | 按白名单逐行解析 v3 NDJSON 事件流：从 `session.id` 提取 `native_session_id`；将 `tool_execution_start` 映射为精简 `tool_use`（仅保留 `tool`、`tool_call_id` 与截断至 `512` 字符的 `command`/`path`/`file`/`summary`）；仅在 `tool_execution_end` 且 `isError == true` 时上报 `stderr_warn`；`turn_end` 提取 `provider/model` 与思考/用量摘要并剥离 `toolResults` 与完整消息体；静默丢弃 `message_update`、`tool_execution_update`、`agent_start`、`turn_start`、`message_start`、`message_end` 等高频流式增量（仅在内存缓冲 `text_delta` 供取消时恢复已生成正文）；从 `agent_end`/`message_end` 提取最终助手文本（仅限 `role == "assistant"` 且 `type == "text"` 分片），中途取消时严禁将原始 NDJSON `stdout` 落库为 `output_md` |
| `omp` | `omp --mode=json -p --auto-approve --max-time=<t> [--model=<m>] [--thinking=<e>] <prompt>` | `--resume=<native_session_id>` | 同 `pi`，按白名单逐行解析 v3 NDJSON 事件流、静默过滤流式 delta 并实时映射精简工具/轮次事件 |
| `codex` / `claude` | `codex exec --json [-m <m>] [-c model_reasoning_effort="<e>"]` / `claude -p --output-format json [--model <m>] [--effort <e>]` | `codex exec resume --json [-m <m>] [-c model_reasoning_effort="<e>"] <native_session_id> -` / `--session-id <id>`（`claude` 若传 `effort` 且非 `auto`/`off`，同样透传 `--effort <e>`） | `codex` 解析 `thread.started`（会话 ID）、`item.started`（`command_execution`/`mcp_tool_call`/`file_change`/`web_search` 映射为精简 `tool_use`）、丢弃 `item.updated`（仅在内存更新 `agent_message` 缓冲）、从 `item.completed`（`agent_message`）提取 `output_md`、`turn.completed` 映射精简 `turn_end`、`turn.failed`/`error` 标记失败；`claude` 解析 `result`（提取正文与 `session_id` 并处理 `is_error`），实现多引擎统一抽象 |

#### `agy` 项目归属解析规则

- 若 `agents.agy.args` 中尚未显式指定 `--project` 或 `--new-project`，`BuildCommandSpec` 会扫描 `~/.gemini/config/projects/*.json`（忽略 `default-cli-project`），将 `run.Workdir` 与各项目中的 `projectResources.resources[].folderUri` 及 `gitFolder.folderUri` 匹配，并按「精确目录匹配优先于最长父目录匹配 -> 完整项目（`!isWorkspaceOnly`）优先 -> 含项目级权限或配置优先 -> `id` 字典序」择优注入 `--project <project_id>`，避免新建或续聊会话落入 `CLI Project`（`default-cli-project`）导致归类错位与项目级权限失效。

#### 模型简称、本地目录采集与思考强度映射表

- 思考强度支持标准值：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra`、`auto`（同步兼容 `carbon@high` 合写语法）。
- `agy` 家族自动展开：支持短别名（`carbon` -> `gemini-4-carbon-<effort>`、`argon` -> `gemini-4-argon-<effort>`、`hydrogen` -> `gemini-4-hydrogen-<effort>`、`flash` -> `gemini-3.8-flash-<effort>`、`opus` -> `claude-opus-5-5-<effort>`、`sonnet` -> `claude-sonnet-5-5-<effort>`）以及完整基础模型 ID（如 `gemini-4-carbon`、`gpt-oss-120b`）按所选 `effort` 展开；若 `default_model` 自带 `-low`/`-medium`/`-high`/`-xhigh`/`-max` 后缀且调用显式指定 `effort`，则替换后缀并保留兼容档位夹逼（除 `gemini-4-hydrogen` 原生支持 `xhigh` 外，已知家族其余型号的 `xhigh`/`max` 自动对齐 `-high`）；对于 `gemini-pro-orchestrator*` 等无档位独立模型，保持原 ID 不追加后缀且不传递 `--effort`。`ahub node init` 初始化及节点省略 `agents.agy.default_model` 时，`agy` 默认模型统一为 `gemini-4-hydrogen-high`（上报 `default_model: "gemini-4-hydrogen"`、`default_effort: "high"`）。
- 节点侧各 Agent 模型目录采集路径：
  - `agy`：执行 `agy models` 解析账号实时可用型号与显示名，将同源 `-low`/`-medium`/`-high`/`-xhigh`/`-max` 条目聚合为基础模型 ID + 可选 `efforts[]`，保留 `gemini-pro-orchestrator*` 等独立模型（`efforts: []`）。
  - `omp`：执行 `omp models --json` 读取已配置 Provider 的 `selector`、`name` 与单模型 `thinking` 数组。
  - `pi`：执行 `pi --list-models` 解析 `<provider>/<model>` 与 `thinking` 标记（`yes` 对应 `off..max`）。
  - `codex`：读取 `~/.codex/config.toml`（`model`、`model_reasoning_effort`、`model_catalog_json` 与 `[model_providers.*]`）及 `~/.codex/models_cache.json`（过滤 `visibility == "list"` 条目，提取 `slug`、`display_name`、`default_reasoning_level` 与 `supported_reasoning_levels`），不向外上报任何密钥或鉴权 URL。
  - `claude`：读取 `~/.claude/settings.json` 中的 `model` 与模型名称环境变量（`ANTHROPIC_MODEL`、`ANTHROPIC_REASONING_MODEL`、`ANTHROPIC_DEFAULT_*_MODEL`），合并 `node.json` 的可选 `agents.claude.models`、`default_model` 与 `opus`/`sonnet`/`haiku` 预设；默认申报 `efforts: ["low", "medium", "high", "max"]`（`default_effort: "high"`），运行命令透传 `--effort <e>`（`auto` / `off` 或被 `agents.claude.args` 手动覆盖时省略）。
- `pi` / `omp` 省略 `model` 时保持各自本机默认配置文件选择，也可传 `provider/model` 全称。

### 4.3 守护生命周期、进程组隔离与系统托管

1. **连接与自愈**：`ahub node serve` 主动建立 `wss://<hub_url>/ws/node`（`DialWebSocket` 升级握手限时 `20s`，`node.hello -> hub.welcome` 首帧握手限时 `15s`），发送 `node.hello` 后立即执行 `POST /api/v1/nodes/:id/claim` 清扫积压任务；本地工作区扫描限时 `5s`（单飞后台协程防泄漏，若因外置盘休眠或 TCC 弹窗超时，先携带已缓存或空工作区列表完成上线并输出告警日志，待后台扫描返回后自动补发 `node.hello` 刷新工作区）；各 Agent 本地模型目录采集采用同类单飞异步探测（单 CLI 命令限时 `4s`、基于 `BuildBaseSanitizedEnv` 剥离 `AHUB_TOKEN` 并在超时后强杀独立进程组，结果缓存 `10m`），首帧 `node.hello` 绝不阻塞在外部 CLI 探测上，待后台目录采集就绪后自动补发 `node.hello` 增量刷新；心跳周期同时执行带 `10s` 超时的底层 WebSocket `Ping/Pong` 探活与 `node.ping` 写校验，超时或写失败立即主动断开进入退避重连；断线时采用 `1s -> 2s -> 4s ...`（上限 `30s` + 随机抖动）指数退避重连，重连成功必定重新扫描队列。
2. **本地 `workdir` 互斥与并发**：守护端维护按规范化 `workdir` 键控的本地锁，同一目录同时只允许运行一个任务，不同目录并发度受 `max_concurrency` 控制。
3. **环境变量隔离与血统注入**：
   - 拉起子进程时构建干净环境变量列表，仅保留最小运行时集合（`PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`LANG`、`LC_ALL`、`TMPDIR`、`TERM`、`SSH_AUTH_SOCK`、`XDG_*`）。
   - **严禁**将节点自身的 `AHUB_TOKEN` 透传给子进程；若本机允许子 Agent 发起跨机委派，须在配置文件显式配置低权限 `client` Scope 的 `delegation_token` 写入子进程 `AHUB_TOKEN`。
   - 强制注入：`AHUB_RUN_ID`、`AHUB_THREAD_ID`、`AHUB_ROOT_RUN_ID`、`AHUB_DEPTH`（子进程调 `ahub run` 时自动携带，供云端拦截递归）。
4. **独立进程组强杀**：Unix 平台设置 `SysProcAttr{Setpgid: true}`。收到 `hub.abort` 或超时时，向 `-pgid` 发送 `SIGTERM`，等待 `5 秒` 后未退出则向 `-pgid` 发送 `SIGKILL`，防止孤儿进程残留持锁。
5. **系统托管、TCC 持久化与升级后自动平滑重载（`ahub node service install` / `ahub update`）**：
   - **macOS 固定签名壳 `AhubDaemon.app`**：首次执行 `ahub node service install` 时在 `~/Applications/AhubDaemon.app` 生成轻量静态可执行壳并执行一次 ad-hoc `codesign --identifier win.bobocai.ahub.daemon --force --deep --sign -`（默认幂等冻结，不再于日常 `ahub update` 时覆写 `.app` 主二进制与 `CDHash`，除非显式传入 `--recreate-app`）。`LaunchAgent` `~/Library/LaunchAgents/win.bobocai.ahub.node.plist` 通过 `<bin_in_app> node shim --bin <~/.local/bin/ahub> --config <node.json>` 启动守护进程，使系统只需对 `AhubDaemon.app` 授予一次「完全磁盘访问权限」，后续 `ahub update` 替换 `~/.local/bin/ahub` 时外置盘 TCC 授权持续有效。
   - **升级后优雅排空重载（`SIGHUP` / `node.reload` 哨兵 + Exit Code `42`）**：`ahub node serve` 写明自身 PID 到 `~/.config/ahub/node.pid`（支持 Unix `SIGHUP` 与跨平台 `<config_dir>/node.reload` 哨兵文件）；收到排空信号后立即停止接收新任务，等待当前活跃子进程与已托管审批完成并回传云端终态后，优雅关闭 WebSocket 并以退出码 `42`（`ExitReload`）退出；外层 `ahub node shim` 捕获退出码 `42` 后在 `200ms` 后立即重新拉起磁盘上的新版本 `<bin> node serve`（macOS 原生 `spawn` 继承 `AhubDaemon.app` 进程树与 TCC 权限；若为直连 `LaunchAgent`/`systemd` 则回退由服务管理器按退出重启或 `launchctl kickstart -k` / `systemctl --user restart`）。
   - **远程自更新防自杀保护**：当 `ahub update` 处于远程任务子进程环境（`AHUB_RUN_ID` 非空）触发时，仅向在线 `node.pid` 发送排空信号（Unix 发 `SIGHUP`，Windows 写 `node.reload`），确保当前任务报告完 `done` 再退出重启，严禁在任务执行途中强杀父守护进程。
   - **Linux**：写入 `~/.config/systemd/user/ahub-node.service`（开启 `Restart=always` 与 `loginctl enable-linger` 提示）；`ahub update` 时同样优先发 `SIGHUP` 排空退出或空闲状态下执行 `systemctl --user restart ahub-node.service`。
   - **Windows**：`ahub node service install` 将当前二进制另存为独立监控副本 `ahub-shim.exe` 并生成 `<target_dir 或 config_dir>/ahub-node-runner.cmd`（经 `ahub-shim.exe node shim --bin <ahub.exe> --config <node.json>` 启动，避免监控父进程锁定主 `ahub.exe` 替换路径）；启用 `--activate` 时注册并运行登录触发计划任务 `AhubNodeDaemon`（`schtasks /Create /F /SC ONLOGON /TN "AhubNodeDaemon"`）。`node.pid` 存活探测通过 `tasklist /FI "PID eq <pid>" /FO CSV /NH` 解析进程名与 PID 防止假阳性；`ahub update` 通过写入 `<config_dir>/node.reload` 哨兵触发守护端排空后返回退出码 `42`，由 `ahub-shim.exe` 极速拉起新版 `ahub.exe`。

### 4.4 本地 Agent 原生 Hook 适配矩阵与隐私边界（`ahub native-emit`）

`ahub native-emit` 严格采用官方 Hook / 扩展事件推送机制及显式长耗时阶段里程碑（`event_kind` 支持 `interaction_needed`、`turn_summary` 与 `progress`，其中 `progress` 通过 `--from-hook cli` 或省略 `--from-hook` 并传入 `--kind progress --session-id <sid> --dir "$PWD" --title <text> --summary -` 触发），**默认关闭（`native_notify.enabled: false`）**，**严禁接入 `PreToolUse` / `PostToolUse` 等高频工具级钩子**，且**严禁扫描全盘会话或无关聊天/凭据文件**：

| Agent | 官方接入方式 | 已覆盖事件 | 未覆盖 / 已知限制 |
| --- | --- | --- | --- |
| `claude` | `~/.claude/settings.json`（`Notification`、`Stop` Hook） | `interaction_needed`（`Notification`，自动跳过 `idle_prompt`）、`turn_summary`（`Stop` `last_assistant_message`；自动跳过 `SubagentStop`/`SubagentEnd` 及含 `agent_id`/`subagent_type`/`parent_session_id` 的子代理事件） | 未读外部全盘历史，依赖 Hook 传入 JSON |
| `codex` | `~/.codex/config.toml`（`notify = [...]`） | `turn_summary`（`agent-turn-complete`） | Codex TUI 审批/互动提示不经 `notify` 触发 |
| `agy` | `~/.gemini/config/hooks.json` 或 `.agents/hooks.json`（`Stop` Hook） | `turn_summary`（跳过 `fullyIdle: false`、`exit_plan_mode` 交接及子代理会话——含 `parentConversationId`、`rootConversationId != conversationId` 或无 `USER_INPUT` 的子代理轨迹；结合 `executionId` 与 `(lastStep, lineCount)` 构造幂等键防跨回合碰撞；开启 `include_transcript_summary` 时提取末条回复，若末步调用 `ask_question` 则上报 `interaction_needed`） | 仅靠内置弹窗但未落盘至 Transcript 的非工具交互不触发 `Stop` |
| `pi` | `~/.pi/agent/extensions/ahub-native-notify.ts` 自动加载扩展 | `turn_summary`（`agent_settled`/`agent_end`）、`interaction_needed`（`ui_prompt_start`） | 无 UI 的 headless `-p` 默认跳过防刷屏 |
| `omp` | `~/.omp/agent/extensions/ahub-native-notify.ts` 自动加载扩展（或 `--from-hook omp`） | `turn_summary`（`agent_settled`/`agent_end`）、`interaction_needed`（`tool_approval_requested` / `ui_prompt_start`） | 无 UI 的 headless `-p` 默认跳过防刷屏 |
| `grok` | `~/.grok/hooks/ahub-native-notify.json`（`Notification`、`Stop` 调 `ahub native-emit --from-hook grok`） | `interaction_needed`（`Notification`，自动跳过 `idle_prompt` 与 `task_complete`）、`turn_summary`（`Stop`，跳过 `stop_hook_active` 与 `SubagentStop`/子代理字段） | 依赖 Grok Hook 传入 `cwd`/`last_assistant_message` |

`ahub native-emit` 强制执行以下安全与幂等边界：

1. **凭证隔离**：除命令行显式传入 `--url` / `--token` 外，固定只读取 `node.json` 中的 `hub_url` 与 `token`，忽略环境变量 `AHUB_URL`、`AHUB_TOKEN` 与客户端 `credentials` 文件。
2. **目录白名单回退与先校验后读盘**：`native_notify.allowed_roots` 为空时默认回退复用 `node.json` 的 `project_roots`（两者均为空时 Fail-Closed 跳过）；**必须在工作区白名单校验通过之后**才允许打开读取 `agy` 的 `transcriptPath`，禁止对未授权路径触发磁盘读取。支持可选 `native_notify.events` 在节点出网前过滤 `event_kind`（留空则不过滤）。
3. **大体积 Transcript 流式读取与子代理拦截**：扫描 `agy` 的 `transcriptPath` 时采用流式 `bufio.Reader` 逐行读取并跳过超过 `4 MB` 的超长非目标行，精准拦截无人工输入且由父代理消息拉起的子代理会话（避免 `/teamwork` 等编排器派生数十子代理逐一刷屏）。
4. **无单调轮次 ID Hook 的幂等键**：对于缺乏原生单调轮次 ID 的 Hook（如 `claude` `Notification` 重复审批通知，或未传有效/唯一 `executionId` 的 `agy` `Stop`），在未显式指定 `--event-id` 时将 `executionId`、Transcript 末尾 `step_index`/行号或短时间粒度桶纳入 `event_id` 哈希维度，避免同会话重复审批、跨回合同 `executionNum` 碰撞或第 2 轮起总结通知被 `(node_id, event_id)` 去重静默丢弃。
5. **出站前脱敏、长度有界与多渠道扇出**：上报前在节点本地对 `title`（上限 `200` 字符）与 `summary`（上限 `4000` 字符）执行 `redact.Text` 脱敏；云端 `POST /api/v1/nodes/:id/native-events` 执行二次脱敏落库后，在 `notification_deliveries` 按节点默认 Bot Webhook 与匹配的 `web_push_subscriptions` 多渠道扇出并独立入队，外层 `notify_status` 聚合为 `none | queued | sent | partial | failed | skipped`。

## 5. 配套 `skills/ahub/SKILL.md` 标准全文

`ahub skill print` 将直接输出如下规范供任意 Agent 或外部助手加载：

```markdown
---
name: ahub
description: Dispatch, resume, monitor, and cancel coding or inspection tasks across registered machines (macmini, mbp, linux-dev, etc.) using the ahub CLI. Use when asked to run tasks on another machine, delegate work to a specific local agent (agy, pi, omp, codex, claude), or inspect remote workspace code.
---

# ahub Cross-Machine Task Dispatch

Use the `ahub` CLI as the sole interface to `agent-hub`. Do not hand-craft HTTP requests.

## Workflow

1. **Discover nodes and workspaces first** (when unsure of node names, agents, or project keys):
   ```sh
   ahub nodes --online --json
   ```

2. **Check delegation safety before dispatching**:
   - Inspect `AHUB_DEPTH`. If you are already executing inside a delegated task at depth >= 1, do not call `ahub run` unless explicitly authorized; complete the work locally and return your findings.
   - Never pass secrets or raw credentials inside the prompt.

3. **Dispatch or continue a task via stdin** (always pass `-` to avoid shell quoting issues):
   - New task thread:
     ```sh
     ahub run -n <node_id> -d <project_key_or_path> -a <agent> [-m <model>@<effort>] --wait 45s --json - <<'EOF'
     <clear, self-contained task instructions>
     EOF
     ```
   - Follow-up in an existing thread (preserves native agent session on that node):
     ```sh
     ahub run --thread <thread_id> --wait 45s --json - <<'EOF'
     <follow-up instructions>
     EOF
     ```
   - When running inside an environment with a webhook callback (e.g. Grok Bot), add `--notify grok`.
   - **Show prompt at dispatch time**: On `ahub run`, display the masked prompt with `run_id` / `thread_id`; never rely on `ahub result` post-completion for raw `prompt`.

4. **Handle wait outcomes by exit code**:
   - Exit `0` with `status: "done"`: Read `summary` and `output_preview` directly. Use `ahub result <run_id> --full --json` only if full output is needed.
   - Exit `0` with `status: "running"` and `webhook_armed: true`: Share `run_id` / `thread_id` and the masked prompt, note async execution, and stop until callback.
   - Exit `24` (local wait timed out without `--notify`): Call `ahub wait <run_id> --timeout 15m --json` to keep waiting over WebSocket.
   - Exit `20` (`status: "needs_approval"`): Immediately surface `remote_control_url` to the user for human approval.
   - Exit `64` (`WORKDIR_AMBIGUOUS`): Re-run using one of the exact paths returned in `error.details.candidates`.
   - Exit `10` (`status: "failed"`): Read `error_code` and `error_message` on the run record.
   - Exit `78`: Read `error.code` and `error.message`; do not blindly retry on `DEPTH_LIMIT_EXCEEDED`, `DELEGATION_CYCLE_DETECTED`, or `FORBIDDEN_SCOPE`.

5. **Report results and protect prompt privacy**:
   - On `done`, `failed`, `cancelled`, or `needs_approval`, report `thread_id` / `run_id` and `summary` (or `remote_control_url`).
   - Do **not** call `ahub result` to fetch `prompt` post-completion; `ahub_run_completed` callbacks may reference redacted `prompt_preview` only as a fallback.
   - **Mandatory redaction**: Never output raw tokens, passwords, bearer credentials, API keys, or webhook secrets when displaying any prompt or output; mask sensitive values before replying.

6. **Native activity & progress milestones** (no `workdir` locks):
   - Read-only inspect (`admin` only; `client` exits `78` `FORBIDDEN_SCOPE`):
     `ahub activity [--node <id>] [--agent <a>] [--kind interaction_needed|turn_summary|progress] [--unacked] [--limit 20] [--json]`
   - Long-task milestone (never mount `PostToolUse` hooks; non-urgent `turn_summary`/`progress` are filtered by `native_notify.events` & node default Bot event rules and coalesced with 60s quiet-window + 300s session cooldown):
     `ahub native-emit --agent <a> --kind progress --session-id <sid> --dir "$PWD" --title "<t>" --summary -`
```
