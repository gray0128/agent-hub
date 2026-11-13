# 05 Web 任务中心前端设计规格（One-Shot Ready）

`agent-hub` 的 Web 任务中心是整个系统的主控制台，通过 Cloudflare Workers Static Assets 与控制面同域托管于 `https://ahub.bobocai.win`（零跨域 CORS 开销），由 Cloudflare Access 保护人机入口。本文档固化前端技术栈、零重复依赖白名单、视觉系统、三栏可调布局、拖拽交互与状态切片契约，确保单次编码即可交付一致、克制且高密度的专业控制台。

## 1. 技术栈与唯一依赖白名单

### 1.1 运行时与构建底座

- React `19.x` + TypeScript（`strict: true`，禁止 `any`）
- Vite `6.x` + `@tailwindcss/vite`（Tailwind CSS v4）

### 1.2 职责唯一库白名单与禁用黑名单

每个 UI 基础设施职责仅允许引入单一指定库，严禁在同一项目中混用同类替代包：

| 职责 | 唯一允许引入 | 组件源码与路径要求 | 明确禁止引入 |
| --- | --- | --- | --- |
| **UI 组件体系** | `shadcn/ui` **Nova** 预设（底层 `@radix-ui/*` + `class-variance-authority` + `clsx` + `tailwind-merge`） | `apps/web/components.json` 固定 `"style": "radix-nova"`、`"rsc": false`、`"iconLibrary": "lucide"`、`"baseColor": "zinc"`；全部组件源码生成至 `apps/web/src/components/ui/` | `@mui/*`、`antd`、`@chakra-ui/*`、`@mantine/*`、`daisyui` |
| **图标体系** | `lucide-react` | 按需具名导入，统一线宽 `strokeWidth={1.75}` | `@radix-ui/react-icons`、`@heroicons/*`、`react-icons`、`@tabler/icons-react` |
| **动效引擎** | `motion` | 统一从 `"motion/react"` 导入 `motion`、`AnimatePresence`、`MotionConfig` | `framer-motion`（旧包名）、`gsap`、`react-spring`、`@formkit/auto-animate` |
| **分栏布局** | `react-resizable-panels`（v4） | 用于桌面端三栏控制台布局与尺寸持久化 | `allotment`、`react-split`、手写 `mousedown` 拖拽分割条 |
| **拖拽交互** | `@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`、`@dnd-kit/modifiers` | 仅用于三处受控列表/队列编排 | `react-beautiful-dnd`、`@hello-pangea/dnd`、`react-dnd`、`sortablejs` |
| **状态管理** | `zustand` | 拆分 `fleet`、`task`、`workbench` 三个 Store | `redux`、`@reduxjs/toolkit`、`jotai`、`recoil`、`mobx`、`valtio` |
| **Markdown 与代码** | `react-markdown` + `remark-gfm` | 渲染任务输出 `output_md` 与行内代码 | 不引入重型富文本编辑器 |

## 2. 视觉语言与设计工程细节（`radix-nova` 控制台美学）

### 2.1 风格定位

- 采用 `shadcn/ui` Nova 预设的紧凑内边距与高信息密度特性，定位为「工业级多机任务控制台」而非营销落地页。
- 层级依靠清晰的空间分区与 `1px` 结构分割线表达，**严禁使用卡片嵌套卡片（Card-in-Card）**。
- **严禁模板化视觉噪声**：不使用紫蓝渐变背景、发光霓虹边框、无意义统计大卡片，以及标题或状态栏中的装饰性 emoji。

### 2.2 OKLCH 色彩系统与语义状态色

默认深色模式为主工作态，同时完整支持浅色模式切换（通过 `ThemeProvider` 切换根元素 `.dark` 类）：

| 语义角色 | 深色模式参考 Token | 浅色模式参考 Token | 使用场景 |
| --- | --- | --- | --- |
| 画布底色 `--background` | `oklch(0.145 0.005 260)` | `oklch(0.985 0.002 260)` | 主背景与工作区底板 |
| 侧栏/面板 `--surface-elevated` | `oklch(0.175 0.006 260)` | `oklch(0.96 0.003 260)` | 左栏节点列表与右栏检视面板 |
| 结构分割线 `--border` | `oklch(1 0 0 / 0.09)` | `oklch(0 0 0 / 0.09)` | 分栏分隔条、列表项边界、选中态边框 |
| 状态 `online` / `done` | `oklch(0.72 0.17 155)` | `oklch(0.55 0.16 155)` | 在线圆点、任务完成标识 |
| 状态 `running` / `claimed` | `oklch(0.68 0.16 245)` | `oklch(0.54 0.18 245)` | 执行中脉冲指示与活动进度 |
| 状态 `needs_approval` | `oklch(0.78 0.16 75)` | `oklch(0.62 0.17 65)` | 人工审批横幅与待放行提示 |
| 状态 `failed` | `oklch(0.64 0.21 25)` | `oklch(0.55 0.21 25)` | 失败徽标与危险操作按钮 |
| 状态 `queued` / `offline` / `cancelled` | `oklch(0.62 0.01 260)` | `oklch(0.52 0.01 260)` | 排队中、离线与已取消态 |

### 2.3 排版与微交互规范

- **字体平滑与等宽对齐**：根节点设置 `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;`。所有动态更新数字（运行耗时、队列计数、字节大小、时间戳、租约倒计时）统一施加 `tabular-nums`（`font-variant-numeric: tabular-nums`），防止数字刷新时引发横向抖动。
- **标题与正文折行**：标题设置 `text-wrap: balance`，长段提示文案设置 `text-wrap: pretty`。节点 ID、工作区路径、`run_id`、模型名称与事件日志流统一使用等宽字体（`font-mono`）。
- **同心圆角法则**：所有嵌套容器遵循 `outer_radius = inner_radius + padding`（例如外框 `rounded-lg` `8px` 配 `p-1` `4px` 时，内按钮用 `rounded-sm` `4px`）。
- **克制的 `motion/react` 动效**：
  - 根应用包裹 `<MotionConfig reducedMotion="user">`。
  - 列表或视图切换的 `<AnimatePresence initial={false}>` 禁止在首屏初次加载时播放入场动画。
  - 所有弹簧过渡统一使用零回弹参数 `transition={{ type: "spring", duration: 0.25, bounce: 0 }}`。
  - 主要按钮按压微反馈固定为 `whileTap={{ scale: 0.96 }}`（禁止低于 `0.95`）。
  - 状态图标切换（如复制成功、状态变化）采用 `opacity: 0 -> 1`、`scale: 0.25 -> 1`、`filter: blur(4px) -> blur(0px)` 交叠过渡。
  - **禁用 CSS `transition: all`**，所有样式过渡必须明确指定属性（如 `transition-[color,background-color,border-color]`）。

## 3. 三栏可调信息架构与移动端降级

### 3.1 桌面端三栏布局（`>= 768px`）

使用 `react-resizable-panels` 的 `PanelGroup`（`direction="horizontal"`，`autoSaveId="ahub-workbench-layout"`）构建工作台：

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│ 顶部极简指令条 (44px): ahub Logo | 机群在线统计 3/4 | ⌘K 命令面板 | WS 状态 | 主题 │
├──────────────────┬───────────────────────────────────────┬────────────────────┤
│ 左栏 (18% ~ 24%) │ 中栏 (44% ~ 56%)                      │ 右栏 (24% ~ 34%)   │
│ 可折叠           │                                       │ 可按需折叠         │
│                  │ [会话头: 节点 / 目录 / Agent / 血统树]  │                    │
│ 1. 节点状态矩阵   │ ------------------------------------- │ Tab 1: 实时事件流  │
│  - macmini (2/4) │ [Run #1 对话与结果卡片]                │   (run_events +    │
│  - mbp     (0/4) │ [Run #2 needs_approval 放行横幅]       │    租约倒计时 +    │
│  - linux   (离线)│ [Run #3 执行中实时预览]                │    衍生血统关系)   │
│                  │                                       │                    │
│ 2. 会话线程列表   │ ------------------------------------- │ Tab 2: 节点排队甲板│
│  [置顶区 - 可拖拽]│ [底部多机任务派发台 Composer]          │   (同机队列拖拽)  │
│  [按节点/状态筛选]│  节点 -> 目录 -> Agent -> 模型@思考强度 │                    │
│                  │  多行输入框 + ⌘Enter 提交              │ Tab 3: 凭证与设置  │
└──────────────────┴───────────────────────────────────────┴────────────────────┘
```

#### 各栏职责细则

1. **左栏：Fleet & Threads Rail**
   - 上半区「节点矩阵」紧凑展示每台机器的 `status`、`active_runs_count / max_concurrency` 与在线 Agent 徽标，点击节点可一键过滤该机器下的会话，同时兼作拖拽改派/分叉的投放目标（Droppable）。
   - 下半区「会话列表」支持「置顶会话」与「全部会话」两段，支持按状态（进行中/待审批/全部）筛选与关键词搜索。
2. **中栏：Thread Timeline & Task Composer**
   - 顶部栏展示当前 `Thread` 绑定的 `node_id`、`project_key`、`agent`、`native_session_id` 短 ID；若当前选中的 `Run` 存在父任务或子任务，显示可点击切换的血统面包屑及「级联取消整棵树」按钮。
   - 中间消息流按时间正序排列该 `Thread` 下的所有 `Run`：展示 Prompt、实际命中模型与思考强度、独立计时耗时、`output_md` 渲染结果（超长自动折叠并支持一键展开/复制）。当 `status === 'needs_approval'` 时在顶部渲染高对比度琥珀色操作条，提供一键打开 `remote_control_url` 审批按钮。
   - 底部「多机任务派发台（Composer）」：选择已有 `Thread` 时锁定物理绑定的 `node_id` 与 `workdir`（同时提供「切换至新建会话」开关）；新建会话时呈现四级联动选择器「节点 -> 工作区目录 -> Agent -> 模型与思考强度」，支持 `⌘Enter` / `Ctrl+Enter` 提交与草稿本地自动保存。
3. **右栏：Live Inspector & Queue Deck**
   - **Tab 1 实时事件流**：订阅当前选中 `Run` 的 `run_events`，以等宽时间线展示 `status`、`tool_use`、`turn_end`、`stderr_warn`，并实时计算 `lease_expires_at` 剩余秒数。
   - **Tab 2 节点排队甲板**：按节点与 `workdir` 分组展示待执行的 `queued` 任务与当前持锁占用目录，支持直接拖拽排序或跨节点改派。
   - **Tab 3 凭证与接入设置**：仅当当前用户具备 `admin` 权限时可见，提供 `api_keys` 签发（选 `client` 或 `node` Scope、绑定节点白名单与深度限制）、明文单次复制弹窗、一键吊销，以及复制 `curl -fsSL https://ahub.bobocai.win/dl/install.sh | sh` 自举命令。

### 3.2 移动端响应式降级（`< 768px`）

- 隐藏三栏分割线，主屏幕专注渲染中栏「当前会话消息流 + 底部紧贴派发台」。
- 顶部导航条提供「节点与会话」及「队列与流」两个抽屉触发按钮，使用 `shadcn/ui` `Sheet` 组件从左右滑出。
- 全部可交互按钮、Tab 与列表项在移动端保持至少 `44×44px` 触控热区，确保无外部 Bot 时仅靠手机浏览器即可顺畅完成派单、审批与取消操作。

## 4. `@dnd-kit` 三处高价值拖拽交互规格

仅在能直接减少多步点击表单操作的场景使用 `@dnd-kit`：

1. **待执行队列优先级重排**
   - 作用域：右栏「节点排队甲板」中状态为 `queued` 的任务列表（`SortableContext` + `verticalListSortingStrategy`）。
   - 交互结果：释放拖拽后先乐观更新 Zustand 队列顺序，再调用 `POST /api/v1/runs/reorder`；若请求失败或该任务在拖拽瞬间已被节点认领，回滚顺序并弹出 Toast 提示。
2. **跨节点派单改派与会话分叉**
   - 作用域：将 `queued` 状态的 Run 卡片或 `Thread` 列表项拖入左栏另一台处于 `online` 状态的节点卡片。
   - 交互结果：拖入 `queued` Run 时直接调用 `PATCH /api/v1/runs/:id` 改派目标节点（自动校验目标节点是否存在同名 `project_key`）；拖入已有 `Thread` 时弹出确认对话框，执行「Fork 到目标节点」（`POST /api/v1/threads/:id/fork`）。
3. **常用会话置顶排序**
   - 作用域：左栏置顶会话区（`pinned === true`），拖拽调整日常高频会话顺序并调用 `PATCH /api/v1/threads/:id` 持久化 `sort_order`。

### 传感器与防误触约束

- 统一配置 `PointerSensor` 带 `activationConstraint: { distance: 6 }`，防止普通点击选定会话时误触发拖拽。
- 同时注册 `KeyboardSensor`（配合 `sortableKeyboardCoordinates`）满足键盘无障碍操作。
- 统一在顶层渲染单个 `<DragOverlay>` 浮层卡片，拖拽原位元素保持 `opacity-40` 占位。

## 5. `zustand` 状态切片契约

前端状态强制拆分为三个职责单一的 Store，避免单一大对象引发全局重渲染：

```ts
// 1. 机群与连接状态切片 (apps/web/src/stores/fleet-store.ts)
export interface FleetState {
  nodesById: Record<string, NodeRecord>;
  nodeOrder: string[];
  wsStatus: "connecting" | "connected" | "reconnecting" | "disconnected";
  lastSyncedAt: string | null;
  hydrateNodes: (nodes: NodeRecord[]) => void;
  upsertNodeStatus: (node: Partial<NodeRecord> & { id: string }) => void;
  setWsStatus: (status: FleetState["wsStatus"]) => void;
}

// 2. 会话、任务与事件流切片 (apps/web/src/stores/task-store.ts)
export interface TaskState {
  threadsById: Record<string, ThreadRecord>;
  threadIds: string[];
  runsById: Record<string, RunRecord>;
  runIdsByThread: Record<string, string[]>;
  // 单任务事件流本地保留上限 500 条，防止长时间驻留内存泄漏
  eventsByRunId: Record<string, RunEventRecord[]>;
  hydrateInitial: (threads: ThreadRecord[], runs: RunRecord[]) => void;
  applyRunUpdate: (run: RunRecord) => void;
  appendRunEvent: (event: RunEventRecord) => void;
  reorderQueuedRuns: (nodeId: string, orderedRunIds: string[]) => void;
}

// 3. 工作台视图与草稿切片 (apps/web/src/stores/workbench-store.ts, 使用 persist 中间件)
export interface WorkbenchState {
  theme: "dark" | "light" | "system";
  activeThreadId: string | null;
  activeRunId: string | null;
  selectedNodeFilter: string | null;
  inspectorTab: "events" | "queue" | "keys";
  composerDraftByThread: Record<string, string>;
  setActiveThread: (threadId: string | null) => void;
  setActiveRun: (runId: string | null) => void;
  setInspectorTab: (tab: WorkbenchState["inspectorTab"]) => void;
  setComposerDraft: (key: string, text: string) => void;
}
```

### 增量同步与断线补偿规则

- WebSocket `/ws/stream` 收到 `snapshot` 帧时调用 `hydrateNodes` 与 `hydrateInitial` 全量对齐；每次重连成功后必须重新校准一次 `lastSyncedAt`，避免断网期间遗漏终态变更。
- `appendRunEvent` 依据 `event.seq` 进行严格去重与单调排序，超过 `500` 条时从头部裁掉早期日志并保留「已归档更早事件，点击加载」提示。

## 6. 受控界面文案规范

| 界面场景 | 固定文案表达 |
| --- | --- |
| 空状态：工作台首次使用 | 「尚未创建任务。请在底部选择节点与项目目录并输入指令。」 |
| 空状态：筛选无结果 | 「当前筛选条件下没有匹配的会话或任务。尝试清除节点或状态筛选条件。」 |
| 空状态：目标节点离线 | 「目标节点当前离线。现在提交的任务将安全进入排队队列，并在节点上线后自动开始执行。」 |
| 权限受限提示 | 「当前凭证无权查看系统密钥管理。请使用管理员账号通过 Cloudflare Access 登录。」 |
| 危险操作：取消运行中任务 | 「确认取消任务？系统将立即向目标节点发送进程组终止信号（SIGTERM），已产生的本地文件改动不会自动回滚。」 |
| 危险操作：级联取消任务树 | 「确认级联取消整棵任务树？此操作将同步终止该主任务及其衍生出的全部排队与运行中子任务。」 |
| 危险操作：吊销凭证 | 「确认吊销此凭证？吊销立即生效；若该凭证属于在线节点，对应节点连接将被立即断开。」 |
