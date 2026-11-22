import { useEffect, useState } from "react";
import { Download, KeyRound, Pencil, Plus, Terminal, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { formatShortTime } from "@/lib/utils";
import { useFleetStore } from "@/stores/fleet-store";
import type { ApiKeyRecord } from "@/types";
import { CopyButton } from "./CopyButton";

export interface OnboardingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  authenticated?: boolean;
  authKind?: string | null;
  authScope?: "admin" | "client" | "node" | null;
  onApplyToken: (token: string) => void;
}

const BINARY_DOWNLOADS = [
  { label: "macOS Apple Silicon", href: "/dl/ahub-darwin-arm64" },
  { label: "macOS Intel", href: "/dl/ahub-darwin-amd64" },
  { label: "Linux x86_64", href: "/dl/ahub-linux-amd64" },
  { label: "Linux ARM64", href: "/dl/ahub-linux-arm64" },
  { label: "Windows x64", href: "/dl/ahub-windows-amd64.exe" }
];

function resolveHubOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "https://ahub.bobocai.win";
}

function toBotSlug(rawName: string): string {
  const clean = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || "grok-bot";
}

function buildClientBootstrapEnvPrompt(hubOrigin: string, botName?: string): string {
  const botTag = botName?.trim() ? `（Bot 标识：${botName.trim()}）` : "";
  return `请读取 ${hubOrigin}/dl/client-bootstrap.md 中的最新调用端自举说明，直接代我完成本环境 ahub CLI 与配套 SKILL.md 的安装或升级（注意传入 --no-restart 跳过节点守护重启）${botTag}；校验当前 AHUB_TOKEN 连通性与可访问节点列表，并将该跨机调度规范保存为当前平台的「ahub」技能以便后续持续复用（全程严禁执行 ahub node 守护命令，也严禁在日志或回执中输出任何密钥原文）。`;
}

function buildClientBootstrapTokenPrompt(
  hubOrigin: string,
  botName: string,
  clientToken: string
): string {
  const slug = toBotSlug(botName);
  return `请读取 ${hubOrigin}/dl/client-bootstrap.md 中的最新调用端自举说明，将本环境配置为独立 Bot 调用端（Bot 标识：${slug}，Hub 地址：${hubOrigin}，专属隔离配置目录：~/.config/ahub-bots/${slug}，调用端 Token：${clientToken}）；请先 export AHUB_CONFIG_DIR="$HOME/.config/ahub-bots/${slug}" 并通过 printf '%s' ... | ahub auth login --url ${hubOrigin} --token-stdin 完成隔离落盘，绝不覆盖默认 ~/.config/ahub/credentials，同步完成 SKILL.md 安装与平台原生「ahub」技能持久化（全程严禁执行 ahub node 守护命令，也严禁在日志或回复中复述明文 Token）。`;
}

function buildGrokRoutinePrompt(hubOrigin: string, isolatedSlug?: string): string {
  const cfgPrefix = isolatedSlug
    ? `export AHUB_CONFIG_DIR="$HOME/.config/ahub-bots/${toBotSlug(isolatedSlug)}"; `
    : "";
  return `收到 agent-hub 的 \`ahub_run_completed\` 或 \`ahub_native_event\` Webhook 事件后，按以下规则处理并回复用户：
1. 若云端环境冷重建导致 \`$HOME/.local/bin/ahub\` 不存在，先执行：\`export PATH="$HOME/.local/bin:$PATH"; ${cfgPrefix}test -x "$HOME/.local/bin/ahub" || (curl -fsSL ${hubOrigin}/dl/install.sh | AHUB_URL=${hubOrigin} sh && "$HOME/.local/bin/ahub" skill install >/dev/null)\`。
2. 收到 \`ahub_run_completed\` 时，下发指令正文已在发起 \`ahub run\` 阶段向用户脱敏展示；回调汇报可按需引用事件中已脱敏的 \`prompt_preview\` 作为只读上下文核对，严禁在任务结束后调用 \`ahub result\` 拉取原始未脱敏 \`prompt\`，严禁输出任何令牌、密码、Bearer Key 或其他凭据原文。
3. 当 \`ahub_run_completed\` 的 \`status\` 为 \`needs_approval\`：立即把事件中的 \`remote_control_url\` 原样发给用户，引导人工审批放行。
4. 当 \`ahub_run_completed\` 的 \`status\` 为 \`done\`：向用户汇报 \`summary\` 与可续聊的 \`thread_id\`；仅当事件中的输出摘要不足以回答用户且确需完整产出正文（\`output_md\`）时，才调用 \`${cfgPrefix}ahub --url ${hubOrigin} result <run_id> --full --json\` 读取 \`output_md\` 后总结。
5. 当 \`ahub_run_completed\` 的 \`status\` 为 \`failed\` 或 \`cancelled\`：清晰说明 \`error_code\` / \`error_message\` 与 \`run_id\`。
6. 当收到 \`ahub_native_event\`（本地 Agent 原生会话通知）：仅作只读转达，向用户展示节点 \`node_id\`、\`agent\`、\`event_kind\`（\`interaction_needed\` 需用户互动或 \`turn_summary\` 结束总结）、\`workdir\` 与脱敏后的 \`title\` / \`summary\`；严禁代用户审批放行、严禁自动代答或发起新任务。
7. 回调处理轮内禁止循环重试或嵌套发起新的 \`ahub run\`。`;
}

interface PromptCopyBoxProps {
  title: string;
  text: string;
  testId?: string;
  mono?: boolean;
  copyLabel?: string;
}

function PromptCopyBox({
  title,
  text,
  testId,
  mono = false,
  copyLabel = "复制"
}: PromptCopyBoxProps) {
  return (
    <div className="min-w-0 space-y-1.5 rounded-[8px] border border-border bg-card p-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="min-w-0 text-[11px] font-medium text-muted-foreground">{title}</span>
        <CopyButton text={text} label={copyLabel} copiedLabel="已复制" />
      </div>
      <pre
        data-testid={testId}
        className={
          mono
            ? "max-w-full overflow-x-auto rounded-[4px] bg-muted/60 p-2.5 font-mono text-[11px] leading-relaxed text-foreground"
            : "whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[4px] bg-muted/60 p-2.5 font-sans text-xs leading-relaxed text-foreground"
        }
      >
        {text}
      </pre>
    </div>
  );
}

export function OnboardingDialog({
  open,
  onOpenChange,
  token,
  authenticated = false,
  authKind = null,
  authScope = null,
  onApplyToken
}: OnboardingDialogProps) {
  const hasSession = Boolean(authenticated || token);
  const canIssueKeys = !authScope || authScope === "admin";
  const [nodeName, setNodeName] = useState("macmini");
  const [issuedToken, setIssuedToken] = useState("");
  const [tokenInput, setTokenInput] = useState(token);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);

  useEffect(() => {
    setTokenInput(token);
  }, [token]);

  const hubOrigin = resolveHubOrigin();
  const effectiveNodeToken = issuedToken || "<NODE_TOKEN>";
  const safeNodeName = nodeName.trim() || "macmini";
  const agentPrompt = issuedToken
    ? `请读取 ${hubOrigin}/dl/bootstrap.md 中的最新节点自举说明，直接将本机配置并启动为 agent-hub 节点（Hub 地址：${hubOrigin}，节点 ID：${safeNodeName}，节点专属 Token：${issuedToken}），完成二进制安装或升级、配套技能同步、0600 权限节点配置落盘与系统级用户服务激活，全程不要在终端日志或回执中明文复述该 Token。`
    : `请读取 ${hubOrigin}/dl/bootstrap.md 中的最新节点自举说明，直接代我完成本机 ahub 程序与配套技能的检测、下载安装或版本更新；若本机已配置节点守护则重启服务使新版本生效，若首次接入则自动完成基础初始化并引导我补齐节点 Token 启动系统托管服务。`;
  const clientBootstrapPrompt = buildClientBootstrapEnvPrompt(hubOrigin);
  const grokRoutinePrompt = buildGrokRoutinePrompt(hubOrigin);
  const installCmd = `curl -fsSL ${hubOrigin}/dl/install.sh | AHUB_URL=${hubOrigin} sh && ~/.local/bin/ahub skill install && printf '%s' '${effectiveNodeToken}' | ~/.local/bin/ahub node init --id ${safeNodeName} --url ${hubOrigin} --token-stdin && ~/.local/bin/ahub node service install --activate`;
  const skillCmd = `mkdir -p ~/.agents/skills/ahub && curl -fsSL ${hubOrigin}/skill/SKILL.md -o ~/.agents/skills/ahub/SKILL.md`;

  async function handleIssueNodeKey() {
    if (!hasSession || !canIssueKeys) {
      setIssueError("请先通过管理员账号（Cloudflare Access 或 admin Token）登录后再签发节点密钥。");
      return;
    }
    setIssuing(true);
    setIssueError(null);
    try {
      const created = await apiClient.createKey(token, {
        name: `node-${safeNodeName}`,
        scope: "node",
        bound_node_id: safeNodeName
      });
      if (created.token) {
        setIssuedToken(created.token);
      }
    } catch (err) {
      setIssueError(
        err instanceof ApiClientError ? err.message : "签发节点密钥失败，请检查权限。"
      );
    } finally {
      setIssuing(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] w-[min(94vw,620px)] overflow-y-auto" data-testid="onboarding-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-[var(--status-running)]" strokeWidth={1.75} />
            接入节点与客户端配置
          </DialogTitle>
          <DialogDescription>
            复制一句话提示词交给节点本地 Agent 自动安装/更新，或通过终端命令手动接入并配置访问 Token。
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="node" className="w-full">
          <TabsList className="grid w-full grid-cols-3 h-auto min-h-12 p-0.5 sm:h-8 sm:min-h-0">
            <TabsTrigger value="node" className="min-h-11 sm:min-h-0 px-1.5 text-xs sm:px-2.5 sm:text-xs">
              一键接入节点
            </TabsTrigger>
            <TabsTrigger
              value="skill"
              data-testid="onboarding-tab-skill"
              className="min-h-11 sm:min-h-0 px-1.5 text-xs sm:px-2.5 sm:text-xs"
            >
              接入 Bot / Skill
            </TabsTrigger>
            <TabsTrigger value="auth" className="min-h-11 sm:min-h-0 px-1.5 text-xs sm:px-2.5 sm:text-xs">
              Token 登录
            </TabsTrigger>
          </TabsList>

          <TabsContent value="node" className="space-y-3 pt-1">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                value={nodeName}
                onChange={(e) => setNodeName(e.target.value)}
                placeholder="节点名称（例如 macmini / mbp）"
                aria-label="节点名称"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleIssueNodeKey}
                disabled={issuing || !canIssueKeys}
                className="min-h-11 sm:min-h-0 sm:h-8"
              >
                <KeyRound className="h-3.5 w-3.5" strokeWidth={1.75} />
                {issuing ? "签发中…" : "签发节点 Token"}
              </Button>
            </div>

            {issueError && (
              <div className="rounded-[6px] border border-[var(--status-failed)]/40 bg-[var(--status-failed)]/10 px-2.5 py-1.5 text-xs text-[var(--status-failed)]">
                {issueError}
              </div>
            )}

            <PromptCopyBox
              title="发给节点本地 Agent 自动安装/更新（推荐）"
              text={agentPrompt}
              testId="onboarding-agent-prompt"
            />

            <PromptCopyBox
              title="终端手工执行安装并启动服务（兜底）"
              text={installCmd}
              mono
            />

            <div className="space-y-1.5">
              <div className="text-[11px] font-medium text-muted-foreground">
                静态零依赖二进制直链
              </div>
              <div className="flex flex-wrap gap-1.5">
                {BINARY_DOWNLOADS.map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    className="inline-flex min-h-11 sm:min-h-0 sm:h-7 items-center gap-1 rounded-[5px] border border-border bg-card px-2.5 sm:px-2 text-xs sm:text-[11px] text-foreground hover:bg-accent"
                  >
                    <Download className="h-3 w-3 text-muted-foreground" strokeWidth={1.75} />
                    {item.label}
                  </a>
                ))}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="skill" className="space-y-3 pt-1">
            <PromptCopyBox
              title="发给 Grok Bot / 纯调用端 Agent 自动自举（推荐，配合 AHUB_TOKEN Secret）"
              text={clientBootstrapPrompt}
              testId="onboarding-client-prompt"
            />

            <PromptCopyBox
              title="Grok Bot Webhook Routine 异步回调指令（粘贴至 Routine Prompt）"
              text={grokRoutinePrompt}
              testId="onboarding-routine-prompt"
            />

            <PromptCopyBox
              title="终端手工拉取跨机调度 SKILL.md"
              text={skillCmd}
              mono
            />
            <p className="text-xs text-muted-foreground">
              多 Bot 共用同一账号云端宿主目录时，建议在「密钥管理」按 Bot 单独签发 `client` Key（支持按 `AHUB_TOKEN` 环境变量或 `AHUB_CONFIG_DIR` 隔离落盘，避免跨 Bot 串台）。
            </p>
          </TabsContent>

          <TabsContent value="auth" className="space-y-3 pt-1">
            {authKind === "access_jwt" && !token && (
              <div
                data-testid="cf-access-active-banner"
                className="rounded-[6px] border border-[var(--status-done)]/40 bg-[var(--status-done)]/10 px-2.5 py-2 text-xs text-foreground"
              >
                当前已通过 Cloudflare Access 会话完成鉴权，无需填写控制台 Token。
              </div>
            )}
            <div className="space-y-1.5">
              <label htmlFor="ahub-token-input" className="text-xs font-medium text-foreground">
                控制台访问 Token（仅保存在当前浏览器 localStorage）
              </label>
              <Input
                id="ahub-token-input"
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="ahub_..."
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setTokenInput("");
                  onApplyToken("");
                }}
                className="min-h-11 sm:min-h-0 sm:h-8"
              >
                清除 Token
              </Button>
              <Button
                type="button"
                onClick={() => {
                  onApplyToken(tokenInput.trim());
                  onOpenChange(false);
                }}
                className="min-h-11 sm:min-h-0 sm:h-8"
              >
                保存并重连
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

export interface KeysDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  authenticated?: boolean;
  authKind?: string | null;
  authScope?: "admin" | "client" | "node" | null;
}

function parseNodeList(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const clean = part.trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function parseBoardPrefixList(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const clean = part.trim().replace(/^\/+|\/+$/g, "");
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function toggleNodeInList(raw: string, nodeId: string): string {
  const list = parseNodeList(raw);
  if (list.includes(nodeId)) {
    return list.filter((id) => id !== nodeId).join(", ");
  }
  return [...list, nodeId].join(", ");
}

interface FreshCreatedKey {
  token: string;
  name: string;
  scope: "client" | "node" | "admin";
}

export function KeysDialog({
  open,
  onOpenChange,
  token,
  authenticated = false,
  authScope = null
}: KeysDialogProps) {
  const hasSession = Boolean(authenticated || token);
  const isAdmin = authScope === "admin";
  const fleetNodes = useFleetStore((s) => s.nodes);
  const nodeIds = fleetNodes.map((n) => n.id);
  const hubOrigin = resolveHubOrigin();
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"client" | "node" | "admin">("client");
  const [boundNodeId, setBoundNodeId] = useState("");
  const [allowedNodesText, setAllowedNodesText] = useState("");
  const [allowedBoardPrefixesText, setAllowedBoardPrefixesText] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookKey, setWebhookKey] = useState("");
  const [freshCreated, setFreshCreated] = useState<FreshCreatedKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [editAllowedNodesText, setEditAllowedNodesText] = useState("");
  const [editAllowedBoardPrefixesText, setEditAllowedBoardPrefixesText] = useState("");
  const [editWebhookUrl, setEditWebhookUrl] = useState("");
  const [editWebhookKey, setEditWebhookKey] = useState("");
  const [editClearWebhook, setEditClearWebhook] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  async function loadKeys() {
    if (!hasSession || !isAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.fetchKeys(token);
      setKeys(res.keys);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "读取密钥列表失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      setFreshCreated(null);
      setEditingKeyId(null);
      setConfirmRevokeId(null);
      if (isAdmin) {
        void loadKeys();
      } else {
        setKeys([]);
      }
    }
  }, [open, token, authenticated, isAdmin]);

  async function handleCreate() {
    if (!hasSession || !isAdmin || !name.trim()) return;
    if (scope === "node" && !boundNodeId.trim()) {
      setError("签发 node 角色密钥必须填写目标节点 ID");
      return;
    }
    setError(null);
    try {
      const payload: Parameters<typeof apiClient.createKey>[1] = {
        name: name.trim(),
        scope
      };
      if (scope === "node") {
        payload.bound_node_id = boundNodeId.trim();
      } else if (scope === "client") {
        const nodes = parseNodeList(allowedNodesText);
        if (nodes.length > 0) {
          payload.allowed_nodes = nodes;
        }
        const prefixes = parseBoardPrefixList(allowedBoardPrefixesText);
        if (prefixes.length > 0) {
          payload.allowed_board_prefixes = prefixes;
        }
        if (webhookUrl.trim()) {
          payload.webhook_url = webhookUrl.trim();
        }
        if (webhookKey.trim()) {
          payload.webhook_key = webhookKey.trim();
        }
      }
      const created = await apiClient.createKey(token, payload);
      setFreshCreated(
        created.token
          ? { token: created.token, name: payload.name, scope: payload.scope }
          : null
      );
      setName("");
      setBoundNodeId("");
      setAllowedNodesText("");
      setAllowedBoardPrefixesText("");
      setWebhookUrl("");
      setWebhookKey("");
      await loadKeys();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "创建密钥失败");
    }
  }

  function startEdit(item: ApiKeyRecord) {
    setEditingKeyId(item.id);
    setEditAllowedNodesText(item.allowed_nodes.join(", "));
    setEditAllowedBoardPrefixesText((item.allowed_board_prefixes ?? []).join(", "));
    setEditWebhookUrl("");
    setEditWebhookKey("");
    setEditClearWebhook(false);
    setError(null);
  }

  async function handleSaveEdit(keyId: string) {
    if (!hasSession || !isAdmin) return;
    setSavingEdit(true);
    setError(null);
    try {
      const body: Parameters<typeof apiClient.patchKey>[2] = {
        allowed_nodes: parseNodeList(editAllowedNodesText),
        allowed_board_prefixes: parseBoardPrefixList(editAllowedBoardPrefixesText)
      };
      if (editClearWebhook) {
        body.clear_webhook = true;
      } else {
        if (editWebhookUrl.trim()) {
          body.webhook_url = editWebhookUrl.trim();
        }
        if (editWebhookKey.trim()) {
          body.webhook_key = editWebhookKey.trim();
        }
      }
      await apiClient.patchKey(token, keyId, body);
      setEditingKeyId(null);
      await loadKeys();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "更新密钥绑定失败");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleRevoke(keyId: string) {
    if (!hasSession) return;
    setError(null);
    try {
      await apiClient.revokeKey(token, keyId);
      setConfirmRevokeId(null);
      if (editingKeyId === keyId) {
        setEditingKeyId(null);
      }
      await loadKeys();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "吊销密钥失败");
    }
  }

  const selectedCreateNodes = new Set(parseNodeList(allowedNodesText));
  const selectedEditNodes = new Set(parseNodeList(editAllowedNodesText));
  const canCreate = Boolean(name.trim() && hasSession && (scope !== "node" || boundNodeId.trim()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] w-[min(94vw,680px)] overflow-y-auto" data-testid="keys-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-[var(--status-running)]" strokeWidth={1.75} />
            API Keys 与 Bot Webhook 管理
          </DialogTitle>
          <DialogDescription>
            服务端仅持久化密钥的 SHA-256 摘要，独立 Bot 的 Webhook 配置经 AES-256-GCM 加密保存，明文密钥仅创建时展示一次。
          </DialogDescription>
        </DialogHeader>

        {!isAdmin ? (
          <div
            data-testid="keys-forbidden-notice"
            className="rounded-[6px] border border-border bg-muted/30 px-3 py-4 text-xs text-muted-foreground text-pretty"
          >
            当前凭证无权查看系统密钥管理。请使用管理员账号通过 Cloudflare Access 登录。
          </div>
        ) : (
        <div className="space-y-3">
          <div className="space-y-2 rounded-[6px] border border-border bg-muted/20 p-2.5">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_112px_auto]">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="密钥用途备注（如 grok-bot-alpha）"
                aria-label="密钥用途备注"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                data-testid="key-name-input"
              />
              <Select value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
                <SelectTrigger aria-label="密钥角色" data-testid="key-scope-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="client">client</SelectItem>
                  <SelectItem value="node">node</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                onClick={handleCreate}
                disabled={!canCreate}
                data-testid="create-key-btn"
                className="min-h-11 sm:min-h-0 sm:h-8"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                创建
              </Button>
            </div>

            {scope === "node" && (
              <Input
                value={boundNodeId}
                onChange={(e) => setBoundNodeId(e.target.value)}
                placeholder="绑定节点 ID（必填，如 macmini）"
                aria-label="绑定节点 ID"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                data-testid="key-bound-node-input"
              />
            )}

            {scope === "client" && (
              <div className="space-y-2 border-t border-border/60 pt-2">
                {nodeIds.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground">允许节点：</span>
                    {nodeIds.map((nodeId) => {
                      const active = selectedCreateNodes.has(nodeId);
                      return (
                        <button
                          key={nodeId}
                          type="button"
                          onClick={() => setAllowedNodesText((prev) => toggleNodeInList(prev, nodeId))}
                          data-testid={`key-node-chip-${nodeId}`}
                          className={`inline-flex min-h-11 px-2.5 sm:min-h-0 sm:px-2 sm:py-0.5 items-center rounded-[4px] border font-mono text-xs sm:text-[11px] transition-colors cursor-pointer ${
                            active
                              ? "border-[var(--status-running)] bg-[var(--status-running)]/15 text-foreground"
                              : "border-border bg-background text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {nodeId}
                        </button>
                      );
                    })}
                    {selectedCreateNodes.size === 0 && (
                      <span className="text-[11px] text-muted-foreground">未限选时允许全部在线节点</span>
                    )}
                  </div>
                )}
                <Input
                  value={allowedNodesText}
                  onChange={(e) => setAllowedNodesText(e.target.value)}
                  placeholder="允许调度节点列表（逗号分隔，如 macmini,mbp；留空允许全部）"
                  aria-label="允许调度节点列表"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-testid="key-allowed-nodes-input"
                />
                <Input
                  value={allowedBoardPrefixesText}
                  onChange={(e) => setAllowedBoardPrefixesText(e.target.value)}
                  placeholder="允许访问协同板频道前缀（逗号分隔，如 proj, ops/fleet 或 *；留空禁止访问协同板）"
                  aria-label="允许访问协同板频道前缀"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-testid="key-allowed-board-prefixes-input"
                />
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Input
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    placeholder="独立 Bot Webhook URL（可选，https://...）"
                    aria-label="Bot Webhook URL"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    data-testid="key-webhook-url-input"
                  />
                  <Input
                    type="password"
                    value={webhookKey}
                    onChange={(e) => setWebhookKey(e.target.value)}
                    placeholder="Webhook Bearer Key（可选）"
                    aria-label="Bot Webhook Key"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    data-testid="key-webhook-key-input"
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  若 Grok Bot 中文桌面端 Routine 面板未显示 Webhook 字段，可用同一账号访问{" "}
                  <a
                    href="https://cursor.com/automations"
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:text-foreground"
                  >
                    cursor.com/automations
                  </a>{" "}
                  复制 Webhook URL 与 Bearer Key。
                </p>
              </div>
            )}
          </div>

          {freshCreated && (
            <div className="space-y-2 rounded-[8px] border border-[var(--status-done)]/40 bg-[var(--status-done)]/10 p-2.5">
              <div>
                <div className="mb-1 flex items-center justify-between text-xs font-medium text-[var(--status-done)]">
                  <span>请立即保存新生成的明文密钥（关闭后不再显示）</span>
                  <CopyButton text={freshCreated.token} label="复制" copiedLabel="已复制" />
                </div>
                <code className="block overflow-x-auto rounded-[4px] bg-background/40 px-2 py-1 font-mono text-[11px] text-foreground">
                  {freshCreated.token}
                </code>
              </div>

              {freshCreated.scope === "client" && (
                <div className="space-y-2 border-t border-[var(--status-done)]/25 pt-2">
                  <PromptCopyBox
                    title="无密自举提示词（推荐：先将上方密钥填入 Bot Secrets AHUB_TOKEN）"
                    text={buildClientBootstrapEnvPrompt(hubOrigin, freshCreated.name)}
                    testId="fresh-client-bootstrap-env"
                  />
                  <PromptCopyBox
                    title={`一步带密钥隔离自举提示词（写入 ~/.config/ahub-bots/${toBotSlug(freshCreated.name)}）`}
                    text={buildClientBootstrapTokenPrompt(
                      hubOrigin,
                      freshCreated.name,
                      freshCreated.token
                    )}
                    testId="fresh-client-bootstrap-token"
                  />
                  <PromptCopyBox
                    title="Webhook Routine 回调处理指令（处理 ahub_run_completed）"
                    text={buildGrokRoutinePrompt(hubOrigin, freshCreated.name)}
                    testId="fresh-client-routine-prompt"
                  />
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-[6px] border border-[var(--status-failed)]/40 bg-[var(--status-failed)]/10 px-2.5 py-1.5 text-xs text-[var(--status-failed)]">
              {error}
            </div>
          )}

          <div className="max-h-72 overflow-y-auto rounded-[6px] border border-border">
            {loading ? (
              <div className="p-4 text-center text-xs text-muted-foreground">正在加载密钥…</div>
            ) : keys.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">暂无密钥记录</div>
            ) : (
              <div className="divide-y divide-border">
                {keys.map((item) => {
                  const isEditing = editingKeyId === item.id;
                  const nodeLabel =
                    item.scope === "node"
                      ? item.bound_node_id
                        ? `绑定节点: ${item.bound_node_id}`
                        : "未绑定节点"
                      : item.scope === "client"
                        ? item.allowed_nodes.length > 0
                          ? `节点: ${item.allowed_nodes.join(", ")}`
                          : "全部节点"
                        : "全权限管理";

                  return (
                    <div key={item.id} className="text-xs">
                      <div className="flex items-center justify-between gap-2 px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate font-medium text-foreground">{item.name}</span>
                            <Badge variant="outline" className="font-mono text-[10px]">
                              {item.scope}
                            </Badge>
                            {item.revoked_at ? (
                              <Badge variant="failed">已吊销</Badge>
                            ) : (
                              <Badge variant="done">有效</Badge>
                            )}
                            <Badge variant="outline" className="font-mono text-[10px]">
                              {nodeLabel}
                            </Badge>
                            {item.scope === "client" && (
                              <Badge
                                variant="outline"
                                data-testid={`key-board-prefixes-badge-${item.id}`}
                                className="font-mono text-[10px]"
                              >
                                {(item.allowed_board_prefixes ?? []).length > 0
                                  ? `协同板: ${item.allowed_board_prefixes.join(", ")}`
                                  : "协同板: 无权限"}
                              </Badge>
                            )}
                            {item.has_webhook && (
                              <Badge
                                variant="outline"
                                data-testid={`key-webhook-badge-${item.id}`}
                                className="font-mono text-[10px] text-[var(--status-running)]"
                              >
                                {`Webhook: ${item.notify_webhook_host || "configured"}`}
                              </Badge>
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-muted-foreground tabular-nums">
                            <span>{item.key_prefix}…</span>
                            <span>创建于 {formatShortTime(item.created_at)}</span>
                          </div>
                        </div>
                        {!item.revoked_at && (
                          <div className="flex shrink-0 flex-wrap items-center gap-1">
                            {confirmRevokeId === item.id ? (
                              <>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => handleRevoke(item.id)}
                                  data-testid={`confirm-revoke-${item.id}`}
                                  className="min-h-11 sm:min-h-0 sm:h-7 px-2.5 sm:px-2 text-xs sm:text-[11px]"
                                >
                                  确认吊销
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setConfirmRevokeId(null)}
                                  className="min-h-11 sm:min-h-0 sm:h-7 px-2.5 sm:px-2 text-xs sm:text-[11px]"
                                >
                                  取消
                                </Button>
                              </>
                            ) : (
                              <>
                                {item.scope === "client" && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => (isEditing ? setEditingKeyId(null) : startEdit(item))}
                                    data-testid={`edit-key-${item.id}`}
                                    aria-label={`编辑 ${item.name}`}
                                    className="min-h-11 sm:min-h-0 sm:h-7"
                                  >
                                    {isEditing ? (
                                      <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                                    ) : (
                                      <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                                    )}
                                    {isEditing ? "收起" : "编辑绑定"}
                                  </Button>
                                )}
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    setEditingKeyId(null);
                                    setConfirmRevokeId(item.id);
                                  }}
                                  data-testid={`revoke-key-${item.id}`}
                                  className="min-h-11 sm:min-h-0 sm:h-7 text-[var(--status-failed)] hover:text-[var(--status-failed)]"
                                  aria-label={`吊销 ${item.name}`}
                                >
                                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                                  吊销
                                </Button>
                              </>
                            )}
                          </div>
                        )}
                      </div>

                      {isEditing && (
                        <div className="space-y-2 border-t border-border/70 bg-muted/20 px-3 py-2.5">
                          {nodeIds.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[11px] text-muted-foreground">节点白名单：</span>
                              {nodeIds.map((nodeId) => {
                                const active = selectedEditNodes.has(nodeId);
                                return (
                                  <button
                                    key={nodeId}
                                    type="button"
                                    onClick={() =>
                                      setEditAllowedNodesText((prev) => toggleNodeInList(prev, nodeId))
                                    }
                                    className={`inline-flex min-h-11 px-2.5 sm:min-h-0 sm:px-2 sm:py-0.5 items-center rounded-[4px] border font-mono text-xs sm:text-[11px] transition-colors cursor-pointer ${
                                      active
                                        ? "border-[var(--status-running)] bg-[var(--status-running)]/15 text-foreground"
                                        : "border-border bg-background text-muted-foreground hover:text-foreground"
                                    }`}
                                  >
                                    {nodeId}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          <Input
                            value={editAllowedNodesText}
                            onChange={(e) => setEditAllowedNodesText(e.target.value)}
                            placeholder="允许调度节点（逗号分隔，留空允许全部节点）"
                            aria-label="编辑允许节点"
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            data-testid={`edit-allowed-nodes-${item.id}`}
                          />
                          <Input
                            value={editAllowedBoardPrefixesText}
                            onChange={(e) => setEditAllowedBoardPrefixesText(e.target.value)}
                            placeholder="允许协同板频道前缀（逗号分隔，如 proj, ops 或 *；留空禁止协同板访问）"
                            aria-label="编辑允许协同板频道前缀"
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            data-testid={`edit-allowed-board-prefixes-${item.id}`}
                          />
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <Input
                              value={editWebhookUrl}
                              onChange={(e) => setEditWebhookUrl(e.target.value)}
                              disabled={editClearWebhook}
                              placeholder={
                                item.has_webhook
                                  ? `替换 Webhook URL（当前 ${item.notify_webhook_host}）`
                                  : "设置 Bot Webhook URL（https://...）"
                              }
                              aria-label="编辑 Bot Webhook URL"
                              autoComplete="off"
                              autoCorrect="off"
                              autoCapitalize="none"
                              spellCheck={false}
                              data-testid={`edit-webhook-url-${item.id}`}
                            />
                            <Input
                              type="password"
                              value={editWebhookKey}
                              onChange={(e) => setEditWebhookKey(e.target.value)}
                              disabled={editClearWebhook}
                              placeholder="更新 Bearer Key（留空保持不变或配合新 URL）"
                              aria-label="编辑 Bot Webhook Key"
                              autoComplete="off"
                              autoCorrect="off"
                              autoCapitalize="none"
                              spellCheck={false}
                              data-testid={`edit-webhook-key-${item.id}`}
                            />
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            {item.has_webhook ? (
                              <label className="flex min-h-11 sm:min-h-0 items-center gap-1.5 text-xs sm:text-[11px] text-muted-foreground cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={editClearWebhook}
                                  onChange={(e) => setEditClearWebhook(e.target.checked)}
                                />
                                清除已配置 Webhook
                              </label>
                            ) : (
                              <span />
                            )}
                            <div className="flex flex-wrap items-center gap-1.5">
                              <CopyButton
                                variant="outline"
                                label="复制 Bot 自举更新词"
                                copiedLabel="已复制自举词"
                                text={buildClientBootstrapEnvPrompt(hubOrigin, item.name)}
                              />
                              <CopyButton
                                variant="outline"
                                label="复制 Routine 回调词"
                                copiedLabel="已复制回调词"
                                text={buildGrokRoutinePrompt(hubOrigin, item.name)}
                              />
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditingKeyId(null)}
                                className="min-h-11 sm:min-h-0 sm:h-7"
                              >
                                取消
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                disabled={savingEdit}
                                onClick={() => handleSaveEdit(item.id)}
                                data-testid={`save-key-edit-${item.id}`}
                                className="min-h-11 sm:min-h-0 sm:h-7"
                              >
                                {savingEdit ? "保存中…" : "保存绑定"}
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
