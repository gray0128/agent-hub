import { useEffect, useState } from "react";
import { Check, Copy, Download, KeyRound, Plus, Terminal, Trash2 } from "lucide-react";
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
import type { ApiKeyRecord } from "@/types";

export interface OnboardingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  onApplyToken: (token: string) => void;
}

const BINARY_DOWNLOADS = [
  { label: "macOS Apple Silicon", href: "/dl/darwin-arm64" },
  { label: "macOS Intel", href: "/dl/darwin-amd64" },
  { label: "Linux x86_64", href: "/dl/linux-amd64" },
  { label: "Linux ARM64", href: "/dl/linux-arm64" },
  { label: "Windows x64", href: "/dl/windows-amd64.exe" }
];

export function OnboardingDialog({
  open,
  onOpenChange,
  token,
  onApplyToken
}: OnboardingDialogProps) {
  const [nodeName, setNodeName] = useState("macmini");
  const [issuedToken, setIssuedToken] = useState("");
  const [tokenInput, setTokenInput] = useState(token);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    setTokenInput(token);
  }, [token]);

  const hubOrigin =
    typeof window !== "undefined" ? window.location.origin : "https://ahub.bobocai.win";
  const effectiveNodeToken = issuedToken || token || "<NODE_TOKEN>";
  const safeNodeName = nodeName.trim() || "macmini";
  const installCmd = `curl -fsSL ${hubOrigin}/install.sh | bash -s -- --hub ${hubOrigin} --token ${effectiveNodeToken} --node ${safeNodeName} --serve`;
  const skillCmd = `curl -fsSL ${hubOrigin}/skill/SKILL.md -o ~/.agents/skills/agent-hub/SKILL.md`;

  async function handleCopy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1500);
    } catch {
      // ignore clipboard errors in headless contexts
    }
  }

  async function handleIssueNodeKey() {
    if (!token) {
      setIssueError("请先在「Token 登录」标签页输入管理员 Token。");
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
      <DialogContent className="w-[min(94vw,620px)]" data-testid="onboarding-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-[var(--status-running)]" strokeWidth={1.75} />
            接入节点与客户端配置
          </DialogTitle>
          <DialogDescription>
            单条命令安装 `ahub` 并以守护进程接入中心枢纽，或配置管理访问 Token。
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="node" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="node">一键接入节点</TabsTrigger>
            <TabsTrigger value="skill">Agent Skill</TabsTrigger>
            <TabsTrigger value="auth">Token 登录</TabsTrigger>
          </TabsList>

          <TabsContent value="node" className="space-y-3 pt-1">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                value={nodeName}
                onChange={(e) => setNodeName(e.target.value)}
                placeholder="节点名称（例如 macmini / mbp）"
                aria-label="节点名称"
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleIssueNodeKey}
                disabled={issuing}
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

            <div className="space-y-1.5 rounded-[6px] border border-border bg-card p-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-muted-foreground">
                  在目标主机执行安装并启动服务
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => handleCopy("install", installCmd)}
                >
                  {copiedId === "install" ? (
                    <Check className="h-3.5 w-3.5 text-[var(--status-done)]" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copiedId === "install" ? "已复制" : "复制"}
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-[5px] bg-muted/60 p-2.5 font-mono text-[11px] leading-relaxed text-foreground">
                {installCmd}
              </pre>
            </div>

            <div className="space-y-1.5">
              <div className="text-[11px] font-medium text-muted-foreground">
                静态零依赖二进制直链
              </div>
              <div className="flex flex-wrap gap-1.5">
                {BINARY_DOWNLOADS.map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    className="inline-flex h-7 items-center gap-1 rounded-[5px] border border-border bg-card px-2 text-[11px] text-foreground hover:bg-accent"
                  >
                    <Download className="h-3 w-3 text-muted-foreground" strokeWidth={1.75} />
                    {item.label}
                  </a>
                ))}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="skill" className="space-y-3 pt-1">
            <div className="space-y-1.5 rounded-[6px] border border-border bg-card p-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-muted-foreground">
                  安装内置跨机调度 Skill 文档
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => handleCopy("skill", skillCmd)}
                >
                  {copiedId === "skill" ? (
                    <Check className="h-3.5 w-3.5 text-[var(--status-done)]" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copiedId === "skill" ? "已复制" : "复制"}
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-[5px] bg-muted/60 p-2.5 font-mono text-[11px] leading-relaxed text-foreground">
                {skillCmd}
              </pre>
            </div>
            <p className="text-xs text-muted-foreground">
              安装后，本机 Coding Agent 可直接通过 `ahub nodes`、`ahub run`、`ahub wait` 调度远端节点。
            </p>
          </TabsContent>

          <TabsContent value="auth" className="space-y-3 pt-1">
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
              >
                清除 Token
              </Button>
              <Button
                type="button"
                onClick={() => {
                  onApplyToken(tokenInput.trim());
                  onOpenChange(false);
                }}
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
}

export function KeysDialog({ open, onOpenChange, token }: KeysDialogProps) {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"client" | "node" | "admin">("client");
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadKeys() {
    if (!token) return;
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
      setFreshSecret(null);
      void loadKeys();
    }
  }, [open, token]);

  async function handleCreate() {
    if (!token || !name.trim()) return;
    setError(null);
    try {
      const created = await apiClient.createKey(token, { name: name.trim(), scope });
      setFreshSecret(created.token ?? null);
      setName("");
      await loadKeys();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "创建密钥失败");
    }
  }

  async function handleRevoke(keyId: string) {
    if (!token) return;
    setError(null);
    try {
      await apiClient.revokeKey(token, keyId);
      await loadKeys();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "吊销密钥失败");
    }
  }

  async function handleCopySecret() {
    if (!freshSecret) return;
    try {
      await navigator.clipboard.writeText(freshSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,600px)]" data-testid="keys-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-[var(--status-running)]" strokeWidth={1.75} />
            API Keys 管理
          </DialogTitle>
          <DialogDescription>
            服务端仅持久化密钥的 SHA-256 摘要，明文密钥仅在创建时展示一次。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_112px_auto]">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="密钥用途备注（如 ci-runner）"
              aria-label="密钥用途备注"
            />
            <Select value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
              <SelectTrigger aria-label="密钥角色">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="client">client</SelectItem>
                <SelectItem value="node">node</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
              </SelectContent>
            </Select>
            <Button type="button" onClick={handleCreate} disabled={!name.trim() || !token}>
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              创建
            </Button>
          </div>

          {freshSecret && (
            <div className="rounded-[6px] border border-[var(--status-done)]/40 bg-[var(--status-done)]/10 p-2.5">
              <div className="mb-1 flex items-center justify-between text-xs font-medium text-[var(--status-done)]">
                <span>请立即保存新生成的明文密钥（关闭后不再显示）</span>
                <Button type="button" size="sm" variant="ghost" onClick={handleCopySecret}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "已复制" : "复制"}
                </Button>
              </div>
              <code className="block overflow-x-auto font-mono text-[11px] text-foreground">
                {freshSecret}
              </code>
            </div>
          )}

          {error && (
            <div className="rounded-[6px] border border-[var(--status-failed)]/40 bg-[var(--status-failed)]/10 px-2.5 py-1.5 text-xs text-[var(--status-failed)]">
              {error}
            </div>
          )}

          <div className="max-h-64 overflow-y-auto rounded-[6px] border border-border">
            {loading ? (
              <div className="p-4 text-center text-xs text-muted-foreground">正在加载密钥…</div>
            ) : keys.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">暂无密钥记录</div>
            ) : (
              <div className="divide-y divide-border">
                {keys.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-foreground">{item.name}</span>
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {item.scope}
                        </Badge>
                        {item.revoked_at ? (
                          <Badge variant="failed">已吊销</Badge>
                        ) : (
                          <Badge variant="done">有效</Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-muted-foreground tabular-nums">
                        <span>{item.key_prefix}…</span>
                        <span>创建于 {formatShortTime(item.created_at)}</span>
                      </div>
                    </div>
                    {!item.revoked_at && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => handleRevoke(item.id)}
                        className="text-[var(--status-failed)] hover:text-[var(--status-failed)]"
                        aria-label={`吊销 ${item.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                        吊销
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
