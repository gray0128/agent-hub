# 06 实施路线图、部署配置与验收矩阵

本文档定义 `agent-hub` 在 Cloudflare（绑定域名 `ahub.bobocai.win`）上的部署配置蓝图、成本配额边界、四个可独立验证的实施切片，以及端到端验收测试矩阵。

## 1. `wrangler.jsonc` 部署蓝图

控制面 `apps/hub-worker/wrangler.jsonc` 采用单一 Worker 托管模式，同时承载 REST API、Durable Object `NodeHub`、Queue Consumer、Cron Trigger 以及 Web 前端静态资源：

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "agent-hub",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "routes": [
    {
      "pattern": "ahub.bobocai.win/*",
      "zone_name": "bobocai.win"
    }
  ],
  "assets": {
    "directory": "../web/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/ws/*", "/dl/*", "/skill/*"]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "agent-hub-db",
      "database_id": "<YOUR_D1_DATABASE_ID>",
      "migrations_dir": "migrations"
    }
  ],
  "durable_objects": {
    "bindings": [
      {
        "name": "NODE_HUB",
        "class_name": "NodeHub"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["NodeHub"]
    }
  ],
  "queues": {
    "producers": [
      {
        "binding": "NOTIFY_QUEUE",
        "queue": "ahub-outbound-notify"
      }
    ],
    "consumers": [
      {
        "queue": "ahub-outbound-notify",
        "max_batch_size": 10,
        "max_batch_timeout": 5,
        "max_retries": 5,
        "dead_letter_queue": "ahub-outbound-notify-dlq"
      }
    ]
  },
  "triggers": {
    "crons": ["* * * * *"]
  },
  "vars": {
    "HUB_PUBLIC_URL": "https://ahub.bobocai.win",
    "DEFAULT_MAX_DEPTH": "1",
    "LEASE_TTL_SECONDS": "90"
  }
}
```

### 敏感机密注入（严禁写入 `wrangler.jsonc`）

通过 `wrangler secret put` 注入运行时机密：

- `CF_ACCESS_TEAM_DOMAIN` 与 `CF_ACCESS_AUD`：用于校验 Cloudflare Access `Cf-Access-Jwt-Assertion` JWT。
- `BOOTSTRAP_ADMIN_TOKEN_SHA256`：首个 `admin` 凭证摘要（仅首次初始化使用，随后在数据库签发受管 `api_keys`）。
- `GROK_WEBHOOK_URL` 与 `GROK_WEBHOOK_KEY`（可选）：当任务传 `--notify grok` 时由 Queue Consumer 回调。

## 2. Cloudflare 配额与成本边界

| 组件 | Workers Free 方案额度 | Workers Paid（5 USD/月）额度 | 本系统实际消耗特征 |
| --- | --- | --- | --- |
| **Workers 请求** | 10 万次/天 | 1,000 万次/月 | 正常个人多机调度日均约数百至数千次请求，Free 额度可覆盖日常启动期 |
| **D1 SQLite** | 500 万次行读/天、10 万次行写/天、总容量 5 GB | 250 亿次行读/月、5,000 万次行写/月 | 单机或小机群日均写入在数千行级；需注意 `run_events` 定期裁剪历史旧日志避免行写逼近上限 |
| **Durable Objects (WS Hibernation)** | 含 Free 额度（WS Hibernation 休眠期间不计活跃时长，支持 SQLite 存储） | 100 万次请求/月起 + 活跃时长计费 | 节点空闲保持 `wss://` 长连接几乎零成本；高频流式 `run.event` 需由守护端按 250ms 节流合并帧发送 |
| **Cloudflare Queues** | 1 万次操作/天、最长保留 24 小时 | 100 万次操作/月、最长保留 14 天 | 仅用于终态通知（约 3 ops/通知），日均消耗极低 |

> **工程优化提示**：节点守护端转发 Agent 标准输出或 NDJSON 事件流时，应按每 `250ms` 合并为一个 `run.event` 批次发送（状态切换与审批事件除外），避免逐 Token 发帧触发不必要的多余 DO 请求计数。

## 3. 四阶段可验证实施切片（Slices）

所有后续编码按以下 4 个可独立编译、部署与验收的切片推进，严禁一次性混合提交：

### Slice 1：云端内核与 `ahub` 单机命令行闭环

- **交付内容**：
  - `apps/hub-worker`：实现 D1 迁移 `0001_init.sql`、三级 API Key 鉴权、REST 核心端点（`nodes`、`threads`、`runs`、`claim`、`heartbeat`、`complete`、`cancel`）、`NodeHub` DO WebSocket Hibernation 及 Cron 租约巡检。
  - `cmd/ahub` + `internal/*`：实现单二进制 `ahub` 的调用端（`nodes`、`run`、`wait`、`result`、`cancel`）与守护端（`node serve` + 至少接入 `agy`/`pi`/`omp` 适配器及 `Setpgid` 进程组强杀）。
  - `evals/substrate`：同步交付受控故障注入替身 `ahub-fakeagent` 与底座不变量套件（`I-1`~`I-7`），接入 `make eval-fast`。
- **完成条件**：在单台开发机通过本地或线上 Worker 完成 `ahub node serve` 上线 -> `ahub run - --wait 45s` -> `ahub run --thread` 续接 -> `ahub cancel --cascade` 全链路命令行实测，且 `make eval-fast` 全量通过。

### Slice 2：Web 任务中心控制台（`radix-nova`）

- **交付内容**：
  - `apps/web`：严格按 [05-web-frontend-spec.md](05-web-frontend-spec.md) 搭建 Vite + React 19 + `shadcn/ui` (`radix-nova`) + `lucide-react` + `motion/react` + `react-resizable-panels` + `@dnd-kit` + `zustand` 三栏工作台与移动端响应式抽屉。
  - 由 `apps/hub-worker` Static Assets 托管，接入 Cloudflare Access 校验。
- **完成条件**：构建产物零报错上线 `https://ahub.bobocai.win`；不依赖任何外部 Bot 独立完成桌面与手机浏览器的创建会话、查看实时事件流、拖拽队列重排、跨节点分叉与签发/吊销 Key。

### Slice 3：多机机群接入、系统托管与自举分发

- **交付内容**：
  - 完成 `GET /dl/install.sh`、`GET /dl/version.json`、GitHub Actions 多平台 `CGO_ENABLED=0` 构建发布及 `ahub update` 原子自替换。
  - 完成 `ahub node service install`（macOS `~/Library/LaunchAgents/` 与 Linux `~/.config/systemd/user/`）。
- **完成条件**：至少 2 台不同机器并行接入机群，验证同机跨 `workdir` 并发、同 `workdir` 串行排队，以及机器休眠/断网恢复后的自动重连补领。

### Slice 4：Cloudflare Queues 通知总线与外部助手接入

- **交付内容**：
  - 打通 `ahub-outbound-notify` Queue Consumer 回调外部 Routine Webhook 与 DLQ 失败落标。
  - 内嵌并通过 `ahub skill print` / `GET /skill/SKILL.md` 分发配套 Skill，配置外部助手（如 Grok Bot）使用 `ahub` CLI 派单。
- **完成条件**：验证超过 `45s` 的长任务无缝从 `ahub run --wait 45s --notify grok` 转入 Queue 异步回调唤醒，再由调用方通过 `ahub result <run_id> --json` 拉取结果闭环。

## 4. 端到端验收测试矩阵

每次发布前须逐项验证以下红线场景并保留实测证据；完整的三平面自动化评测框架（含 `ahub-fakeagent` 混沌注入、`E-01`~`E-08` 盲测轨迹评分、CDP 前端等价断言与变异门禁）详见 [07-eval-framework.md](07-eval-framework.md)：

| 测试编号 | 验证场景 | 输入与触发条件 | 预期通过标准 |
| --- | --- | --- | --- |
| **V-01** | **递归深度拦截** | 从一个已在 `depth=1` 运行的 Agent 子进程内调用 `ahub run` 派单 | 云端返回 `409 DEPTH_LIMIT_EXCEEDED`，CLI 返回退出码 `78`，绝不入队 |
| **V-02** | **跨机环路拦截** | 任务 A 在 `(node1, dir1)` 运行时委派给 `(node2, dir2)`，后者再试图委派回 `(node1, dir1)` | 云端检测 `root_run_id` 祖先链冲突，返回 `409 DELEGATION_CYCLE_DETECTED` |
| **V-03** | **进程组强杀与目录锁释放** | 在运行耗时命令期间通过 Web UI 或 `ahub cancel` 取消任务 | DO 下发 `hub.abort`，节点向 `-pgid` 发送终止信号，子进程及衍生进程全部退出，对应 `workdir` 锁立即释放 |
| **V-04** | **离线排队与重连补领** | 停止某节点 `ahub node serve`，在 Web 端向其派发 2 个任务后再启动节点 | 离线期间任务保持 `queued` 不丢；节点握手 `node.hello` 后自动触发 `claim` 按优先级依次执行 |
| **V-05** | **租约过期僵尸回收** | `SIGKILL` 强杀正在执行任务的节点进程模拟机器断电 | 90 秒后 Cron 扫描将其置为 `failed`（`error_code = NODE_LEASE_EXPIRED`）并释放节点计数，绝不静默重放 |
| **V-06** | **人工审批放行闭环** | 触发 `agy` 敏感工具拦截进入 `needs_approval` | Web 控制台与 CLI（退出码 `20`）准确输出 `remote_control_url`；放行后状态恢复 `running` 直至 `done` |
| **V-07** | **前端依赖白名单门禁** | 运行静态扫描脚本检查 `apps/web/package.json` 与源码导入 | 无任何黑名单 UI/图标/动画/拖拽/状态重复库，且源码中不存在 `transition: all` 或 `framer-motion` |

### 前端零重复依赖检查脚本示例（CI 门禁）

```bash
node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("apps/web/package.json", "utf8"));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const banned = [
  "@mui/material", "antd", "@chakra-ui/react", "@mantine/core",
  "@radix-ui/react-icons", "@heroicons/react", "react-icons", "@tabler/icons-react",
  "framer-motion", "gsap", "react-spring", "@formkit/auto-animate",
  "allotment", "react-split",
  "react-beautiful-dnd", "@hello-pangea/dnd", "react-dnd", "sortablejs",
  "redux", "@reduxjs/toolkit", "jotai", "recoil", "mobx", "valtio"
];
const found = banned.filter((name) => Object.prototype.hasOwnProperty.call(deps, name));
if (found.length > 0) {
  console.error("Banned duplicate frontend dependencies found:", found);
  process.exit(1);
}
console.log("FRONTEND_DEPS_CLEAN");
'
```
