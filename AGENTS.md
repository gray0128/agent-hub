# AGENTS.md

本文件规定 `agent-hub` 仓库的工程契约、依赖门禁与验证标准。所有面向本仓库的规划、编码与审查任务均须遵守以下约束。

## 1. 契约先行（Contract-First）

- 任何对 D1 表结构、状态机迁移、REST 端点、WebSocket 帧格式、CLI 参数/退出码或前端 Store 接口的修改，必须先同步更新 `docs/02-data-and-state-contracts.md`、`docs/03-api-and-ws-protocol.md`、`docs/04-ahub-cli-and-node-daemon.md`、`docs/05-web-frontend-spec.md` 及 `docs/schemas/*.schema.json`。
- 代码实现与契约文档发生冲突时，不得静默修改代码绕过规格；应先裁决并更新契约与 Schema，再修改实现。
- 面向外部边界的请求体、WebSocket 帧与本地配置文件只在边界处校验一次；内部模块之间传递经校验的强类型结构，不重复编写防御性校验。

## 2. Go 单二进制 `ahub` 准则

- 强制使用 `CGO_ENABLED=0` 静态编译，保证产出二进制在 `darwin/arm64`、`darwin/amd64`、`linux/amd64`、`linux/arm64` 与 `windows/amd64` 上零外部运行时依赖。
- 调用端 CLI（`ahub nodes`、`ahub run`、`ahub wait`、`ahub result`、`ahub cancel`、`ahub runs`、`ahub threads`）在传入 `--json` 时，`stdout` 仅允许输出单个合法 JSON 对象；进度提示、重连状态与诊断日志统一输出至 `stderr`。
- 所有读取或提交长文本 Prompt 的命令必须支持 `-`（从 `stdin` 读取），避免调用方 Agent 拼接 Shell 参数引发截断或注入风险。
- 节点守护端 `ahub node serve` 必须以独立进程组（Unix 下 `Setpgid: true`）拉起本地 Coding Agent 子进程；收到 `hub.abort` 或达到超时上限时，必须终止整个进程组而非仅杀父进程。

## 3. Web 前端反膨胀与依赖门禁

`apps/web` 采用「每类职责唯一库」强制约束，以保证组件源码可控、打包体积紧凑及界面风格一致：

| 职责分类 | 唯一允许引入的依赖 | 明确禁止引入的同类库 |
| --- | --- | --- |
| UI 基础组件 | `shadcn/ui`（`radix-nova` 预设，源码置入 `src/components/ui/`）与底层 `@radix-ui/*` | `@mui/*`、`antd`、`@chakra-ui/*`、`@mantine/*` |
| 图标体系 | `lucide-react` | `@radix-ui/react-icons`、`@heroicons/*`、`react-icons`、`@tabler/icons-react` |
| 动效引擎 | `motion`（统一从 `motion/react` 导入） | `framer-motion`、`gsap`、`react-spring`、`@formkit/auto-animate` |
| 分栏布局 | `react-resizable-panels`（v4） | `allotment`、`react-split`、手写拖拽分割条 |
| 拖拽排序 | `@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`、`@dnd-kit/modifiers` | `react-beautiful-dnd`、`@hello-pangea/dnd`、`react-dnd`、`sortablejs` |
| 状态管理 | `zustand` | `redux`、`@reduxjs/toolkit`、`jotai`、`recoil`、`mobx`、`valtio` |

前端编码硬性纪律：

- 禁用 `transition: all`，只允许显式过渡具体合成属性（如 `opacity`、`transform`、`background-color`、`border-color`）。
- 禁用卡片嵌套卡片（Card-in-Card）、禁用模板式紫蓝霓虹渐变与发光边框、禁用界面标题与状态文案中的装饰性 emoji。
- 动态数值（耗时、计数、字节数、时间戳）一律启用 `font-variant-numeric: tabular-nums`。
- 禁止仅凭手写测试或静态编译宣布前端完成；交互变更需经真实构建与浏览器渲染检查。

## 4. 安全与权限隔离

- 绝不在代码、文档或测试夹具中提交真实 Token、私钥、Webhook 密钥、私有主机地址或个人本地路径；示例域统一使用 `ahub.bobocai.win`（并保持通过 `AHUB_URL` 可配置），示例节点与路径统一使用通用占位名称（如 `macmini`、`mbp`、`~/workspace/demo`）。
- 云端 `api_keys` 仅存 SHA-256 摘要，绝不存储或回显明文。
- 节点守护进程拉起本地 Coding Agent 子进程前，必须执行最小环境变量白名单过滤，显式剥离 `AHUB_TOKEN` 与其他控制面凭据；仅允许注入 `AHUB_RUN_ID`、`AHUB_THREAD_ID`、`AHUB_ROOT_RUN_ID` 与 `AHUB_DEPTH` 血统环境变量。
- 跨机委派默认限制 `max_depth = 1`；超出深度限制或出现同一 `(node_id, workdir)` 环路调用时，云端必须在入库阶段直接拒绝。

## 5. 文档与代码一致交付标准

- 任何涉及状态码、错误码、表字段或 CLI 参数的 PR，必须同时包含对应的契约校验或单元测试。
- 评测与不变量门禁遵循 `docs/07-eval-framework.md`；新增或修改评测断言须通过变异门禁（Mutation Gate）验证其具备真实的缺陷检出能力，日常提交须通过 `make eval-fast`。
- 中文技术文档遵守克制、准确、可扫读原则，中文引号使用 `「」`，代码标识符、路径与枚举值使用反引号包裹。
