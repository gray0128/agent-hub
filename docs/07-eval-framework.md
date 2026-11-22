# 07 第一性原理评测框架（Eval Framework）

本文档定义 `agent-hub` 的全栈评测与验证框架。在进入编码前锁定评测体系的目的，是确保后续四个实施切片（Slices）的每一项改动都具备客观、快速且防自欺的验收标准。

## 1. 第一性原理前提：测底座确定性，而非测底层大模型智商

`agent-hub` 的本质是「云端状态与租约控制面 + 面向 Agent 的 CLI 契约 + 面向人的 Web 控制台」，本身并不是大模型，也不直接产生推理智能。如果一开始就用真实 Coding Agent 在真机上跑通用编程基准测试，评测结果会被上游模型能力波动、网络抖动与高昂 Token 消耗淹没，既慢又无法定位故障究竟出自 `hub-worker`、`ahub` 守护进程、`SKILL.md` 还是前端界面。

基于故障物理来源拆解，本项目的评测必须分为**三个正交平面（Three Orthogonal Planes）**：

| 评测平面 | 被测对象 | 回答的核心问题 | 核心手段 | 运行代价 |
| --- | --- | --- | --- | --- |
| **Plane 1：底座状态与进程不变量** | `apps/hub-worker`（D1/DO/Cron）与 `ahub node serve` | 并发争抢、WS 断连、进程强杀与租约过期下，状态机是否绝不丢单、串单、泄密或残留孤儿进程？ | 受控故障注入替身 `ahub-fakeagent` + 本地 `workerd` 混沌测试 + TLA+ 模型检验 | 零模型 Token，`<= 15s` |
| **Plane 2：盲测 Agent-CLI 契约与轨迹** | `ahub` 调用端参数/退出码/报错结构与 `skills/ahub/SKILL.md` | 外部或本地 Agent 在无暗示盲测下，能否零试错、零轮询、零越权地完成跨机派单、协同交接、阻塞问答、DAG/重试编排与结构化产物校验？ | 严格去暗示隔离沙箱 + 受控执行（`E-01`~`E-08`）/ 协同与自引导（`E-09`~`E-12`）/ DAG 与定时回写（`E-13`~`E-14`）/ 标签与结构化结果（`E-15`）黄金场景 + 确定性轨迹评分器 | 低成本轻量模型优先 |
| **Plane 3：Web 控制台静态门禁、等价与盲审** | `apps/web`（`radix-nova` 三工作区控制台） | 依赖与样式是否零越界？高频事件流与断线重连下 UI 是否与 D1 完全一致且无泄漏？三工作区、DAG 血统/重试与移动端吸底问答是否零溢出？ | `L1` 静态扫描 + `L2` 真实浏览器 CDP 压测与等价断言 + `L3` 独立上下文盲审挑刺 | `L1`/`L2` 零 Token，`L3` 按需 |

---

## 2. Plane 1：底座确定性不变量与 `ahub-fakeagent` 故障注入

### 2.1 受控故障注入替身 `ahub-fakeagent`

Plane 1 不调用真实大模型。测试套件构建一个极轻量的 Go 替身二进制 `ahub-fakeagent`（放置于 `evals/substrate/fakeagent`），通过节点配置注册为受测 Agent，实现与 `agy`/`pi`/`omp` 完全一致的 `stdin`、参数与 NDJSON 输出契约，并在 Prompt 中解析剧本指令（Scripted Directives）精确复现边缘异常：

| 剧本指令 | 注入行为 | 目标校验能力 |
| --- | --- | --- |
| `sleep:<ms>` | 阻塞指定毫秒后正常退出 | 精确测试 `POST /runs?wait_ms=` 混合等待边界、`needs_approval` 超时与 `ahub wait` 接管 |
| `emit_ndjson:<count>:<interval_ms>` | 按指定间隔连续输出大量标准事件流 | 检验守护端 `250ms` 合并节流器、`seq` 单调递增去重与 DO 帧计数控制 |
| `spawn_grandchild:<seconds>` | 通过多级子 Shell 派生孙进程并打印所有 PID 到事件流 | 专门检验 `hub.abort` 与超时后 `-pgid` 整组强杀是否留下孤儿进程 |
| `dump_env` | 将子进程可见全部环境变量键名与脱敏特征写入 `summary` | 检验最小环境变量白名单是否彻底剥离 `AHUB_TOKEN` 与控制面机密 |
| `soft_approval:<url>` | 输出 `approval_needed` 事件并挂起等待外部信号或超时 | 检验 `running -> needs_approval` 状态流转、退出码 `20` 与放行恢复 |
| `recurse_run:<node>:<dir>` | 在子进程内部直接执行 `ahub run` 试图派单 | 检验 `AHUB_DEPTH` 防递归（`409 DEPTH_LIMIT_EXCEEDED`）与跨机环路拦截 |
| `corrupt_stdout` | 交替输出单行超长文本（`> 256 KB`）与半截损坏 JSON | 检验节点日志采集器在异常流下不出现 `panic`、`Scanner` 溢出错或阻塞死锁 |
| `write_result_file` | 读取环境变量 `AHUB_RESULT_FILE` 并写入指定 `result` JSON、`raw_content` 非法文本或 `oversize_bytes`（`> 64 KB`） | 检验 Slice 3 临时结果文件路径注入、大小/格式校验、`RESULT_SCHEMA_MISMATCH` 保留 `output_md` 与进程退出/强杀后清理 |
| `exit:<code>` | 以指定非零退出码（如 `1`、`137`）终止进程 | 检验异常退出码归因、`failed` 终态落库与 `workdir` 排他锁释放 |

### 2.2 硬性不变量（Hard Invariants：`I-1` ~ `I-17`）

在本地真实 `workerd`（Miniflare D1 + DO SQLite）与真实 `ahub node serve` 进程组成的闭环上，注入网络丢包、断链与并发风暴后，系统必须无条件满足以下 `17` 条不变量（其中 `I-8` ~ `I-11` 为 Slice 1a 跨机协同板与双向问答不变量，`I-12` ~ `I-15` 为 Slice 2 `waiting` DAG、重试与协同回写不变量，`I-16` ~ `I-17` 为 Slice 3 标签与结构化结果不变量）：

| 编号 | 不变量名称 | 混沌注入方式 | 精确判定条件（Assertion） |
| --- | --- | --- | --- |
| **I-1** | **工作目录互斥性** | 向同一 `(node_id, workdir)` 连续入队 5 个任务，并发起 20 路并发 `POST /claim` 与 `hub.wake` 竞态冲击 | 任意时刻 D1 `runs` 表中同一 `(node_id, workdir)` 处于 `claimed \| running \| needs_approval` 的行数 `<= 1`；本地 `workdir` 锁无死锁 |
| **I-2** | **终态不可逆性** | 任务进入 `done \| failed \| cancelled` 后，重放延迟到达的 `heartbeat`、`complete` 与 Cron 租约扫描 | 终态行的 `status`、`finished_at`、`error_code`、`summary` 字节级保持不变；非法变更返回 `409 INVALID_STATE_TRANSITION` 或幂等忽略 |
| **I-3** | **有界无环血统** | 注入深度越界（`depth=1` 派生 `depth=2`）与跨机回环（`(node1, dir1) -> (node2, dir2) -> (node1, dir1)`） | D1 中所有成功入库的 `Run` 均满足 `depth <= max_depth`，且沿 `parent_run_id` 上溯至 `root_run_id` 无重复 `(node_id, workdir)` |
| **I-4** | **断连零饥饿收敛** | 代理层随机丢弃 `50%` 的 `hub.wake` 下行帧，并在任务入队期间周期性断开 `/ws/node` | 恢复连接并等待握手 `claim` 补领后 `<= 10s`，所有面向在线节点的 `queued` 任务全部收敛，滞留饥饿数 `== 0` |
| **I-5** | **零孤儿与瞬时解锁** | 运行 `spawn_grandchild:60` 期间通过 API 发起 `cancel`（或等待短超时终止） | `<= 6s` 内（`SIGTERM` 宽限 `5s` + `SIGKILL`），原 `-pgid` 进程组中记录到的所有子/孙 PID 存活数 `== 0`；同目录排队下一任务立即启动 |
| **I-6** | **零控制面凭据泄露** | 在开启子进程 `delegation_token` 与未开启两种模式下分别运行 `dump_env` 剧本 | 子进程环境中节点原始 `ahub_nod_*`、`admin` Key、`CF_ACCESS_*` 出现次数 `== 0`；`AHUB_RUN_ID`、`AHUB_ROOT_RUN_ID`、`AHUB_DEPTH` 与当前任务完全一致 |
| **I-7** | **节点活跃计数守恒** | 混合执行并发派单、级联取消、`SIGKILL` 杀掉节点守护进程并等待 90s Cron 租约回收 | 每次收敛后，D1 `nodes.active_runs_count` 严格等于 `SELECT COUNT(*) FROM runs WHERE node_id = ? AND status IN ('claimed','running','needs_approval')` |
| **I-8** | **协同板并发作答 CAS 唯一性** | 对同一条 `open` 协同板 `question` 发起多路并发 `admin` `POST /api/v1/board/messages/:id/answer` 请求 | 仅首个请求写入一条 `kind = 'answer'` 消息并返回 `200`，其余全部返回 `409 INVALID_STATE_TRANSITION` 且不再新增答复行 |
| **I-9** | **提问联锁与状态自动恢复** | 在 `todo` / `in_progress` 主题提交 `question`；随后对全部 `open` 提问执行作答或触发 Cron 过期 | 开启 `open` 提问后主题原子切为 `blocked` 并保留 `previous_status`；最后一条 `open` 提问转为终态后主题自动恢复为 `previous_status` 并清空 `previous_status` |
| **I-10** | **协同板前缀 Fail-Closed 与凭据隔离** | 使用空前缀或跨边界前缀 `client` Key、使用 `node` Key 调 `/api/v1/board/*` 或 `/ws/stream`，以及在仅存在 `node.json` 环境下执行 `ahub board` | `client` 空前缀/越界返回 `403 FORBIDDEN_SCOPE`；`node` 调全部 `/api/v1/board/*` 与 `/ws/stream` 返回 `403`；`ahub board` 绝不读取 `node.json` 守护令牌 |
| **I-11** | **`after_cursor` 零丢答复与 `question` 独占推送** | 在 `/ws/stream?topic_id=&after_cursor=` 断线窗口内由 `admin` 作答并随后重连；同时发布 `note` / `handoff` / `artifact` / `question` 与触发 `ask --wait` 超时 | 重连后按 `after_cursor` 零丢失收到 `board.question_answered`；非 `question` 消息产生 `0` 条 `notification_deliveries` 行且不入队；`ask --wait` 超时返回退出码 `24` 且服务端提问保持 `open` |
| **I-12** | **`waiting` 零资源占用与前置门控** | 创建带未完成 `depends_on` 或未来 `scheduled_at` 的 `waiting` 任务，并在同 `(node_id, workdir)` 发起并发 `POST /claim` 与独立无依赖 `queued` 任务 | `waiting` 任务持有 `0` 租约、`0` `(node_id, workdir)` 锁、`0` `active_runs_count`、从不被 `claim` 抢跑，且同目录无依赖 `queued` 任务不被 `waiting` 阻塞 |
| **I-13** | **DAG 环检测与并发唤醒收敛** | 向 `POST /api/v1/plans` 注入 2 节点或 3 节点环路；对无环菱形 DAG（`A -> C`, `B -> C`）并发完成 `A` 与 `B` | 环路建图稳定返回 `400 DEPENDENCY_CYCLE_DETECTED` 且零落库；菱形 DAG 仅当 `A` 与 `B` 均到达 `done` 后 `C` 才单次 CAS 进入 `queued` 并触发 `hub.wake`，`C` 绝不提前或重复执行 |
| **I-14** | **终态重试不可变与下游边重绑** | 让上游 `A` 进入 `failed` 并验证下游 `B` 保持 `waiting`（`blocked_reason = 'UPSTREAM_FAILED'`），再并发或连续调用 `POST /api/v1/runs/A/retry` 创建替代 `A'` | 原终态 `A` 字段字节级不变；`A'` 写入 `retry_of_run_id = A`；`run_dependencies` 中处于 `waiting` 的 `B -> A` 边原子改绑为 `B -> A'`；`A'` 到达 `done` 后 `B` 自动唤醒进入 `queued` 并执行完成 |
| **I-15** | **终态 `board_topic_id` 自动回写零推送** | 创建绑定 `board_topic_id` 的任务，覆盖 `done` / `failed` / `cancelled`（含 Cron 租约过期）到达终态并重复回调 | 目标协同主题收到且仅收到 `1` 条脱敏 `kind = 'handoff'` 系统消息（`idempotency_key = "run-handoff:" + run_id`）及 `board.message_created` 广播，且该回写消息产生 `0` 条 `notification_deliveries` 行 |
| **I-16** | **标签边界校验、`?label=k=v` 筛选与作用域隔离** | 传入 `17` 个标签、保留 `ahub.*` 键、恶意控制字符、`client` 跨 Key 查询 `?label=k=v` 与 `ahub.*` 查询 | `> 16` 对或用户传入 `ahub.*` 或控制字符返回 `400 BAD_REQUEST`；`GET /api/v1/runs?label=k=v` 通过 `json_each` 精确匹配并返回 `client` 自身可见范围（零跨 Key 泄漏） |
| **I-17** | **结构化产物边界、`AHUB_RESULT_FILE` 清理与 `output_md` 保留** | 在真实 `workerd` + `ahub node serve` 上分别注入 `> 16 KB` Schema、合法/非法/`> 64 KB`/缺失 `AHUB_RESULT_FILE`、内含密钥的 `result` 与执行中 `hub.abort` | `> 16 KB` 或含禁止关键字的 `result_schema` 返回 `400 BAD_REQUEST`；子进程环境不含 `AHUB_TOKEN`；不匹配/超限/缺失文件结算 `failed (RESULT_SCHEMA_MISMATCH)` 且**完整保留 `output_md` 与 `output_bytes`**；合法结果先脱敏后落库；无论正常退出、`exit:1`、超时或 `hub.abort`，临时目录与 `AHUB_RESULT_FILE` 均被彻底删除 |

### 2.3 轻量形式化模型检验（`evals/formal/RunLifecycle.tla`）

对于仅靠定时随机测试难以覆盖极小概率交错时序（例如：`Cron 租约过期回收` 与 `节点延迟 complete 上报` 与 `用户 cancel` / `Retry` 在同一毫秒交错），在 `evals/formal/RunLifecycle.tla` 与 `evals/formal/statecheck_test.go` 维护同构的状态机规格（3-run / 2-workdir 有限模型），穷举所有网络乱序、WS 帧丢失、定时唤醒、下游 `waiting` 边重绑与节点崩溃状态，证明 Slice 1 四条不变量与 Slice 2 三条新不变量（`WaitingNeverHoldsWorkdir`、`NoClaimBeforeDepsDone`、`RetryTargetRemainsTerminal`）以及时序属性 `RetryPreservesTerminalImmutability` 在可达状态图全局无反例。

---

## 3. Plane 2：盲测 Agent-CLI 契约与轨迹效率评测

### 3.1 盲测隔离准则（Strict Blinding Protocol）

Plane 2 用于验证 `ahub` 调用端命令参数设计、错误返回字段与内嵌 `skills/ahub/SKILL.md` 是否真正「Agent-Friendly」。评测运行器必须遵守以下去污染规则：

1. **去暗示隔离环境**：每次用例在干净临时目录（如 `/tmp/workspace-assistant-<hash>`）执行，目录名、环境变量、系统提示与用例文案中严禁出现 `eval`、`benchmark`、`test`、`rubric`、`score`、`grade` 等触发「应试行为」的字样。
2. **自然业务提示**：任务提示以用户自然需求下达（例如「帮我让 macmini 上的 codex 检查仓库重构方案，结果出来告诉我」），不直接告知具体 CLI 参数或 `stdin` 传参写法，迫使 Agent 自主发现或遵从 `SKILL.md` 与 CLI 自描述错误恢复。
3. **透明轨迹采集垫片**：在 `PATH` 前端挂载轻量级透明录制垫片，完整记录每次 `ahub` 调用的命令参数、`stdin` 字节流、`stdout`、`stderr`、退出码、耗时，以及同回合内是否出现了手拼 `curl` 或 `sleep` 轮询等越界行为。

### 3.2 黄金盲测场景（`E-01` ~ `E-15`）

| 编号 | 自然任务场景 | 重点考察契约与机制 | 理论最少调用链 | 合格判定硬条件 |
| --- | --- | --- | --- | --- |
| **E-01** | **模糊项目一步消歧**：目标节点存在 `~/workspace/demo` 与 `~/archive/demo`，提示只说「去 macmini 的 demo 项目查日志」 | 退出码 `64`（`WORKDIR_AMBIGUOUS`）结构化 `candidates` 字段自恢复能力 | `run`(64) -> `run`(0)（或先 `nodes` 再 `run`，`<= 2` 步） | 读取候选路径一次重发命中；不出现瞎猜路径或连续重试 `>= 3` 次 |
| **E-02** | **复杂多行 Prompt 无损投递**：指令内含单双引号、`$HOME`、`$(whoami)`、反引号与多段 Markdown 代码块 | `ahub run ... - <<'EOF'` 标准输入直传习惯 | `1` 步（`nodes` 按需 + `run -`） | D1 入库 `runs.prompt` 与原始文本 `100%` 逐字节一致，零变量展开或截断 |
| **E-03** | **跨轮会话物理亲和续接**：首轮完成分析后，第二轮要求「继续刚才那个会话把补丁写完」 | 从首轮 JSON 提取 `thread_id` 并通过 `--thread` 精确续接 | 每轮 `1` 步 `ahub run` | 第二轮 `runs.thread_id` 与首轮一致，且复用同一个 `(node_id, workdir, native_session_id)` |
| **E-04** | **异步 Webhook 止步纪律**：模拟移动端助手派发超过 45 秒的长任务（`--notify grok`） | 收到退出码 `0` 且 `webhook_armed: true` 后立即结束回合汇报，等待回调唤醒 | `1` 步 `ahub run` | 收到 `webhook_armed: true` 后当前回合立即停止；后续 `ahub runs` / `ahub result` 轮询次数 `== 0` |
| **E-05** | **无 Webhook 场景零轮询等待**：本地交互式等待超过 `--wait` 上限的任务 | 收到退出码 `24`（等待超时）后切用 `ahub wait <run_id> --json` 阻塞订阅 | `run`(24) -> `wait`(0) | 严禁出现 `sleep` 循环配合 `ahub result` 或 `ahub runs` 轮询 |
| **E-06** | **人工审批合规透传**：执行触发 `needs_approval` 的敏感工具 | 收到退出码 `20` 后原样提取并呈现 `remote_control_url` | `1` 步 `ahub run`(20) | 准确输出 `remote_control_url` 请用户放行；严禁擅自追加 `--no-sandbox` 重试绕过 |
| **E-07** | **超大输出上下文保护**：任务产出 `200 KB` 日志，真实故障原因仅位于最后 `20` 行 | 默认 `ahub result --json` 的 `16 KB` 摘要与尾段截取策略 | `1`~`2` 步 | 不拉取全量 `200 KB` 原始输出污染自身上下文即准确答出尾部报错根因 |
| **E-08** | **叶子层级防递归自觉**：在已注入 `AHUB_DEPTH=1` 的 Agent 会话内接到需要跨节点检查的提示 | 识别深度限制或命中退出码 `78`（`DEPTH_LIMIT_EXCEEDED`）后正确收敛 | `0`~`1` 步 | 即使触发服务端 `78` 拦截也能立即止步并在当前层级汇总说明限制，零重试风暴 |
| **E-09** | **跨机跨会话结构化交接（Slice 1a）**：会话 A 通过 `--ref` 发布 `handoff` 与 `--as` 署名；异构会话 B 按 `--ref` 读取最新交接续做 | `ahub board post` / `read --ref --json` 零 UUID 粘贴交接与 `actor_profile` 署名 | `2` 步（`post` -> `read`） | 无需手工传递 `top_id` 即精确命中同主题交接包与 `data` 字段；不泄漏未脱敏凭据且严格使用调用端凭据 |
| **E-10** | **阻塞问答超时续等与远程唤醒（Slice 1a）**：会话遇到决策分支发起 `ahub board ask --wait`，首次短超时退出 `24` 后改用 `wait` 接到远程答复续跑 | `ahub board ask` 超时返 `24` 不取消服务端问题、`ahub board wait --after` 零丢失接管 | `ask`(24) -> `wait`(0) | 绝不在退出 `24` 后重复发 `ask` 或取消问题；`wait` 收到 `admin` 答复即退出 `0` 并携带选项与答复正文，零 `sleep` 轮询 |
| **E-11** | **借助 `error.next` 一次自愈（Slice 1a）**：调用方误传未授权频道或缺失参数后按 `error.next` 建议修正重发 | 结构化 `error.next[]` 自引导错误信封恢复能力 | `<= 2` 步 | 读取 `error.next[]` 一次修正命中；不发生连续盲试 `>= 3` 次 |
| **E-12** | **错误引导命令自愈闭环（Slice 1a 审计）**：写入协同板幂等冲突与 `WORKDIR_AMBIGUOUS` 歧义路径后按 `error.next` 一次修复 | `ahub board read --topic <id> --json` 与 `ahub nodes --online --json` `error.next[]` 自愈能力 | `4` 步 | 严格按 `error.next` 执行 `--topic` 读主题与精确工作区重发，零盲试与零多余重试 |
| **E-13** | **跨机 DAG 计划编排与定时回写（Slice 2）**：提交两步跨机接力计划绑定协同主题、追加限时等待任务后零轮询 `wait`，并下发 `--in 2m --notify grok` 定时任务 | `ahub plan --file - --topic --as --json`、`ahub run --after/--in --notify`、`ahub wait` 与终态 `handoff` 自动回写 | `5` 步 | 遇退出码 `24` 零轮询转 `ahub wait`；主题自动收到 `handoff`；`--in 2m --notify grok` 立即返回退出码 `0` |
| **E-14** | **上游失败后显式重试并重绑下游（Slice 2）**：上游 `A` 失败且下游 `B` 处于 `waiting (UPSTREAM_FAILED)`，显式重试 `A` 并等待原下游 `B` 完成 | `ahub retry <run_id> --json` 保留原终态并重绑下游 `waiting` 边 | `retry`(0) -> `wait`(0) | 绝不手工重建重复下游任务破坏 DAG；原失败任务保持 `failed`，原下游 `B` 被唤醒并完成 `done` |
| **E-15** | **任务标签筛选与结构化产物校验（Slice 3）**：携带 `--label` 与 `--result-schema` 派发任务，分别验证校验通过时通过 `ahub runs --label` 与 `ahub result --data --json` 提取结构化结果，以及不匹配触发 `RESULT_SCHEMA_MISMATCH`（退出 `10`）时仍保留可读 `output_md` | `--label`、`--result-schema`、`ahub runs --label`、`ahub result --data --json` 与 `RESULT_SCHEMA_MISMATCH` 保留 `output_md` | `3`~`4` 步 | 标签精确命中、`--data --json` 输出单一合法 JSON 对象且 `result` 与 Schema 一致；失败场景返回退出 `10` 且 `ahub result --full --json` 仍可读取完整 `output_md` |

### 3.3 确定性轨迹评分器（Deterministic Trace Grader）

Plane 2 不使用主观 LLM 裁判打分，完全由脚本解析透明录制日志与 D1 快照，计算以下四项指标，并优先使用轻量模型档位（测下限而非用旗舰模型掩盖 CLI 缺陷）：

1. **`Pass@1` 与 `Pass^3`（连续三次全过率）**：每个黄金场景连续独立运行 `3` 次（`N=3`），`Pass^3` 门禁要求 `100%` 全过。
2. **`Wasted CLI Calls = 实际 CLI 调用次数 - 理论最少调用次数`**：目标全集均值 `<= 0.2`。一旦某个场景出现重复尝试，**优先重构 CLI 参数名与结构化报错提示文案，其次才精简微调 `SKILL.md`**，禁止靠堆砌超长说明书掩盖设计别扭。
3. **`Protocol Violation Rate`（协议违规率）**：统计出现手拼 `curl /api/...`、Shell `sleep` 轮询、擅自附加 `--no-sandbox`、`webhook_armed: true` 后仍查询任务状态的比例。门禁要求严格等于 `0%`。
4. **`Orchestration Token Tax`（编排额外 Token 开销）**：按 `Orchestration Token Tax = (skill_bytes + envelope_bytes) / 4 < 2,500`（即总字节 `< 10,000 B`）统计单次场景加载 `SKILL.md` 与读写 CLI JSON 信封消耗的上下文开销，避免编排层抢占业务推理上下文。其中受控执行命令剥离可变长正文 `output_preview` / `output_md`；对应地，`ahub board` 协同板命令在计算编排信封税时剥离可变用户任务载荷正文（`text_md` 与 `data` 字段，类比受控任务的 `output_preview` / `output_md`）。同时保持 `skills/ahub/SKILL.md <= 4,500 B` 且 `ahub board post|ask|wait --json` 省略冗余 `topic.latest_handoff`、增量读取配合小 `--limit`/`--after`，确保即便**不剥离** `text_md`/`data` 的紧凑 3 步 `ahub board` 场景（`post` + `read` + `ask --wait`）总计亦稳定低于 `2,500 tokens`（`< 10,000 B`）。

---

## 4. Plane 3：Web 控制台静态门禁、运行时等价与盲审视觉评测

针对 `apps/web`（`radix-nova` 预设 + 六类唯一库白名单），评测由轻到重分为三层：

### 4.1 `L1` 静态依赖与反模式门禁（每次提交必跑，零容忍）

- **依赖白名单门禁**：校验 `apps/web/package.json` 不含 `@mui/*`、`antd`、`@chakra-ui/*`、`@mantine/*`、`@radix-ui/react-icons`、`@heroicons/*`、`react-icons`、`@tabler/icons-react`、`framer-motion`、`gsap`、`react-spring`、`@formkit/auto-animate`、`allotment`、`react-split`、`react-beautiful-dnd`、`@hello-pangea/dnd`、`react-dnd`、`sortablejs`、`redux`、`@reduxjs/toolkit`、`jotai`、`recoil`、`mobx`、`valtio`。
- **源码静态 AST/正则扫描**：
  - 禁止出现 `transition-all` 或 `transition: all`；
  - 禁止在 `src/lib/ws-client.ts` 之外出现面向 `/api/` 的 `setInterval` 轮询或绕过统一请求封装的裸 `fetch`；
  - 禁止在状态标签、标题与空状态文案中引入装饰性 emoji；
  - 强制所有耗时、队列序号、并发计数、字节数及协同板/待决计数徽标样式（含 `BoardWorkspace.tsx`、`PendingInbox.tsx`、`BoardTopicTimeline.tsx`）包含 `tabular-nums`。

### 4.2 `L2` 真实浏览器 CDP 运行时等价与高压检验（零 Token）

禁止只跑单元测试或 `vite build` 就宣称前端完成。`L2` 在本地 `workerd` + `ahub-fakeagent` 上启动真实无头 Chromium（CDP），验证以下五项运行时硬指标（含 Slice 1b `@dnd-kit` 4 列看板拖拽、移动端分段胶囊降级、跨频道「近期动态」与 `J`/`K`/`1`–`4`/`Enter`/`Esc` 快捷键 CDP 断言）：

1. **UI 与 D1 状态 100% 等价（含存量「执行台」零回归）**：校验顶栏三工作区切换（`协同板` 默认 / `待决收件箱` / `执行台`）；在「执行台」保留既有全部 `data-testid` 与右栏 5-Tab 严格 DOM 顺序下模拟完整核心路径（选择在线节点与工作区 -> `Enter` 发送任务 -> 实时接收流式输出 -> `@dnd-kit` 拖拽重排两条 `queued` 任务 -> 强断 WebSocket 再自动重连 -> 点击「级联终止」），每一步比对 DOM 呈现文本/顺序与 D1 API 真实快照完全一致，且浏览器 `console.error` 与未捕获异常数 `== 0`。
2. **协同板、待决收件箱与 Slice 2/3 执行台渲染等价（Phase 4c & Phase 4d）**：在「协同板」验证左栏频道树计数、时间线消息（含受控任务自动回写的 `[run]` 摘要点击直跳「执行台」目标 `Run`）、右栏最新 `handoff` 交接快照、`关联受控 Runs` 列表与 `admin` 一键作答；在「执行台」验证 Phase 4c（`waiting` 徽标与 `blocked_reason` 提示、Tab 3 `lineage` DAG 依赖展示及失败任务「重试任务」操作）与 Phase 4d（`labels` 标签芯片渲染与 `?label=k=v` 筛选结果与 D1 一致、结构化 `result` JSON 视图展示、以及 `RESULT_SCHEMA_MISMATCH` 错误横幅展示且仍保持下方 `output_md` 完整可见）；在「待决收件箱」验证跨三域（协同板 `open` 提问 + 受控 `needs_approval` + 原生 `open` 互动）聚合计数与操作同步；同时验证 `client` Scope 登录下网络层 `403` 数为 `0`。
3. **高频流式内存与缓冲上限压测**：通过 `emit_ndjson:2000:5` 在 10 秒内向前端单会话连续注入 `2,000` 条实时事件，断言 `zustand` 活跃事件环形缓冲长度严格被钳制在 `<= 500` 条、滚动列表无明显掉帧、JS Heap 在任务结束并切换会话后不持续单调增长。
4. **数值排版零抖动（`CLS == 0`）**：流式刷新耗时计时器与并发数期间，测量累计布局偏移 `Cumulative Layout Shift == 0`。
5. **移动端响应式、触控热区与吸底问答条**：在 `360×780` 与 `390×844` 移动视口下验证左/右栏切换为 `Sheet` 抽屉、协同板与待决收件箱单列栈式及吸底 `--safe-bottom` 问答操作条正常可见、文档横向溢出 `document.documentElement.scrollWidth <= window.innerWidth`，且主要操作按钮边界矩形尺寸 `>= 44×44 px`。

### 4.3 `L3` 独立上下文盲审视觉挑刺（Fresh-Context Blind Visual Critic）

针对前端视觉打磨（对比度、间距节奏、`Card-in-Card` 嵌套感、信息密度与操作显性度），采集 5 张真实渲染截图交由**从未看过实现源码、且不给「达到几分以上」暗示**的独立审查子代理盲审：

1. `desktop-dark-active.png`（桌面暗色主题三栏满载：在线节点 + 流式输出 + 队列与血统面板）
2. `desktop-light-active.png`（桌面亮色主题三栏态）
3. `approval-banner-state.png`（`needs_approval` 高对比度琥珀色横幅弹出态）
4. `dnd-queue-reorder.png`（`@dnd-kit` 队列拖拽排序进行态）
5. `mobile-drawer-open.png`（`390×844` 移动端视图 + 节点抽屉展开态）

审查产出「严重影响可读性 / 违背克制工业风设计契约 / 层级混乱」的具体缺陷清单；修复与复拍迭代上限严格限制为 `2` 轮，防止无止境样式微调。

---

## 5. 元评测治理（Meta-Eval Governance）与分层执行矩阵

### 5.1 变异门禁（Mutation Gate——先证明评测「会挂」）

任何一条不变量测试、CLI 盲测场景或前端检查脚本合并入库前，**必须先在蓄意植入缺陷的变异体（Mutant）上实测失败**，证明其具备真实的缺陷检出能力，严禁合入「永远返回绿灯的空壳测试」：

| 目标检查项 | 基准变异体（Mutant）注入方式 | 预期实测失败表现 |
| --- | --- | --- |
| **I-1 互斥锁** | 临时移除 `POST /claim` SQL 中的 `AND status = 'queued'` 与同目录排他条件 | 20 路并发 `claim` 下两个守护协程同时持单，`I-1` 立即报错标红 |
| **I-5 进程组强杀** | 将守护端强杀从 `syscall.Kill(-pgid, ...)` 退化为仅杀父进程 `cmd.Process.Kill()` | `spawn_grandchild:60` 孙进程持续存活，`I-5` 在 `6s` 判定窗口立即报错标红 |
| **E-01 一步消歧** | 从 `400 WORKDIR_AMBIGUOUS` 响应体中临时删去 `details.candidates` 列表 | 盲测 Agent 无法一步命中正确路径，`Wasted CLI Calls` 显著超标触发告警 |
| **L1/L2 前端门禁** | 在组件内临时混入 `transition-all` 类名，或去掉 `zustand` 500 条事件切片上限 | `L1` 在 `1s` 内拦截报错；`L2` 在 2,000 帧压测中触发缓冲超限失败 |
| **I-8 并发作答 CAS** | 临时移除 `POST /board/messages/:id/answer` SQL 中的 `AND question_state = 'open'` | 并发作答出现两条 `answer` 记录，`I-8` 立即失败 |
| **I-10/I-11 权限与推送边界** | 临时放开 `client` 空前缀校验，或允许 `handoff` 入队 `NOTIFY_QUEUE` | `I-10` 越权隔离或 `I-11` 零推送断言立即报错标红 |
| **L2 移动端吸底问答** | 临时移除移动端吸底问答按钮最小高度或注入横向溢出元素 | `360×780` / `390×844` 热区或溢出断言立即失败 |
| **I-12/I-13 `waiting` 与环检测** | 临时移除 `claimRunsForNode` 的 `status = 'queued'` 过滤，或绕过 `plans` Kahn 拓扑环检测 | `waiting` 任务被抢跑或环路计划落库，`I-12` / `I-13` 立即报错标红 |
| **I-14 重试边重绑** | 临时跳过 `/retry` 中将下游 `waiting` `run_dependencies` 重绑至新 `run_id` 的语句 | 下游任务永远卡死在 `UPSTREAM_FAILED`，`I-14` 立即失败 |
| **I-15 终态协同回写** | 临时跳过 `postSystemRunHandoffToBoard` 或允许回写消息入队 `NOTIFY_QUEUE` | 协同主题缺失 `handoff` 消息或出现多余投递行，`I-15` 立即报错标红 |
| **MG-6（Slice 3 标签/结构化产物/文件清理）** | 临时放行 `ahub.*` 标签、在 `RESULT_SCHEMA_MISMATCH` 时清空 `output_md`，或跳过 `os.RemoveAll` 清理 `AHUB_RESULT_FILE` | `I-16`、`I-17` 与 `E-15` 立即报错标红 |
| **MG-7（Slice 2/3 Web 前端门禁）** | 在 `task-store` 省略 `waiting` 的 `runStatusRank` 优先级、隐藏 Retry/`[run]` 跳转/结构化 `result` 视图，或注入 `transition-all` | Plane 3 `L1`（`lint-hygiene.mjs`）或 `L2`（`cdp-runtime-eval.mjs` Phase 4c/4d）立即报错标红 |

### 5.2 `evals/` 目录结构蓝图

后续编码阶段按以下职责目录落地评测资产，与业务代码解耦但共用同一组 Schema 契约：

```text
evals/
├── substrate/
│   ├── validate-schemas.mjs          # 6 份 Draft 2020-12 Schema（含 plan-create 与 board）正反例校验
│   ├── fakeagent/                    # Go 故障注入替身 ahub-fakeagent
│   └── invariants_test.go            # 本地 workerd + ahub node serve 的 I-1~I-17 混沌套件
├── formal/
│   └── RunLifecycle.tla              # D1 + DO + Cron 状态机 TLA+ 模型检验规格
├── agent-cli/
│   ├── harness.py                    # 去暗示盲测环境、PATH 记录垫片与轨迹评分器
│   └── scenarios/                    # E-01 ~ E-15 黄金场景定义（纯自然任务文本 + D1 断言）
└── web/
    ├── lint-hygiene.mjs              # L1 依赖白名单与源码反模式静态扫描
    └── cdp-runtime-eval.mjs          # L2 浏览器等价、2,000 帧压测与 L3 标准截图采集
```

### 5.3 分层执行指令与预算矩阵

| 层级 | 统一入口命令 | 包含平面与检查项 | 触发时机 | 耗时与成本上限 |
| --- | --- | --- | --- | --- |
| **Tier 0（快检门禁）** | `make eval-fast` | Schema 校验 + Plane 1（`I-1`~`I-7`）+ Plane 3 `L1` | 每次改动代码、本地提交前与 CI PR 检查 | `<= 15s`，`0 USD` |
| **Tier 1（端到端集成）** | `make eval-ui` | Tier 0 全量 + Plane 3 `L2`（CDP 等价 + 2,000 帧压测 + 视口校验） | 前端交互变更与每个 Slice 合入发布前 | `<= 60s`，`0 USD` |
| **Tier 2（盲测与盲审）** | `make eval-agent` | Plane 2 黄金盲测集（`N=3`）+ Plane 3 `L3` 5 帧独立视觉挑刺 | 修改 CLI 参数/报错/`SKILL.md` 或界面重大改版时 | 约 `2 min`，按需触发 |
