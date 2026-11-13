# agent-hub

`agent-hub` 是面向多设备、多本地 Coding Agent 的云端任务中心与跨机调度底座。云端控制面运行于 Cloudflare（Workers、Static Assets、D1、Durable Objects WebSocket Hibernation 与 Queues，默认实例域名 `https://ahub.bobocai.win`，可通过 `AHUB_URL` 自定义），边缘节点与调用端统一使用零外部依赖的 Go 静态单二进制 `ahub`。本文档仓库当前阶段交付完整的架构设计、数据库契约、协议接口、CLI 规范、前端工程标准与实施路线图。

## 核心设计原则

1. **Web 任务中心独立完备**：不依赖任何外部聊天机器人，浏览器端即可独立完成多机节点监控、任务派发、多轮会话续接、流式输出查看、权限审批跳转、拖拽编排队列与整树任务取消。
2. **统一 CLI 赋能任意 Agent**：外部助手（如 Grok Bot）与各机器上的本地 Agent 均通过同一个 `ahub` CLI 及配套 `SKILL.md` 调用任务中心，不再手拼 HTTP 请求或解析临时文本标记。
3. **纯出站零隧道节点**：各工作机无需公网 IP，也无需部署 `cloudflared`。本地守护进程 `ahub node serve` 仅维持单条出站 `wss://` 长连接并与云端 D1 租约状态机配合，确保机器休眠或断网期间的任务持久入队、上线自动补领。
4. **严格前端工程约束**：Web 控制台锁定 `shadcn/ui`（`radix-nova` 预设）、`lucide-react`、`motion/react`、`react-resizable-panels`、`@dnd-kit` 与 `zustand` 的「每类职责唯一库」白名单，组件源代码完全可控，杜绝重复依赖与模板化样式膨胀。

## 目标仓库结构蓝图

以下目录契约用于后续编码阶段的单仓多包组织，当前仓库优先落盘 `AGENTS.md`、`README.md` 与 `docs/` 规格层：

```text
agent-hub/
├── AGENTS.md                         # 项目级契约治理、Go/前端门禁与安全准则
├── README.md                         # 项目入口与文档索引
├── apps/
│   ├── hub-worker/                   # Cloudflare Worker API、D1 迁移、DO NodeHub、Queue 消费者
│   └── web/                          # React 19 + Vite + shadcn/ui (radix-nova) 控制台
├── cmd/
│   └── ahub/                         # Go CLI 与守护进程统一入口
├── internal/
│   ├── api/                          # REST 与 WebSocket 客户端
│   ├── cli/                          # 调用端命令实现（run / wait / result / cancel / nodes）
│   ├── config/                       # 本地配置与 0600 凭据读写
│   ├── daemon/                       # node serve 守护循环、心跳续租与本地 workdir 互斥锁
│   ├── runner/                       # 进程组隔离、最小环境变量白名单与 Agent 适配器
│   ├── selfupdate/                   # SHA-256 原子自更新
│   └── service/                      # macOS LaunchAgent 与 Linux systemd --user 托管生成
├── skills/
│   └── ahub/
│       └── SKILL.md                  # 嵌入 ahub 二进制的 Agent 调用指南
├── evals/
│   ├── substrate/                    # Plane 1：ahub-fakeagent 与 I-1~I-7 混沌不变量套件
│   ├── formal/                       # Plane 1：D1/DO/Cron 状态机 TLA+ 模型检验
│   ├── agent-cli/                    # Plane 2：盲测沙箱、E-01~E-08 黄金场景与轨迹评分器
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
| [run-create.schema.json](docs/schemas/run-create.schema.json) | `POST /api/v1/runs` 请求体 JSON Schema（Draft 2020-12） | 接口校验与契约测试 |
| [run-record.schema.json](docs/schemas/run-record.schema.json) | `Run` 标准数据结构与 `ahub --json` 输出信封 Schema | 接口校验与契约测试 |
| [ws-frames.schema.json](docs/schemas/ws-frames.schema.json) | `/ws/node` 与 `/ws/stream` 双向 WebSocket JSON 帧联合 Schema | 协议编解码与契约测试 |

## 阅读顺序建议

1. 首次了解系统边界与设计取舍，先读 [01-architecture.md](docs/01-architecture.md)。
2. 开展 Cloudflare 后端开发前，依次核对 [02-data-and-state-contracts.md](docs/02-data-and-state-contracts.md) 与 [03-api-and-ws-protocol.md](docs/03-api-and-ws-protocol.md)。
3. 开展 Go 单二进制 `ahub` 开发，以 [04-ahub-cli-and-node-daemon.md](docs/04-ahub-cli-and-node-daemon.md) 与 [03-api-and-ws-protocol.md](docs/03-api-and-ws-protocol.md) 为准。
4. 开展 Web 任务中心前端开发，严格执行 [05-web-frontend-spec.md](docs/05-web-frontend-spec.md) 的依赖白名单与交互契约。
5. 部署与分阶段验收，遵循 [06-roadmap-and-verification.md](docs/06-roadmap-and-verification.md) 与 [07-eval-framework.md](docs/07-eval-framework.md)。
