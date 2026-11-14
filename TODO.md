# TODO

## Todo

## Doing

## Done

- [x] 将节点上的安装/更新过程包装成一段可直接丢给 Agent 完成的自举 Prompt（交付 `GET /dl/bootstrap.md` 自举指南、`ahub node init` / `ahub node status` 幂等脱敏原语、Linux 服务升级重启与 macOS 隔离属性清理、Web「接入节点」弹窗修复与 Prompt 复制，以及 [README.md](./README.md) 入口文档更新）
- [x] 多 Bot 独立加密 Webhook 投递与 `client` API Key 节点亲和绑定（`0002_multi_bot_webhooks.sql`、AES-256-GCM 密文存储、队列按触发 Key 路由）
- [x] Cloudflare Access 单域名零口令鉴权（同源 `CF_Authorization` Cookie 自动提取、RS256 JWKS 验签、非幂等请求与 WebSocket 升级跨站防护、前端 `/api/v1/auth/me` 自动探活）
- [x] macOS `AhubDaemon.app` 固定签名（CDHash）TCC 宿主包装、`SIGHUP` 优雅排空热重载，以及 `ahub node serve` 握手/心跳/工作区扫描防假死自愈机制
