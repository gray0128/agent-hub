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
| **拖拽交互** | `@dnd-kit/core`、`@dnd-kit/sortable`、`@dnd-kit/utilities`、`@dnd-kit/modifiers` | 用于执行台既有三处受控列表/队列编排，以及协同板 4 列看板同列重排与跨列流转（消费 `POST /api/v1/board/topics/reorder`，仅单频道选中态启用拖拽） | `react-beautiful-dnd`、`@hello-pangea/dnd`、`react-dnd`、`sortablejs` |
| **状态管理** | `zustand` | 拆分 `fleet`、`task`、`workbench`、`native-activity`、`board` 五个 Store；浏览器推送协调器 `apps/web/src/lib/browser-notify.ts` 与 `public/sw.js` 仅使用浏览器原生 Push / Notification / `navigator.locks` / `BroadcastChannel` API，**零新增第三方依赖** | `redux`、`@reduxjs/toolkit`、`jotai`、`recoil`、`mobx`、`valtio` |
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
| 状态 `needs_approval` | `oklch(0.78 0.16 75)` | `oklch(0.62 0.17 65)` | 人工审批横幅、待放行提示、待处理原生互动（`attention_state === "open"`）、协同板 `blocked` 状态与 `open` 提问标识，以及部分送达态（`partial`）；`acked` / `superseded` / `stale` 降级为中性/次级文本 |
| 状态 `failed` | `oklch(0.64 0.21 25)` | `oklch(0.55 0.21 25)` | 失败徽标与危险操作按钮 |
| 状态 `queued` / `offline` / `cancelled` | `oklch(0.62 0.01 260)` | `oklch(0.52 0.01 260)` | 排队中、离线与已取消态 |

### 2.3 排版与微交互规范

- **字体平滑与等宽对齐**：根节点设置 `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;`。所有动态更新数字（运行耗时、队列计数、字节大小、时间戳、租约倒计时，以及 `NativeActivityPane.tsx`、`BrowserNotifyDialog.tsx`、`BoardWorkspace.tsx`、`BoardKanbanView.tsx`、`PendingInbox.tsx`、`BoardTopicTimeline.tsx`、`InspectorPane`「投递明细」与顶栏「待决 / 互动」计数徽标）统一施加 `tabular-nums`（`font-variant-numeric: tabular-nums`），防止数字刷新时引发横向抖动。
- **网络调用与 Service Worker 边界（L1/L2 门禁）**：全仓前端仅允许 `apps/web/src/lib/api-client.ts` 调用 `fetch(`，任何组件、Store 或 `public/sw.js` 均严禁直接发起裸 `fetch`（`sw.js` 严禁请求 `/api/`，保持零回源）。
- **移动端触控与零溢出约束**：`<head>` 须声明 `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content" />`；在 `:root` 中定义 `--safe-top`/`--safe-right`/`--safe-bottom`/`--safe-left`（绑定 `env(safe-area-inset-*, 0px)`），供顶栏、底栏、左右抽屉与居中弹窗避让刘海屏与底部手势条。移动端（`< 640px`）所有 `Input` 与 `Textarea` 表单控件计算字号须保持 `>= 16px`（`text-base sm:text-xs`），防止 iOS Safari / Standalone PWA 聚焦时强制放大视口；节点 ID、目录、Token、模型 ID、Webhook URL 与搜索框等标识符输入字段须显式关闭自动纠错与首字母大写（`autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}`）。在 `< 768px`（含 `360×780`、`390×844` 视口）下，顶栏、抽屉标签页与筛选/操作按钮均须保持 `>= 44×44px` 触控热区（如 `min-h-11` / `h-11 w-11`），进入待决问答或含 `open` 提问的协同主题详情时，选项按钮与回复提交栏**吸底固定在 `--safe-bottom` 安全区**，页面横向与纵向溢出始终为 `0`（`document.documentElement.scrollWidth <= document.documentElement.clientWidth`）。
- **标题与正文折行**：标题设置 `text-wrap: balance`，长段提示文案设置 `text-wrap: pretty`。节点 ID、工作区路径、`run_id`、模型名称与事件日志流统一使用等宽字体（`font-mono`）。Markdown 表格须包裹于可键盘聚焦的局部横向滚动容器（`.ahub-table-scroll`，`role="region"`、`tabIndex={0}`、`aria-label="数据表格"`），确保多列表格在窄屏不被挤压成单字竖排且不撑宽页面。
- **同心圆角法则**：所有嵌套容器遵循 `outer_radius = inner_radius + padding`（例如外框 `rounded-lg` `8px` 配 `p-1` `4px` 时，内按钮用 `rounded-sm` `4px`）。
- **克制的 `motion/react` 动效**：
  - 根应用包裹 `<MotionConfig reducedMotion="user">`。
  - 列表或视图切换的 `<AnimatePresence initial={false}>` 禁止在首屏初次加载时播放入场动画。
  - 所有弹簧过渡统一使用零回弹参数 `transition={{ type: "spring", duration: 0.25, bounce: 0 }}`。
  - 主要按钮按压微反馈固定为 `whileTap={{ scale: 0.96 }}`（禁止低于 `0.95`）。
  - 状态图标切换（如复制成功、状态变化）采用 `opacity: 0 -> 1`、`scale: 0.25 -> 1`、`filter: blur(4px) -> blur(0px)` 交叠过渡。
  - **禁用 CSS `transition: all`**，所有样式过渡必须明确指定属性（如 `transition-[color,background-color,border-color]`）。

## 3. 三工作区 Board-First 信息架构与移动端降级

### 3.1 顶栏三工作区切换与桌面端布局（`>= 768px`）

顶栏（`44px`）紧邻 `BrandMark` 提供一级三工作区切换器：

1. **「协同板」（`board`，Slice 1a 新默认主视角）**：跨机、跨会话、跨 Harness 共享的工作主题与交接协同台。
2. **「待决收件箱」（`inbox`，带全局合并 `tabular-nums` 琥珀角标）**：聚合全部需要人工拍板的待处理事项——协同板 `open` 提问数 + 受控任务 `needs_approval` 数 +（仅 `admin`）原生活动 `interaction_needed (open)` 数。
3. **「执行台」（`runs`）**：**100% 兼容保留**既有的三栏可调布局（`autoSaveId="ahub-workbench-layout"`）、`FleetThreadsPane` / `ConversationPane` / `NativeActivityPane` / `InspectorPane` 全部 `data-testid` 选择器及右栏 5-Tab 严格 DOM 顺序（`events` -> `queue` -> `lineage` -> `control` -> `deliveries`）。

#### 协同板（`board`）桌面端三栏布局（`>= 768px`，`autoSaveId="ahub-board-layout"`）

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 顶栏 (44px): BrandMark | [协同板 | 待决 N | 执行台] | 在线 X/Y | 通知渠道 | 接入 | 主题 │
├──────────────────┬───────────────────────────────────────────────┬─────────────────────┤
│ 左栏 (18% ~ 24%) │ 中栏 (48% ~ 58%)                              │ 右栏 (22% ~ 28%)    │
│ 频道与视图导航   │ [主题列表 / 话题详情时间线]    [搜索 / 筛选]  │ 主题上下文检视器    │
│                  │ --------------------------------------------- │                     │
│ 全部活跃         │ - 顶部置顶 open 提问横幅（admin 一键选答）    │ 1. 状态与锚点       │
│ 待我确认         │ - 混合时间线：                                │   5 态切换 / 置顶   │
│                  │   note / handoff / question / answer / artifact│   external_ref      │
│ 频道树 Channels  │   明确显示 actor_scope / actor_profile / node │   参与节点与角色    │
│ + 新建主题       │ - 底部统一 Composer（发备注/交接/提问/产物）  │ 2. 最新交接快照     │
│                  │                                               │   branch/SHA/PR/复制│
└──────────────────┴───────────────────────────────────────────────┴─────────────────────┘
```

- **左栏（频道与视图导航）**：提供「全部活跃」（`active`）、「待我确认」（`open_questions`）与跨频道「近期动态」（`recent`，聚合全部未归档跨频道活跃主题并按最近活跃时间 `updated_at DESC, id DESC` 倒序呈现）三个快速筛选视图、路径式 `Channels` 树（展示各频道活跃主题数与未答复提问数，`tabular-nums`）与「`+ 新建主题`」弹窗触发器。
- **中栏（三视角画布 `BoardWorkspace.tsx` / `BoardTopicTimeline.tsx` / `BoardKanbanView.tsx`）**：顶部提供「`话题流`（`timeline`，默认以兼容 Slice 1a）| `列表`（`list`）| `看板`（`kanban`）」三视角切换器（移动端保持 `>= 44×44px` 触控高度）：
  - **话题流（`timeline`）**：展示当前频道/筛选条件下的主题列表与选中主题时间线。主题内存在 `open` 提问时在顶部置顶待答复横幅（`admin` 可直接点选建议选项或输入答复提交；`client` 仅展示只读状态提示）。时间线混合呈现 `note`、`handoff`、`question`、`answer` 与 `artifact`，显式标示每条消息的 `actor_scope`、`actor_profile` 与 `source_node`；底部提供统一 Composer 提交新备注/交接/提问/产物（`note`/`handoff`/`artifact` 明确提示不触发外发推送）。
  - **列表（`list`）**：全宽展示匹配频道/筛选/搜索的主题清单（含频道、状态、置顶、外部锚点 `external_ref`、最近交接署名、未答复提问角标与 `tabular-nums` 更新时间），点击或回车进入主题时间线详情。
  - **看板（`kanban`）**：以 4 个活跃状态列（`待开始`/`todo`、`进行中`/`in_progress`、`待确认`/`blocked`、`已完成`/`done`，排除 `archived`）呈现主题卡片，列内按 `pinned DESC, sort_order ASC, updated_at DESC, id ASC` 排序（与后端 `sort=order` 严格对齐，同列与跨列拖拽均保持置顶分区与未置顶分区顺序一致）。卡片保留整卡指针/触摸拖拽，同时将 `@dnd-kit` `KeyboardSensor`（`Enter`/`Space` 键盘拖拽）隔离绑定到卡片内独立拖拽手柄按钮（`GripVertical`），确保焦点位于看板卡片本体时按 `Enter` 稳定进入话题详情而不被键盘拖拽劫持。**单频道拖拽约束**：仅当 `selectedChannel !== null` 且处于桌面端时启用 `@dnd-kit` 同列重排与跨列状态流转，乐观更新后调用 `POST /api/v1/board/topics/reorder` 持久化目标列 `ordered_topic_ids`（失败时自动回滚并提示错误）；当 `selectedChannel === null` 时禁用拖拽并在看板顶部展示单频道引导与一键切换频道入口。
  - **协同板键盘快捷流（`J`/`K`/`1`–`4`/`Enter`/`Esc`）**：焦点不在输入框、文本域、下拉选择框、IME 组合态或弹窗/抽屉内时生效（且当焦点位于非列表/卡片交互控件如按钮、链接或标签页时，`Enter`/`Space` 保留原生控件激活，不被全局快捷键劫持）：`J`/`K` 上下移动主题列表/卡片焦点；`Enter` 选中聚焦主题并进入详情（在已聚焦选项时确认提交答复）；`Esc` 清除预选选项或从详情退回列表（若从 `list`/`kanban` 进入则同步恢复原视角，切换频道或筛选视图时清理残留返回视角）；`1`–`4` 在主题详情存在 `open` 提问时，若为 `admin` 且选项序号存在则预选第 `1`–`4` 个建议选项（再按 `Enter` 提交），否则保持无操作且绝不回退修改主题状态；仅在无 `open` 提问时快捷切换当前聚焦/选中主题状态（`1=todo`、`2=in_progress`、`3=blocked`、`4=done`）。
- **右栏（主题上下文检视器）**：支持 5 态切换（`todo` / `in_progress` / `blocked` / `done` / `archived`）、置顶开关、`external_ref` 锚点展示、参与节点/角色摘要，以及**最新 `handoff` 交接快照**（提取 `data` 中的 `repo` / `branch` / `commit_sha` / `pr_url` / `next_action` 与一键复制 `ahub board read` 命令）。

#### 待决收件箱（`inbox`）桌面端 Master-Detail 双栏布局（`PendingInbox.tsx`）

- 左栏列出全部跨三域待决条目（按紧急度与时间排序，标明来源域 `board` / `runs` / `native`、频道/节点与角色署名），右栏展开完整上下文并支持就地答复协同板提问（仅 `admin`）、打开远控/标记放行 `needs_approval` 任务，或标记原生互动已处理。支持 `J`/`K`/`1`–`4`/`Enter`/`Esc` 键盘快捷流（`J`/`K` 切换焦点条目；`1`–`4` 在 `admin` 作用域下预选当前 `board` 提问的第 `1`–`4` 个建议选项并高亮，绝不在 `client` 作用域触发 `/answer`；`Enter` 确认提交预选选项或执行当前条目主操作；`Esc` 取消预选选项或退回列表；焦点位于输入控件、IME 组合态或弹窗内时自动屏蔽，同时保留鼠标点击选项按钮即时提交行为）。

#### 执行台（`runs`）桌面端三栏布局（`>= 768px`，`autoSaveId="ahub-workbench-layout"`）

使用 `react-resizable-panels` 的 `PanelGroup`（`direction="horizontal"`，`autoSaveId="ahub-workbench-layout"`）完整保留既有执行台工作区：

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 顶部极简指令条 (44px): ahub Logo | 在线 3/4 | 互动 2 | [通知渠道: 状态] | WS 状态 | 主题 │
├────────────────────────┬───────────────────────────────────────┬───────────────────────┤
│ 左栏 (18% ~ 24%)       │ 中栏 (44% ~ 56%)                      │ 右栏 (24% ~ 34%)      │
│ 可折叠                 │                                       │ 可按需折叠            │
│                        │ [受控会话头 或 原生会话头+快捷接管栏] │                       │
│ [受控会话|原生活动•2|节点]│ ------------------------------------- │ Tab 1: 过程事件       │
│ + 新建会话             │ 受控态 (ConversationPane):            │ Tab 2: 待跑队列       │
│                        │  [Run 卡片 + 审批横幅 + Composer]     │ Tab 3: 委派拓扑       │
│ 受控会话 Tab (默认):   │                                       │ Tab 4: 节点控制       │
│  搜索 / 状态筛选 / 拖拽│ 原生态 (NativeActivityPane):          │ Tab 5: 投递明细       │
│ 原生活动 Tab (admin):  │  [互动提醒 / 里程碑 / 回合总结]       │  (deliveries_summary  │
│  会话聚合 / 平铺流切换 │  [只读边界提示，无伪终端输入框]       │   + 单通道失败重推)   │
│ 节点 Tab:              │                                       │                       │
│  节点目录与并发状态    │                                       │                       │
└────────────────────────┴───────────────────────────────────────┴───────────────────────┘
```

#### 各栏职责细则

1. **左栏：`FleetThreadsPane`（机群、受控会话与原生活动）**
   - 顶部栏扩展为三标签页切换以及「`+ 新建会话`」按钮：
     - 「`受控会话`」（`data-testid="fleet-tab-threads"`，默认激活，保留兼容既有 CDP 选择器）：全高展示关键词搜索框、状态筛选胶囊（`全部` / `进行中` / `待审批` / `仅 <当前节点>`）与可拖拽排序的会话线程列表（支持置顶与分叉操作）。
     - 「`原生活动`」（`data-testid="fleet-tab-native"`，**仅 `authScope === "admin"` 时加载并展示**；`client` Scope 视图隐藏/禁用该标签页且绝不请求 `/api/v1/native-events`）：当 `openInteractionCount > 0` 时显示琥珀色 `tabular-nums` 计数徽标；默认按 `(node_id, agent, native_session_id || workdir)` 聚合成「原生会话条目」（避免同一会话刷屏），支持一键切换「按时间平铺流」视图，提供关键词搜索框与 `全部` / `待互动` / `投递失败` / `仅 <当前节点>` 筛选胶囊。
     - 「`节点`」（`data-testid="fleet-tab-nodes"`，保留既有选择器）：全高展示机群节点列表（在线状态、`active_runs_count / max_concurrency`、可用 Agent 徽标与工作目录数），顶部提供集群目录汇总及一键全部收起/展开开关；每个节点均支持独立收起/展开其下的工作目录列表（点击目录切换为新建会话目标目录，或直接拖拽工作目录至中栏派发台）。
2. **中栏：`ConversationPane`（受控对话台）与 `NativeActivityPane`（原生活动详情流）**
   - **受控会话态（`ConversationPane`）**：顶部栏展示当前 `Thread` 绑定的 `node_id`、`project_key`、`agent`、`native_session_id` 短 ID；若当前选中的 `Run` 存在父任务或子任务，显示可点击切换的血统面包屑及「级联取消整棵树」按钮。
   - 中间消息流按时间正序排列该 `Thread` 下的所有 `Run`：展示经控制面脱敏与截断的 Prompt 预览（`<= 1200` 字符；绝不展示未脱敏凭据）、实际命中模型与思考强度、独立计时耗时与正文输出。其中常规体量输出（`output_bytes <= 128 KB`）自动水合完整 `output_md` 从头渲染，并在前端对超长正文（`> 4000` 字符或 `> 60` 行）默认折叠高度，支持一键「展开全文 / 收起长输出」与完整复制；超大输出（`> 128 KB`）先自动水合 `16 KB` 尾部预览，并在正文上方展示显式截断提示条与「加载完整输出」按钮按需拉取全文；在正文尚未水合就绪时显式标注加载态与「末行摘要：」，禁止将单行 `summary` 冒充完整输出。当 `status === 'needs_approval'` 时在顶部渲染高对比度琥珀色操作条，提供一键打开 `remote_control_url` 审批按钮与「标记已放行」按钮（调用 `POST /api/v1/runs/:id/resolve` 解除工作目录租约并流转为 `done`）。
   - 底部「多机任务派发台（Composer）」：选择已有 `Thread` 时锁定物理绑定的 `node_id`、`workdir` 与 `agent`（同时提供「切换至新建会话」开关）；新建会话与续聊参数均基于所选节点实时上报的 `node.capabilities.agents` 驱动「`node` -> `agent` -> `model` -> `effort`」四级联动：仅展示目标节点已启用且可用的 Agent；模型列表来自所选 Agent 的实时目录 `models[]`，同时支持「跟随节点默认」及在离线或目录未知时手动输入模型 ID（当所选 Agent 为 `agy` 且节点尚未返回显式默认模型或处于离线/兜底态时，派发台默认对齐 `gemini-4-hydrogen` 与 `high`）；推理强度依据当前模型声明的 `efforts[]` 过滤展示（含 `ultra`、`auto` 等节点档位），对于 `efforts` 为空的独立模型（如 `gemini-pro-orchestrator`）自动禁用强度选择并将 `effort` 置空；支持 `⌘Enter` / `Ctrl+Enter` 提交与草稿本地自动保存。
   - **原生活动态（`NativeActivityPane.tsx`）**：当左栏处于「`原生活动`」并选中原生会话或事件时，中栏切换为只读 `NativeActivityPane`（**严禁渲染伪终端输入/发送框**，底部展示诚实物理边界提示：「原生会话运行在节点本机终端中，不支持从云端向交互式 TTY 注入指令或强杀进程。」）。
     - 头部操作栏：按 `agent` 生成精确本机终端续接命令一键复制（`claude --resume <sid>`、`agy --conversation <sid>`、`codex resume <sid>`、`pi --session <sid>`、`omp --resume=<sid>`、`grok` 提示；无 `native_session_id` 时回退 `cd <workdir> && <agent>`）；「携带摘要新建受控任务」按钮切回受控派发台预填 `nodeId`、`workdir` 与脱敏摘要（若原 `agent === "grok"`，自动回退该节点首个可用受控 Agent 并明确提示原因）。
     - 时间线条目：按时间正序展示所属会话下的 `interaction_needed`、`progress`、`turn_summary`；正文复用 `.ahub-markdown`（`react-markdown` + `remark-gfm`）与超长折叠（`> 4000` 字符或 `> 60` 行默认折叠并支持展开/复制）；`interaction_needed` 按派生 `attention_state` 渲染：`open` 渲染琥珀色左边框与「标记已处理」按钮（调用 `POST /api/v1/native-events/:id/ack`，支持 `single` / `session` 范围），`acked` / `superseded` / `stale`（`> 24h`）降级展示。
3. **右栏：`InspectorPane` 与顶栏弹窗**
   - 右栏五个标签页必须严格保持以下 DOM 顺序（以兼容 CDP `:nth-of-type(1|2|4)` 既有选择器）：
   - **Tab 1（`events` / `:nth-of-type(1)`）过程事件**：订阅当前选中 `Run` 的 `run_events`，以等宽时间线展示 `status`、`tool_use`、`turn_end`、`stderr_warn`，并实时计算 `lease_expires_at` 剩余秒数。
   - **Tab 2（`queue` / `:nth-of-type(2)`）待跑队列**：按节点与 `workdir` 分组展示待执行的 `queued` 任务与当前持锁占用目录，支持直接拖拽排序或跨节点改派。
   - **Tab 3（`lineage` / `:nth-of-type(3)`）委派拓扑**：展示当前 `Run` 所属 `root_run_id` 的父子委派树与深度。
   - **Tab 4（`control` / `:nth-of-type(4)`）节点控制**：展示节点在线态、并发上限调整、排空开关、**默认 Bot 通知通道绑定与事件过滤**（**仅当 `authScope === "admin"` 时**展示 `<Select>` 绑定/解绑任意有效且允许该节点的 `client` Key，并实时提示「通道失效/已吊销」徽标；已绑定默认通道时同步展示 8 类触发事件勾选按钮以持久化 `default_notify_events`（其中 `0007` 的 7 项受控/原生事件默认开启，第 8 项 `board_question_opened` 默认关闭、按需开启，启用后附带该 `source_node` 的协同板提问同步路由至该节点默认 Bot 通道）；`client` Scope 登录后隐藏该绑定控件且不请求 `GET /api/v1/keys`，服务端同步省略 `default_notify_*` 字段），以及已上报工作区筛选、路径复制与一键派发。
   - **Tab 5（`deliveries` / `:nth-of-type(5)`，必须为第 5 个标签页）投递明细**：依据当前聚焦对象（受控 `Run` 调 `GET /api/v1/runs/:id/deliveries`，或原生事件调 `GET /api/v1/native-events/:id`；**仅限 `authScope === "admin"` 请求**）展示 `deliveries_summary`（`tabular-nums`）与逐渠道 `NotificationDeliveryRecord` 明细行（`channel_label`、`channel_kind`、脱敏 `target_host`、`route_mode`、`status`、`http_status`、`attempts`、`error_code`、`error_message`、`sent_at`），对 `status === "skipped"` 明细以中性灰字展示跳过原因（如 `SUPERSEDED_BY_NEWER_TURN`、`SESSION_COOLDOWN_ACTIVE`），并对 `status === "failed"`（「重推此通道」）与 `status === "skipped"`（「立即推送此通道」）的行提供单通道推送按钮（分别调用 `POST /api/v1/native-events/:id/redeliver` 或 `POST /api/v1/runs/:id/redeliver`，仅传入 `{ delivery_id }`）。
   - **顶栏「通知渠道」弹窗（`BrowserNotifyDialog.tsx`）**：由顶栏按钮（`data-testid="open-browser-notify-btn"`，紧邻 `互动 N` 胶囊；`authScope !== "admin"` 时隐藏）触发，展示当前浏览器三态健康度（`Web Push 已激活（离线可达）` / `仅页内提醒（未配置 VAPID 或 iOS 未添加主屏幕）` / `浏览器权限已拒绝（附恢复指引）`）；支持仅在用户点击手势内发起 `Notification.requestPermission()` -> `navigator.serviceWorker.register('/sw.js')` -> `pushManager.subscribe()` -> `POST /api/v1/push-subscriptions`（经 `apiClient`），新订阅默认勾选 `["run_needs_approval", "run_failed", "native_interaction_needed", "board_question_opened"]`（其中 `board_question_opened` 显示为「协同板阻塞提问」），并提供按设备勾选 `native_turn_summary`、`native_progress`、`run_done`、`run_cancelled` 与 `node_filter`，以及全部已注册设备列表（`enabled` 开关、重命名、「发送测试通知」回显 HTTP 状态码、解绑吊销）。
   - **顶栏「凭证与接入」弹窗（`KeysDialog` / `OnboardingDialog`）**：仅当当前用户具备 `admin` 权限（`authScope === "admin"`）时才调用 `GET /api/v1/keys` 并支持签发与编辑 `api_keys`（选 `client`、`node` 或 `admin` Scope）；其中 `client` Key 支持多选或留空设置「允许调度节点（`allowed_nodes`）」、设置「允许访问的协同板频道前缀（`allowed_board_prefixes`，默认空数组拒绝协同板读写）」以及配置该 Bot 专属的「Webhook URL」与「Webhook Key」（支持 `1 Node <-> 1 Bot`、`N Nodes -> 1 Bot` 与 `M Bots <-> N Nodes` 组合映射，列表中脱敏展示已绑定节点列表、频道前缀与 `Webhook: <host>` 徽标并支持在线编辑）；弹窗同时提供「节点接入（`node`）」与「Bot / 纯调用端接入（`client`）」自举提示词（后者要求 Bot 仅作只读转达 `ahub_native_event` 的 `event_kind`、`title`、`summary` 与 `action_required: "notify_user_only"`，严禁将原生事件视为自动审批放行或自动回复指令）；任何已保存 Key 视图与弹窗提示词均**严禁**暴露 Webhook URL 路径或 Bearer Key 原文。

### 3.2 移动端响应式降级（`< 768px`）

- **协同板与待决收件箱（`< 768px` 单列栈式、看板分段胶囊与吸底安全区问答条）**：
  - 「`协同板`」在 `< 768px` 下隐藏三栏分割线，频道树收敛入左侧响应式 `Sheet` 抽屉、主题检视器收敛入右侧 `Sheet` 抽屉；主屏顶部保留「`话题流` | `列表` | `看板`」切换器，单列栈式展示主题列表或选中主题时间线（顶部提供返回列表按钮），选定频道或主题后自动收起左抽屉。
  - 「`协同板 -> 看板`」在 `< 768px` 下自动降级为「状态分段胶囊（`待开始` / `进行中` / `待确认` / `已完成`，单列均分且高度 `>= 44px`）+ 单列主题列表」，禁止多列横向溢出或窄屏看板拖拽。
  - 「`待决收件箱`」在 `< 768px` 下切换为单列 Master-Detail 栈式视图（列表项点击进入详情页并提供返回按钮）。
  - 进入任意待决问答或包含 `open` 提问的主题详情时，选项按钮与答复提交栏**吸底固定在 `--safe-bottom` 安全区**，保障单手拇指即可完成选答与发送，且所有交互按钮维持 `>= 44×44px` 触控热区、输入框 `>= 16px`、`360×780` 与 `390×844` 视口下横向溢出严格为 `0`。
- **执行台（`< 768px`）**：隐藏三栏分割线，主屏幕专注渲染中栏「当前会话消息流 + 底部紧贴派发台」（或「原生活动详情流」）。
- **顶部导航条**：
  - 保留左抽屉触发器（存在 `openInteractionCount > 0` 时展示琥珀色 `tabular-nums` 角标）、内嵌实时 `streamStatus` 状态核心的品牌几何图标（`BrandMark`，保留 `data-testid="brand-stream-dot"`）、`sm:hidden` 在线节点计数摘要、通知渠道直达按钮（保障移动端单次点击手势兼容 Safari Web Push 订阅）、以及右抽屉触发器（存在 `approval > 0` 时展示琥珀色待审批角标，否则存在 `running + queued > 0` 时展示蓝色活跃角标）。
  - 在 `< 640px` 窄屏下，将「接入节点」「API Keys」「主题切换」三个低频管理/外观入口收拢进顶栏右侧「更多」菜单（`DropdownMenu`，触发按钮与菜单项均满足 `>= 44px` 高度），避免窄屏顶栏拥挤；`>= 640px` 维持既有独立按钮展示。
- **左右响应式抽屉（`shadcn/ui` `Sheet`）**：
  - 左抽屉（`FleetThreadsPane`）与右抽屉（`InspectorPane`）适配安全区内边距；左抽屉在移动端禁用工作区芯片拖拽（保留点击直选工作区，防止与竖向滚动手势冲突），在分叉会话成功后自动收起抽屉并切至新分支受控对话流。
  - 右抽屉中点击Queued/Lineage 任一 `Run` 时同步切换对应 `Thread` 与 `Run` 并在移动端自动收起抽屉。
  - 右抽屉的 5 个标签页（`events`、`queue`、`lineage`、`control`、`deliveries`）在 `< 768px` 下采用单行可滑动横向滚动条（`overflow-x-auto`，严禁折行或挤压成窄格，单项高度 `>= 44px`），切换激活标签页时自动调用 `scrollIntoView({ block: "nearest", inline: "nearest" })` 确保当前页签可见。
- **中栏阅读与派单体验**：
  - `ConversationPane` 任务卡片在移动端与桌面端均提供直达右抽屉「过程事件」的快捷按钮（管理员同时支持点击通知状态胶囊直达「投递明细」）；当会话已有历史任务（`threadRuns.length > 0`）时，底部 Composer 在 `< 768px` 下支持一键收折为单行紧凑条（「续聊 `<node>:<project>` · 展开输入指令」），释放手机竖屏阅读高度，展开后自动聚焦指令输入框。
- 全部可交互按钮（含顶栏按钮、更多菜单项、抽屉标签页、筛选胶囊、任务卡片操作与弹窗关闭按钮）、Tab 与列表项在移动端保持至少 `44×44px` 触控热区，页面横向溢出为 `0`，确保无外部 Bot 时仅靠手机浏览器或主屏幕 PWA 即可顺畅完成巡检、审批、阅读与派单闭环。

### 3.3 PWA 清单、零回源 Service Worker 与双模式浏览器通知协调

- **PWA 清单、全平台图标与 iOS Access 凭据透传**：`apps/web/index.html` 声明 `<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />`，确保受 Cloudflare Access 保护域名下的 iOS Safari 主屏幕安装流程携带同源 `CF_Authorization` Cookie，并配置向量图标 `/icons/icon.svg`、双分辨率 `/favicon.ico`（`16×16` + `32×32`，避免 SPA 回退返回 `index.html`）以及满铺不透明正方形 `/icons/apple-touch-icon.png`（`180×180`，防止 iOS 主屏幕出现黑色圆角填底）；`apps/web/public/manifest.webmanifest` 定义 `name`、`short_name`、`start_url: "/"`、`display: "standalone"` 与 `icons`（含 `any` 尺寸 `icon-192.png`、`icon-512.png`、`icon.svg` 与 `purpose: "maskable"` 安全区图标 `icon-maskable-512.png`，统一由 `apps/web/scripts/generate-icons.mjs` 确定性生成）。
- **零回源 Service Worker（`apps/web/public/sw.js`）**：
  - `push` 事件仅调用 `event.data?.json()` 本地解析随帧下发的 RFC 8291 加密载荷（**严禁调用 `fetch('/api/...')`**），避免 Cloudflare Access Cookie 过期时后台唤醒回源失败。
  - 每次 `push` 事件**必须无条件调用** `event.waitUntil(self.registration.showNotification(title, { body, tag, icon: "/icons/icon-192.png", badge: "/icons/badge-96.png", data: { target_url, kind, id } }))`，其中 `badge` 使用透明背景纯白单色剪影（`96×96`）以适配移动端状态栏 Alpha 遮罩，满足 Safari / APNs 对可见通知的强制要求，防止推送权限被吊销。
  - `notificationclick` 事件优先查找并聚焦同源已有客户端窗口（如通过 `client.focus()` + `navigate(target_url)` 或消息定位），无可用窗口时调用 `clients.openWindow(target_url)` 深链定位（`/?workspace=inbox&source=board&id=<msg_id>`、`/?pane=native&session=...&event=...` 或 `/?thread=...&run=...`），由 `App.tsx` 消费并自动切至对应工作区与目标条目。
- **双模式浏览器通知协调器（`apps/web/src/lib/browser-notify.ts`）**：
  - 当当前设备已启用且激活 Web Push 主通道时，自动抑制同源页内 `window.Notification` 重复弹窗（由 Web Push + `tag` 唯一负责系统级提示）。
  - 当尚未配置 VAPID、未订阅 Web Push 或处于仅页内提醒降级模式时，利用 `navigator.locks.request("ahub-notify-" + eventKey, { ifAvailable: true }, ...)` 与 `BroadcastChannel("ahub-notify-dedup")` 协调多标签页，确保同一事件在多开标签页中至多弹出一次页内系统通知。

## 4. `@dnd-kit` 四处高价值拖拽交互规格

协同板与执行台共享顶层唯一 `<DndContext>` 与 `<DragOverlay dropAnimation={null}>`，在以下四处高价值场景启用 `@dnd-kit` 拖拽：

1. **待执行队列优先级重排**
   - 作用域：右栏「节点排队甲板」中状态为 `queued` 的任务列表（`SortableContext` + `verticalListSortingStrategy`）。
   - 交互结果：释放拖拽后先乐观更新 Zustand 队列顺序，再调用 `POST /api/v1/runs/reorder`；若请求失败或该任务在拖拽瞬间已被节点认领，回滚顺序并弹出 Toast 提示。
2. **跨节点派单改派与会话分叉**
   - 作用域：将 `queued` 状态的 Run 卡片或 `Thread` 列表项拖入左栏另一台处于 `online` 状态的节点卡片。
   - 交互结果：拖入 `queued` Run 时直接调用 `PATCH /api/v1/runs/:id` 改派目标节点（自动校验目标节点是否存在同名 `project_key`；仅允许未建连的单轮新会话改派并同步更新线程节点与目录，多轮历史会话改派返回 `409 INVALID_STATE_TRANSITION`）；拖入已有 `Thread` 时弹出确认对话框，执行「Fork 到目标节点」（`POST /api/v1/threads/:id/fork`）。
3. **常用会话置顶排序**
   - 作用域：左栏置顶会话区（`pinned === true`），拖拽调整日常高频会话顺序并调用 `PATCH /api/v1/threads/:id` 持久化 `sort_order`。
4. **协同板 4 列看板同列重排与跨列流转（Slice 1b）**
   - 作用域：协同板 `看板` 视角中处于 `todo` / `in_progress` / `blocked` / `done` 4 个活跃列的主题卡片，且**仅当桌面端选中单个频道（`selectedChannel !== null`）时启用**（未选频道或 `< 768px` 移动端禁用拖拽）。
   - 交互结果：释放拖拽后乐观更新目标列 `status` 与 `sort_order` 顺序，调用 `POST /api/v1/board/topics/reorder` 提交目标列的 `{ channel, status, ordered_topic_ids }` 持久化并接收 `board.topic_updated` 广播校准；若请求失败则完整回滚本地列表并提示错误。

### 传感器与防误触约束

- 拆分鼠标与触屏传感器：配置 `MouseSensor`（`activationConstraint: { distance: 6 }`）与 `TouchSensor`（`activationConstraint: { delay: 220, tolerance: 6 }`），拖拽手柄施加 `touch-none`（`touch-action: none`），防止桌面端点击误触发以及移动端滑动抽屉列表时抢占滚动手势。
- 在移动端左抽屉（`inDrawer`）内禁用工作区芯片跨栏拖拽，保留点击即选中工作区功能。
- 同时注册 `KeyboardSensor`（配合 `sortableKeyboardCoordinates`）满足键盘无障碍操作。
- 统一在顶层渲染单个 `<DragOverlay>` 浮层卡片，拖拽原位元素保持 `opacity-40` 占位。

## 5. `zustand` 状态切片契约

前端状态强制拆分为五个职责单一的 Store，避免单一大对象引发全局重渲染：

```ts
// 1. 机群与节点目录切片 (apps/web/src/stores/fleet-store.ts)
export interface FleetState {
  nodes: NodeRecord[];
  selectedNodeId: string | null;
  setNodes: (nodes: NodeRecord[]) => void;
  upsertNode: (node: NodeRecord) => void;
  selectNode: (nodeId: string | null) => void;
}

// 2. 受控会话、任务与事件流切片 (apps/web/src/stores/task-store.ts)
export interface TaskState {
  threads: ThreadRecord[];
  runs: RunRecord[];
  // 单任务事件流本地保留上限 500 条，防止长时间驻留内存泄漏
  eventsByRunId: Record<string, RunEventItem[]>;
  fullOutputByRunId: Record<string, string>;
  selectedThreadId: string | null;
  selectedRunId: string | null;
  setThreads: (threads: ThreadRecord[]) => void;
  upsertThread: (thread: ThreadRecord) => void;
  setRuns: (runs: RunRecord[]) => void;
  upsertRun: (run: RunRecord) => void;
  appendEvents: (runId: string, incoming: RunEventItem[]) => void;
  setFullOutput: (runId: string, outputMd: string) => void;
  selectThread: (threadId: string | null) => void;
  selectRun: (runId: string | null) => void;
}

// 3. 工作台视图、鉴权与草稿切片 (apps/web/src/stores/workbench-store.ts)
export type WorkspaceMode = "board" | "inbox" | "runs";
export type InspectorTab = "events" | "queue" | "lineage" | "control" | "deliveries";
export type LeftRailTab = "threads" | "native" | "nodes";

export interface WorkbenchState {
  theme: "dark" | "light";
  token: string;
  authStatus: "checking" | "authenticated" | "unauthenticated";
  authKind: string | null;
  authScope: "admin" | "client" | "node" | null;
  streamStatus: "connecting" | "connected" | "disconnected";
  workspaceMode: WorkspaceMode; // 默认 "board"
  leftTab: LeftRailTab;
  activeTab: InspectorTab;
  threadQuery: string;
  onboardingOpen: boolean;
  keysDialogOpen: boolean;
  browserNotifyOpen: boolean;
  mobileLeftOpen: boolean;
  mobileRightOpen: boolean;
  errorBanner: string | null;
  composer: ComposerDraft;
  setTheme: (theme: "dark" | "light") => void;
  toggleTheme: () => void;
  setToken: (token: string) => void;
  setAuthState: (
    authStatus: WorkbenchState["authStatus"],
    authKind?: string | null,
    authScope?: WorkbenchState["authScope"]
  ) => void;
  setStreamStatus: (status: WorkbenchState["streamStatus"]) => void;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
  setLeftTab: (tab: LeftRailTab) => void;
  setActiveTab: (tab: InspectorTab) => void;
  setThreadQuery: (q: string) => void;
  setOnboardingOpen: (open: boolean) => void;
  setKeysDialogOpen: (open: boolean) => void;
  setBrowserNotifyOpen: (open: boolean) => void;
  setMobileLeftOpen: (open: boolean) => void;
  setMobileRightOpen: (open: boolean) => void;
  setErrorBanner: (msg: string | null) => void;
  patchComposer: (patch: Partial<ComposerDraft>) => void;
}

// 4. 原生活动与多渠道投递切片 (apps/web/src/stores/native-activity-store.ts)
export interface NativeActivityState {
  events: NativeEventView[];
  openInteractionCount: number;
  selectedSessionKey: string | null;
  selectedEventId: string | null;
  viewMode: "sessions" | "timeline";
  filterMode: "all" | "unacked" | "failed";
  onlySelectedNode: boolean;
  searchQuery: string;
  deliveriesBySourceKey: Record<string, NotificationDeliveryRecord[]>;
  pushConfig: PushConfigRecord | null;
  subscriptions: WebPushSubscriptionRecord[];
  hydrateNativeEvents: (events: NativeEventView[], openCount?: number) => void;
  upsertNativeEvent: (event: NativeEventView, openCount?: number) => void;
  setDeliveries: (sourceKey: string, deliveries: NotificationDeliveryRecord[]) => void;
  upsertDelivery: (delivery: NotificationDeliveryRecord) => void;
  setPushConfig: (config: PushConfigRecord | null) => void;
  setSubscriptions: (subscriptions: WebPushSubscriptionRecord[]) => void;
  selectSession: (sessionKey: string | null) => void;
  selectEvent: (eventId: string | null) => void;
  setViewMode: (mode: NativeActivityState["viewMode"]) => void;
  setFilterMode: (mode: NativeActivityState["filterMode"]) => void;
  setOnlySelectedNode: (only: boolean) => void;
  setSearchQuery: (q: string) => void;
}

// 5. 跨机协同板与待决提问切片 (apps/web/src/stores/board-store.ts)
export type BoardTopicFilter = "active" | "open_questions" | "recent";
export type BoardViewMode = "timeline" | "list" | "kanban";
export type BoardKanbanColumnStatus = "todo" | "in_progress" | "blocked" | "done";

export interface BoardState {
  channels: BoardChannelSummary[];
  topics: BoardTopic[];
  messagesByTopicId: Record<string, BoardMessage[]>;
  eventsCursor: number;
  openBoardQuestionCount: number;
  selectedChannel: string | null;
  selectedTopicId: string | null;
  focusedTopicId: string | null;
  topicFilter: BoardTopicFilter;
  viewMode: BoardViewMode;
  kanbanMobileStatus: BoardKanbanColumnStatus;
  searchQuery: string;
  boardPermissionDenied: boolean;
  hydrateBoard: (payload: {
    channels: BoardChannelSummary[];
    topics: BoardTopic[];
    eventsCursor?: number;
    openQuestionCount?: number;
  }) => void;
  setOpenBoardQuestionCount: (count: number) => void;
  upsertTopic: (topic: BoardTopic) => void;
  upsertTopics: (topics: BoardTopic[]) => void;
  setTopicMessages: (topicId: string, messages: BoardMessage[], cursor?: number) => void;
  appendMessage: (topicId: string, message: BoardMessage, cursor?: number) => void;
  applyQuestionAnswered: (payload: {
    question: BoardMessage;
    answer: BoardMessage;
    topic?: BoardTopic;
    cursor?: number;
    openQuestionCount?: number;
  }) => void;
  selectChannel: (channel: string | null) => void;
  selectTopic: (topicId: string | null) => void;
  setFocusedTopicId: (topicId: string | null) => void;
  setTopicFilter: (filter: BoardTopicFilter) => void;
  setViewMode: (mode: BoardViewMode) => void;
  setKanbanMobileStatus: (status: BoardKanbanColumnStatus) => void;
  setSearchQuery: (q: string) => void;
  setBoardPermissionDenied: (denied: boolean) => void;
  reset: () => void;
}
```

> 纯推导辅助函数 `deriveNativeAttentionState(event, allEvents, nowMs)` 与后端 `02-data-and-state-contracts.md` §5.1 保持逐字一致：当 `event_kind === "interaction_needed"` 时按 `acked` (`ack_at !== null`) -> `superseded` (`native_session_id !== ""` 且同 `(node_id, agent, native_session_id)` 存在更大 `(created_at, id)`) -> `stale` (`> 24h`) -> `open` 顺序推导，前端在收到新事件或 `ack` 后可即时重算无幽灵红点。

### 无本地 Token 时的 Cloudflare Access 会话探测与 `client` Scope 隔离

- 页面加载时即使 `localStorage` 中不存在 `ahub-token`，工作台也必须主动发起同源会话探测（`GET /api/v1/auth/me` 配合初始 REST 拉取，`credentials: "same-origin"`），以无缝激活 Cloudflare Access 登录态（同源 `CF_Authorization` Cookie）并建立 `/ws/stream` 连接；`GET /api/v1/auth/me` 同时回填 `authKind` 与 `authScope`（`principal.scope`）。
- **严格 `admin` Scope 门禁**：仅当 `authScope === "admin"` 时连接全局无参 `/ws/stream` 并发起 `GET /api/v1/keys`、`GET /api/v1/native-events`、`GET /api/v1/push/config`、`GET /api/v1/push-subscriptions` 与 `GET /api/v1/runs/:id/deliveries`；当 `authScope === "client"` 时，前端保持不建立全局 `/ws/stream`（仅在订阅单主题或单任务时按需使用 `?topic_id=` / `?run_id=`）、正常加载授权前缀内的协同板与 `runs` 待审批收件箱、隐藏原生活动与通知渠道入口，且**零触发上述管理员请求（控制台与网络层零 `403` / 零报错）**。
- 仅当后端明确返回 `401 UNAUTHORIZED` 时，将 `authStatus` 置为 `"unauthenticated"`、停止 WebSocket 自动重连循环，并提示用户在「接入节点 -> Token 登录」配置访问 Token。

### 增量同步与断线补偿规则

- WebSocket `/ws/stream` 收到 `snapshot` 帧时调用 `setNodes`、`setThreads`、`setRuns`、`hydrateNativeEvents(frame.native_events ?? [], frame.open_interaction_count)`，并在携带 `open_board_question_count` 时调用 `setOpenBoardQuestionCount(frame.open_board_question_count)`；每次重连成功后重新拉取 REST 快照并校准一次，避免断网期间遗漏终态、原生活动或协同板变更。
- 收到 `native_event.upserted` 时调用 `upsertNativeEvent(frame.event, frame.open_interaction_count)`；收到 `delivery.updated` 时调用 `upsertDelivery(frame.delivery)` 同步更新投递明细；收到 `run.updated` 时调用 `upsertRun(frame.run)` 同步刷新 `notify_status` 与 `deliveries_summary`。
- 收到 `board.topic_updated` 时调用 `upsertTopic(frame.topic)`（并更新 `openBoardQuestionCount`）；收到 `board.message_created` 时调用 `appendMessage(frame.message.topic_id, frame.message, frame.cursor)` 及按需更新主题与未答复计数；收到 `board.question_answered` 时调用 `applyQuestionAnswered(...)` 同步更新提问状态、答复消息与恢复后的主题状态。
- `appendEvents` 依据 `event.seq` 进行严格去重与单调排序，超过 `500` 条时从头部裁掉早期日志并保留「已归档更早事件，点击加载」提示。

## 6. 受控界面文案规范

| 界面场景 | 固定文案表达 |
| --- | --- |
| 空状态：工作台首次使用 | 「尚未创建任务。请在底部选择节点与项目目录并输入指令。」 |
| 空状态：筛选无结果 | 「当前筛选条件下没有匹配的会话或任务。尝试清除节点或状态筛选条件。」 |
| 空状态：目标节点离线 | 「目标节点当前离线。现在提交的任务将安全进入排队队列，并在节点上线后自动开始执行。」 |
| 空状态：原生活动首次使用 | 「暂无本地原生会话记录。请在节点 `node.json` 中启用 `native_notify.enabled` 并安装官方 Hook。」 |
| 空状态：原生活动筛选无结果 | 「当前筛选条件下没有匹配的原生活动记录。尝试切换筛选条件或清除搜索关键字。」 |
| 原生活动只读物理边界提示 | 「原生会话运行在节点本机终端中，不支持从云端向交互式 TTY 注入指令或强杀进程。」 |
| `grok` 新建受控任务回退提示 | 「`grok` 暂不支持无头受控执行，已自动切换为该节点可用的受控 Agent。」 |
| 浏览器通知权限被拒恢复指引 | 「浏览器通知权限已被拒绝，请在浏览器站点设置中重新允许通知后刷新页面。」 |
| 权限受限提示 | 「当前凭证无权查看系统密钥管理。请使用管理员账号通过 Cloudflare Access 登录。」 |
| 危险操作：取消运行中任务 | 「确认取消任务？系统将立即向目标节点发送进程组终止信号（SIGTERM），已产生的本地文件改动不会自动回滚。」 |
| 危险操作：级联取消任务树 | 「确认级联取消整棵任务树？此操作将同步终止该主任务及其衍生出的全部排队与运行中子任务。」 |
| 空状态：协同板首次使用 | 「暂无协同主题。点击新建主题或通过 `ahub board post` 发起跨机协作。」 |
| 空状态：`client` 无频道前缀授权 | 「当前凭证尚未分配协同板频道前缀权限（`allowed_board_prefixes`）。请联系管理员在凭证管理中授权后再访问。」 |
| 协同板非 `admin` 提问只读提示 | 「仅管理员可答复协同板阻塞提问。请使用管理员账号登录后在收件箱或当前主题作答。」 |
| 空状态：待决收件箱全清空 | 「当前没有待确认或待审批的阻塞事项。」 |
| 移动端吸底问答确认提示 | 「提交答复后将立即唤醒等待中的本地或远端会话。」 |
| 危险操作：吊销凭证 | 「确认吊销此凭证？吊销立即生效；若该凭证属于在线节点，对应节点连接将被立即断开。」 |
| 看板未选单频道拖拽引导 | 「当前处于跨频道聚合视图，看板拖拽仅在单个频道内启用。请先从左侧频道树或下方按钮切换至单个频道。」 |
