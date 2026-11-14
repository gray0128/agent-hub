# `agent-hub`（`ahub`）节点安装、配置与日常更新自举指南

> **面向本地 Coding Agent（Antigravity / Claude Code / CodeBuddy / Cursor / Trae / Pi / OMP / Codex 等）**：
> 请直接调用终端工具代劳完成以下步骤，不要把基础安装命令抛给用户手工执行。
>
> **安全边界铁律**：
> 1. 全程严禁使用 `cat`、`head`、`less` 等命令读取或打印 `~/.config/ahub/node.json` 与 `~/.config/ahub/credentials` 中的明文凭据；
> 2. 只能通过 `ahub node status --json` 检查脱敏配置状态；
> 3. 若用户提供节点 Token（`ahub_nod_...`），仅允许通过标准输入管道 `printf '%s' ... | ahub node init --token-stdin` 写入，严禁在回执或终端输出中复述明文 Token。

---

## 步骤 1：探测本机状态并完成 `ahub` 安装或原地更新

先定位本机是否已安装 `ahub`（优先检查 `command -v ahub` 与 `$HOME/.local/bin/ahub`；Windows 下同时检查 `%LOCALAPPDATA%\Programs\ahub\ahub.exe` 与 `$HOME\.local\bin\ahub.exe`）。

### 分支 1A：本机尚未安装 `ahub`（首次安装）

#### macOS / Linux / Windows Git Bash

```sh
curl -fsSL __HUB_URL__/dl/install.sh | AHUB_URL=__HUB_URL__ sh
AHUB_BIN="$HOME/.local/bin/ahub"
if [ -d "$HOME/.local/bin" ]; then
  SHELL_RC="$HOME/.bashrc"
  [ "$(uname -s)" = "Darwin" ] && SHELL_RC="$HOME/.zshrc"
  grep -qs '\.local/bin' "$SHELL_RC" 2>/dev/null || printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$SHELL_RC"
fi
```

#### Windows PowerShell

```powershell
$HubUrl = "__HUB_URL__"
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\ahub"
$TargetExe = Join-Path $InstallDir "ahub.exe"
$Manifest = Invoke-RestMethod -Uri "$HubUrl/dl/version.json" -UseBasicParsing
$Asset = $Manifest.assets.windows_amd64
$DownloadUrl = if ($Asset.url.StartsWith("/")) { "$HubUrl$($Asset.url)" } else { $Asset.url }
$TmpExe = Join-Path $env:TEMP ("ahub-" + [System.Guid]::NewGuid().ToString("N") + ".exe")
Invoke-WebRequest -Uri $DownloadUrl -OutFile $TmpExe -UseBasicParsing
if ($Asset.sha256) {
  $Actual = (Get-FileHash -Path $TmpExe -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Asset.sha256.ToLowerInvariant()) { throw "SHA-256 mismatch: expected $($Asset.sha256), got $Actual" }
}
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
if (Test-Path $TargetExe) { Move-Item -Path $TargetExe -Destination "$TargetExe.old" -Force -ErrorAction SilentlyContinue }
Move-Item -Path $TmpExe -Destination $TargetExe -Force
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $UserPath) { $UserPath = "" }
if (($UserPath -split ";") -notcontains $InstallDir) {
  [Environment]::SetEnvironmentVariable("Path", $(if ($UserPath) { "$UserPath;$InstallDir" } else { $InstallDir }), "User")
  $env:Path = "$env:Path;$InstallDir"
}
$AHUB_BIN = $TargetExe
```

### 分支 1B：本机已安装 `ahub`（原地原子升级）

#### macOS / Linux / Windows Git Bash

```sh
AHUB_BIN="$(command -v ahub 2>/dev/null || true)"
if [ -z "$AHUB_BIN" ]; then
  for cand in "$HOME/.local/bin/ahub" "$HOME/.local/bin/ahub.exe" "${LOCALAPPDATA:-}/Programs/ahub/ahub.exe"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then AHUB_BIN="$cand"; break; fi
  done
fi
"$AHUB_BIN" --url __HUB_URL__ update --json
```

> 升级提示：`ahub update` 替换本机二进制后，会自动向在线 `ahub node serve` 发送 `SIGHUP` 优雅排空重启或重载系统服务；若 macOS 已通过固定签名壳 `~/Applications/AhubDaemon.app` 托管，外置盘「完全磁盘访问权限」不会因升级二进制而失效。

#### Windows PowerShell

```powershell
$Cmd = Get-Command ahub -ErrorAction SilentlyContinue
$AHUB_BIN = if ($Cmd) { $Cmd.Source } elseif (Test-Path (Join-Path $env:LOCALAPPDATA "Programs\ahub\ahub.exe")) { Join-Path $env:LOCALAPPDATA "Programs\ahub\ahub.exe" } else { Join-Path $HOME ".local\bin\ahub.exe" }
& $AHUB_BIN --url __HUB_URL__ update --json
```

---

## 步骤 2：零依赖同步最新 `ahub` 配套 `SKILL.md`

直接调用 `ahub skill install` 写入共享技能目录 `~/.agents/skills/ahub/SKILL.md`，并同步至已安装但未建立软链接的独立宿主技能目录：

```sh
"$AHUB_BIN" skill install --json
for host_dir in "$HOME/.claude/skills" "$HOME/.codebuddy/skills" "$HOME/.cursor/skills" "$HOME/.trae/skills"; do
  if [ -d "$(dirname "$host_dir")" ] && [ ! -L "$host_dir" ]; then
    mkdir -p "$host_dir/ahub"
    cp "$HOME/.agents/skills/ahub/SKILL.md" "$host_dir/ahub/SKILL.md"
  fi
done
```

---

## 步骤 3：按节点配置状态自动分流（日常升级重启 vs 首次接入托管）

执行脱敏状态检查（严禁直接读取配置文件内容）：

```sh
"$AHUB_BIN" node status --json
```

### 分支 3A：`config_exists: true` 且 `has_token: true`（已接入节点日常更新）

1. 幂等刷新本机可执行 Agent 探测结果（保留既有 `node_id`、Token 与 `project_roots`）：
   ```sh
   "$AHUB_BIN" node init --json
   ```
2. 若 `service_installed: true`（或用户明确要求重启节点守护），重新生成并热重启用户级系统服务，确保新版二进制立即接管：
   ```sh
   "$AHUB_BIN" node service install --bin "$AHUB_BIN" --activate --json
   ```

### 分支 3B：`config_exists: false` 或 `has_token: false`（首次接入新节点）

- **情况 i：用户已在当前指令中提供了节点 Token（`ahub_nod_...`）**：
  使用 `--token-stdin` 写入 `0600` 权限 `~/.config/ahub/node.json`（若用户指定了节点 ID 则传入 `--id <node_id>`），随后注册并激活系统服务：
  ```sh
  printf '%s' "$NODE_TOKEN" | "$AHUB_BIN" node init --url __HUB_URL__ --token-stdin --json
  "$AHUB_BIN" node service install --bin "$AHUB_BIN" --activate --json
  ```
  - **macOS TCC 一次授权提示**：`ahub node service install` 会首次生成并固定签名 `~/Applications/AhubDaemon.app` 作为 LaunchAgent 托管壳。若节点工作区位于外置硬盘（如 `/Volumes/...`）且尚未授予权限，请提示用户在「系统设置 -> 隐私与安全性 -> 完全磁盘访问权限」中添加 `~/Applications/AhubDaemon.app`（只需授一次，后续 `ahub update` 不会破坏授权）。
  - Linux 无常驻桌面会话时，提示用户按需执行 `loginctl enable-linger "$USER"` 以防登出后守护进程被回收。

- **情况 ii：用户尚未提供节点 Token**：
  1. 先执行自动探测初始化（生成 `0600` 权限 `~/.config/ahub/node.json`，写好主机名 `node_id`、扫描到的 `project_roots` 与已安装 Agent）：
     ```sh
     "$AHUB_BIN" node init --url __HUB_URL__ --json
     ```
  2. 将返回中的 `node_id`、`project_roots` 与 `enabled_agents` 告知用户，并引导用户打开 `__HUB_URL__`：
     - 点击顶部「接入节点」-> 输入 `<node_id>` -> 点击「签发节点 Token」；
     - 将签发出的 `ahub_nod_...` Token（或弹窗中自动预填的指令）粘贴回本对话，即可继续完成 `--token-stdin` 绑定并启动托管服务。
     - （补充说明：若本机仅作为调用端发起跨机任务，无需托管常驻节点，可改用 `client`/`admin` Token 执行 `ahub auth login --url __HUB_URL__ --token <TOKEN>`。）

---

## 步骤 4：版本与守护进程存活核验

```sh
"$AHUB_BIN" version --json
"$AHUB_BIN" node status --json
```

若 `service_installed: true`，补验用户级服务运行状态：
- **macOS**：`launchctl print "gui/$(id -u)/win.bobocai.ahub.node"`（确认 `state = running` 或 `pid` 存在）。
- **Linux**：`systemctl --user is-active ahub-node.service`。

最后用简明中文向用户汇报：`ahub` 当前版本号、`node_id`、`hub_url`、已启用 Agent 列表、`project_roots` 与系统托管服务状态（**严禁在汇报中出现任何 Token 原文**）。
