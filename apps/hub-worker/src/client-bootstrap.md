# `agent-hub`（`ahub`）Grok Bot 与纯调用端自举接入指南

> **面向云端外部助手（Grok Bot 等）与纯调用端 Agent**：
> 请直接调用终端工具代劳完成以下步骤，不要把基础安装命令抛给用户手工执行。
>
> **角色与安全边界铁律**：
> 1. 当前环境仅为**纯 `client` 调用端**，**严禁执行** `ahub node init`、`ahub node serve` 或 `ahub node service` 等节点守护命令；
> 2. 全程**严禁**使用 `cat`、`head`、`less`、`env` 等命令读取或打印 `credentials` 文件或 `$AHUB_TOKEN` 原文，仅允许通过 `ahub auth status --json` 检查脱敏状态；
> 3. 若用户提供调用端 Token（`ahub_cli_...`），仅允许通过标准输入管道 `printf '%s' ... | ahub auth login --token-stdin` 写入，严禁在终端日志或回复中复述明文 Token。

---

## 步骤 1：探测并安装或原地更新 `ahub`（跳过节点守护重启）

先定位当前环境是否已有可用 `ahub`（优先检查 `command -v ahub` 与 `$HOME/.local/bin/ahub`）。

### 分支 1A：尚未安装 `ahub`（首次安装或云端沙箱冷重建）

```sh
curl -fsSL __HUB_URL__/dl/install.sh | AHUB_URL=__HUB_URL__ sh
AHUB_BIN="$HOME/.local/bin/ahub"
export PATH="$HOME/.local/bin:$PATH"
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
  if [ -f "$rc" ]; then
    grep -qs '\.local/bin' "$rc" 2>/dev/null || printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
  fi
done
```

### 分支 1B：已安装 `ahub`（仅升级纯调用端二进制）

```sh
AHUB_BIN="$(command -v ahub 2>/dev/null || true)"
if [ -z "$AHUB_BIN" ]; then
  for cand in "$HOME/.local/bin/ahub" "$HOME/.local/bin/ahub.exe"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then AHUB_BIN="$cand"; break; fi
  done
fi
"$AHUB_BIN" --url __HUB_URL__ update --no-restart --json
```

> 说明：`--no-restart` 专用于外部调用端，仅原子替换 CLI 二进制而不探测或重启任何后台守护进程。

---

## 步骤 2：同步并读取最新跨机调度 `SKILL.md`

执行 `ahub skill install` 写入 `~/.agents/skills/ahub/SKILL.md`，并同步至已安装但未建立软链接的宿主技能目录（若 `.grok` 存在或当前在 Grok Bot 环境，同步写入 `~/.grok/skills/ahub/SKILL.md`），随后通读 `~/.agents/skills/ahub/SKILL.md`：

```sh
"$AHUB_BIN" skill install --json
for host_dir in "$HOME/.grok/skills" "$HOME/.claude/skills" "$HOME/.codebuddy/skills" "$HOME/.cursor/skills" "$HOME/.trae/skills"; do
  if [ -d "$(dirname "$host_dir")" ] && [ ! -L "$host_dir" ]; then
    mkdir -p "$host_dir/ahub"
    cp "$HOME/.agents/skills/ahub/SKILL.md" "$host_dir/ahub/SKILL.md"
  fi
done
```

---

## 步骤 3：多 Bot 凭据隔离检查与连通性核验

> **同账号共享云端 Linux `$HOME` 约束**：例如多个 Grok Bot 共用同一台持久云端主机目录时，不同 Bot 拥有各自独立的 `allowed_nodes` 白名单与加密 Webhook。**严禁多个 Bot 混写默认 `~/.config/ahub/credentials`**。

先检查用户是否在本次指令中指定了专属 `AHUB_CONFIG_DIR`（例如 `export AHUB_CONFIG_DIR="$HOME/.config/ahub-bots/<bot_slug>"`），然后执行脱敏状态检查：

```sh
"$AHUB_BIN" --url __HUB_URL__ auth status --json
```

### 分支 3A：`has_token: true`（已通过环境变量 `AHUB_TOKEN` 或隔离凭据目录配置密钥）

直接调用控制面核验鉴权主体与可访问节点范围：

```sh
"$AHUB_BIN" --url __HUB_URL__ auth status --verify --json
```

### 分支 3B：`has_token: false` 且用户已在指令中提供了 `client` Token（`ahub_cli_...`）

若环境中未注入 `AHUB_TOKEN`，必须先按 Bot 标识隔离配置目录（未提供具体名称时默认 `default`），再通过标准输入管道安全校验并写入 `0600` 凭据：

```sh
BOT_SLUG="${AHUB_BOT_SLUG:-default}"
export AHUB_CONFIG_DIR="${AHUB_CONFIG_DIR:-$HOME/.config/ahub-bots/$BOT_SLUG}"
printf '%s' "$CLIENT_TOKEN" | "$AHUB_BIN" auth login --url __HUB_URL__ --token-stdin --json
```

### 分支 3C：`has_token: false` 且尚未提供 Token

暂停接入流程，引导用户前往 `__HUB_URL__` ->「API Keys 与 Bot Webhook 管理」创建或核对 `client` 角色密钥：
1. 在「允许节点」中勾选该 Bot 允许调度的工作机（留空允许全部）；
2. 如需后台任务完成后自动回调，填入该 Bot 的「Webhook URL」与「Webhook Bearer Key」（若 Grok Bot 中文桌面端 Routine 面板未展示这两个字段，可用同一账号访问 `https://cursor.com/automations` 查看并复制）；
3. 建议将该 `client` Token 配置到当前 Bot 平台的环境变量 Secrets（键名 `AHUB_TOKEN`，可选配 `AHUB_URL=__HUB_URL__`），或直接将签发出的 `client` Token 粘贴回本对话以完成隔离目录登录。

---

## 步骤 4：版本与在线节点发现核验

```sh
"$AHUB_BIN" version --json
"$AHUB_BIN" --url __HUB_URL__ nodes --online --json
```

若第 3B 步使用了隔离目录 `AHUB_CONFIG_DIR`，执行上述查询与后续所有 `ahub` 命令前均须先导出同一个 `AHUB_CONFIG_DIR`。

---

## 步骤 5：固化平台原生 `ahub` Skill 与沙箱冷重建自愈

若当前助手平台支持持久化原生 Skill（例如 Grok Bot 平台内置 Skills），请将本次掌握的跨机调度规范保存或更新为名为 `ahub` 的平台原生 Skill，必须包含以下规则：

1. **沙箱冷重建一行自愈头**（每次执行跨机调度命令前自动确保 `/usr/local` 或 `$HOME/.local/bin/ahub` 存在）：
   ```sh
   export PATH="$HOME/.local/bin:$PATH"
   test -x "$HOME/.local/bin/ahub" || (curl -fsSL __HUB_URL__/dl/install.sh | AHUB_URL=__HUB_URL__ sh && "$HOME/.local/bin/ahub" skill install >/dev/null)
   ```
   若采用步骤 3B 的独立文件凭据（未使用环境变量 `AHUB_TOKEN`），务必在该原生 Skill 中同步写明对应的 `export AHUB_CONFIG_DIR="$HOME/.config/ahub-bots/<bot_slug>"` 与 `export AHUB_URL="__HUB_URL__"`。
2. **派单与续聊规范**：
   - 先用 `ahub nodes --online --json` 获取在线节点、`project_key` 与真实可用 Agent；
   - 长任务指令一律使用 `- <<'EOF'` 从 `stdin` 传入，绝不在命令行拼接未转义引号；
   - 若本 Bot 已绑定 Routine Webhook，派单统一附带 `--notify grok --wait 45s --json`；当返回退出码 `0` 且包含 `"status": "running", "webhook_armed": true` 时，立即告知用户任务已转后台异步执行并返回 `run_id` / `thread_id`，随即结束本轮对话，**严禁循环 `sleep` 轮询或额外调用 `ahub wait`**；
   - 未绑定 Webhook 且返回退出码 `24` 时，调用 `ahub wait <run_id> --timeout 15m --json`；
   - 任何时候返回退出码 `20`（`needs_approval`），立即向用户原样展示 `remote_control_url` 人工审批链接；待用户确认已完成远控放行后，调用 `ahub resolve <run_id> --json` 结算任务并释放工作区锁。

最后用简明中文向用户汇报：`ahub` 当前版本号、`hub_url`、`token_source`、`config_dir`、当前可访问的在线节点与工作区列表，以及平台原生 `ahub` Skill 固化状态；若用户启用了 `--notify grok`，提示其可在对应 Webhook Routine Prompt 中粘贴 `__HUB_URL__` 控制台提供的 `ahub_run_completed` 回调处理指令（**全程严禁出现任何密钥原文**）。
