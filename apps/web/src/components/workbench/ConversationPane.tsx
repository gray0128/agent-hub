import { useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import {
  AlertTriangle,
  ArrowLeftRight,
  Bell,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  GitBranch,
  GitFork,
  Lock,
  Send,
  Shield,
  SlidersHorizontal,
  Square,
  Terminal
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  buildRunCliPreview,
  cn,
  formatBytes,
  formatDurationMs,
  formatNotifyBadgeMeta,
  formatShortTime
} from "@/lib/utils";
import type { ComposerDraft } from "@/stores/workbench-store";
import type { AgentName, EffortLevel, NodeRecord, RunEventItem, RunRecord, ThreadRecord } from "@/types";
import { CopyButton } from "./CopyButton";
import { RunStatusBadge } from "./StatusBadge";

const AGENT_OPTIONS: AgentName[] = ["agy", "pi", "omp", "codex", "claude"];
const MODEL_OPTIONS: Record<AgentName, string[]> = {
  agy: ["carbon", "argon", "hydrogen", "flash", "opus", "sonnet"],
  pi: ["claude-sonnet-4-5", "gpt-5", "gemini-2.5-pro"],
  omp: ["claude-sonnet-4-5", "gpt-5"],
  codex: ["gpt-5", "o3"],
  claude: ["claude-sonnet-4-5", "claude-opus-4-1"]
};
const EFFORT_OPTIONS: EffortLevel[] = ["low", "medium", "high", "xhigh"];
const NOTIFY_LABELS: Record<ComposerDraft["notifyTarget"], string> = {
  none: "不通知",
  webhook: "Bot Webhook",
  grok: "Grok"
};

export interface ConversationPaneProps {
  nodes: NodeRecord[];
  selectedThread: ThreadRecord | null;
  threadRuns: RunRecord[];
  selectedRunId: string | null;
  hasLineage?: boolean;
  fullOutputByRunId: Record<string, string>;
  eventsByRunId: Record<string, RunEventItem[]>;
  composer: ComposerDraft;
  submitting: boolean;
  onPatchComposer: (patch: Partial<ComposerDraft>) => void;
  onSelectRun: (runId: string) => void;
  onLoadFullOutput: (runId: string) => void;
  onCancelRun: (runId: string, cascade: boolean) => void;
  onForkThread: (thread: ThreadRecord) => void;
  onOpenLineage?: () => void;
  onSubmitPrompt: () => void;
}

export function ConversationPane({
  nodes,
  selectedThread,
  threadRuns,
  selectedRunId,
  hasLineage = false,
  fullOutputByRunId,
  eventsByRunId,
  composer,
  submitting,
  onPatchComposer,
  onSelectRun,
  onLoadFullOutput,
  onCancelRun,
  onForkThread,
  onOpenLineage,
  onSubmitPrompt
}: ConversationPaneProps) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: "composer-workdir-dropzone"
  });

  const lastCompositionEndRef = useRef<number>(0);
  const [composing, setComposing] = useState(false);
  const [expandedCmdRuns, setExpandedCmdRuns] = useState<Record<string, boolean>>({});
  const [expandedPrompts, setExpandedPrompts] = useState<Record<string, boolean>>({});
  const [mobileParamsOpen, setMobileParamsOpen] = useState(false);

  const selectedNode = nodes.find((n) => n.id === composer.nodeId);
  const workspaces = selectedNode?.workspaces ?? [];
  const approvalRun = threadRuns.find((r) => r.status === "needs_approval") ?? null;

  const isReplyMode = composer.mode === "reply" && selectedThread !== null;
  const targetNodeId = isReplyMode ? selectedThread.node_id : composer.nodeId;
  const targetNode = nodes.find((n) => n.id === targetNodeId);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.shiftKey) return;
    const native = e.nativeEvent;
    if (
      composing ||
      native.isComposing ||
      native.keyCode === 229 ||
      Date.now() - lastCompositionEndRef.current < 50
    ) {
      return;
    }
    e.preventDefault();
    if (!submitting && composer.prompt.trim()) {
      onSubmitPrompt();
    }
  }

  return (
    <section
      data-testid="conversation-pane"
      className="flex h-full min-w-0 flex-col bg-background overflow-hidden"
    >
      {/* Active Thread Bar */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-1.5">
        {selectedThread ? (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-xs font-semibold text-foreground text-balance">
                {selectedThread.title || selectedThread.project_key}
              </h2>
              <span
                title={selectedThread.workdir}
                className="inline-flex items-center gap-1 rounded-[4px] border border-border px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
              >
                {selectedThread.node_id}:{selectedThread.project_key}
              </span>
              <CopyButton
                text={selectedThread.workdir}
                ariaLabel={`复制工作目录 ${selectedThread.workdir}`}
                title={`复制目录路径：${selectedThread.workdir}`}
                className="hidden sm:inline-flex"
              />
              {selectedThread.native_session_id ? (
                <span
                  title={`native session: ${selectedThread.native_session_id}`}
                  className="hidden lg:inline text-[10px] font-mono text-muted-foreground"
                >
                  session:{selectedThread.native_session_id.slice(0, 12)}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5">
              {hasLineage && onOpenLineage ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onOpenLineage}
                  className="min-h-11 md:min-h-0 md:h-7 px-2 text-[11px]"
                >
                  <GitFork className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                  委派拓扑
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onForkThread(selectedThread)}
                className="min-h-11 md:min-h-0 md:h-7 text-[11px]"
              >
                <GitBranch className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                分叉会话
              </Button>
            </div>
          </>
        ) : (
          <div className="text-xs text-muted-foreground">新建任务或选择左侧会话查看执行流</div>
        )}
      </div>

      {/* Needs Approval Amber Banner */}
      {approvalRun ? (
        <div
          data-testid="needs-approval-banner"
          role="status"
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--status-approval)]/40 bg-[var(--status-approval)]/10 px-4 py-2.5"
        >
          <div className="flex min-w-0 items-center gap-2">
            <AlertTriangle
              className="h-4 w-4 shrink-0 text-[var(--status-approval)]"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div className="text-xs font-semibold text-[var(--status-approval)]">
                等待人工审批 · {approvalRun.id}
              </div>
              <div className="truncate text-[11px] text-muted-foreground font-mono">
                {approvalRun.remote_control_url ? (
                  <a
                    href={approvalRun.remote_control_url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    {approvalRun.remote_control_url}
                  </a>
                ) : (
                  "请在终端远程控制链接中放行执行"
                )}
              </div>
            </div>
          </div>
          {approvalRun.remote_control_url ? (
            <Button asChild size="sm" variant="outline" className="border-[var(--status-approval)]/50">
              <a
                href={approvalRun.remote_control_url}
                target="_blank"
                rel="noreferrer"
                data-testid="open-remote-approval-link"
              >
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                打开远程审批
              </a>
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Run Timeline Feed */}
      <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-border">
        {threadRuns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
            <p className="text-sm font-medium text-foreground text-balance">
              尚未创建任务。请在底部选择节点与项目目录并输入指令。
            </p>
            <p className="max-w-md text-xs text-muted-foreground text-pretty">
              支持从左侧工作区芯片或右侧节点控制面板快速选定目录并派发至本地 Agent。
            </p>
          </div>
        ) : (
          threadRuns.map((run) => {
            const isSelected = selectedRunId === run.id;
            const fullText = fullOutputByRunId[run.id];
            const displayMarkdown = fullText ?? run.output_md ?? run.output_preview ?? run.summary;
            const evCount = eventsByRunId[run.id]?.length ?? 0;
            const isActive =
              run.status === "queued" ||
              run.status === "claimed" ||
              run.status === "running" ||
              run.status === "needs_approval";
            const notifyMeta = formatNotifyBadgeMeta(run.notify_status, run.webhook_armed);
            const cmdExpanded = Boolean(expandedCmdRuns[run.id]);
            const cliPreview = buildRunCliPreview(run, selectedThread?.native_session_id);
            const rawPrompt = run.prompt ?? "";
            const isLongPrompt = rawPrompt.length > 260 || rawPrompt.split("\n").length > 5;
            const promptExpanded = Boolean(expandedPrompts[run.id]);

            return (
              <article
                key={run.id}
                data-testid={`run-row-${run.id}`}
                data-run-id={run.id}
                onClick={() => onSelectRun(run.id)}
                className={cn(
                  "py-3 pr-4 transition-colors duration-150 cursor-pointer",
                  isSelected
                    ? "border-l-2 border-l-[var(--status-running)] bg-surface-elevated/90 pl-3.5"
                    : "pl-4 hover:bg-surface-elevated/40"
                )}
              >
                <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-2 gap-y-1 sm:h-7 sm:flex-nowrap">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5 overflow-hidden sm:flex-nowrap">
                    <RunStatusBadge status={run.status} />
                    <span className="min-w-0 truncate text-xs font-mono text-foreground">{run.id}</span>
                    {run.depth > 0 ? (
                      <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                        depth={run.depth}
                      </Badge>
                    ) : null}
                    {!run.sandbox ? (
                      <Badge variant="approval" className="shrink-0 text-[10px]">
                        非沙箱
                      </Badge>
                    ) : null}
                    {notifyMeta ? (
                      <Badge variant={notifyMeta.tone === "neutral" ? "outline" : notifyMeta.tone} className="shrink-0 text-[10px]">
                        <Bell className="h-2.5 w-2.5" strokeWidth={1.75} aria-hidden="true" />
                        {notifyMeta.label}
                      </Badge>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground font-mono tabular-nums">
                    <span className="min-w-[3.5rem] text-right">{formatDurationMs(run.duration_ms)}</span>
                    <span className="min-w-[3.75rem] text-right">{formatBytes(run.output_bytes)}</span>
                    <span className="min-w-[4.25rem] text-right">{formatShortTime(run.created_at)}</span>
                  </div>
                </div>

                <div className="mt-1 flex min-h-7 flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-muted-foreground tabular-nums sm:h-7 sm:flex-nowrap">
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {run.agent} · {run.resolved_model || run.model || "default"}
                    {run.resolved_effort || run.effort ? `@${run.resolved_effort || run.effort}` : ""} · 过程事件：{evCount} 条
                  </span>
                  <div
                    className="flex shrink-0 items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {displayMarkdown ? (
                      <CopyButton text={displayMarkdown} label="复制输出" copiedLabel="已复制" />
                    ) : null}

                    {isActive ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => onCancelRun(run.id, false)}
                        className="h-6 px-2 text-[11px]"
                      >
                        <Square className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                        取消任务
                      </Button>
                    ) : run.truncated && !fullText ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => onLoadFullOutput(run.id)}
                        className="h-6 px-2 text-[11px]"
                      >
                        <FileText className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                        加载完整输出
                      </Button>
                    ) : null}

                    <button
                      type="button"
                      aria-expanded={cmdExpanded}
                      onClick={() =>
                        setExpandedCmdRuns((prev) => ({ ...prev, [run.id]: !cmdExpanded }))
                      }
                      data-testid={`toggle-cmd-${run.id}`}
                      className={cn(
                        "inline-flex min-h-6 items-center gap-1 rounded-[5px] border px-2 py-0.5 text-[11px] font-medium transition-colors duration-150 cursor-pointer",
                        cmdExpanded
                          ? "border-foreground/30 bg-accent text-foreground"
                          : "border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
                      )}
                    >
                      <Terminal className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                      命令
                    </button>
                  </div>
                </div>

                {cmdExpanded ? (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    data-testid={`run-cmd-preview-${run.id}`}
                    className="mt-2 rounded-[6px] border border-border bg-muted/40 p-2 cursor-auto"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
                      <span className="font-medium">
                        下发执行命令（{run.sandbox ? "沙箱" : "跳过沙箱"} · 超时 {run.timeout_sec}s · 通知 {run.notify_status}）
                      </span>
                      <CopyButton text={cliPreview.fullCommand} label="复制命令" copiedLabel="已复制" variant="outline" />
                    </div>
                    <pre className="mt-1.5 overflow-x-auto font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-all">
                      {cliPreview.fullCommand}
                    </pre>
                  </div>
                ) : null}

                {rawPrompt ? (
                  <div className="mt-2 rounded-[6px] border border-border/80 bg-muted/30 px-3 py-2 text-xs text-foreground/90">
                    <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-medium text-muted-foreground">
                      <span>任务指令</span>
                      {isLongPrompt ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedPrompts((prev) => ({ ...prev, [run.id]: !promptExpanded }));
                          }}
                          className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
                        >
                          {promptExpanded ? "收起" : "展开全文"}
                          {promptExpanded ? (
                            <ChevronUp className="h-3 w-3" aria-hidden="true" />
                          ) : (
                            <ChevronDown className="h-3 w-3" aria-hidden="true" />
                          )}
                        </button>
                      ) : null}
                    </div>
                    <div
                      className={cn(
                        "whitespace-pre-wrap break-words text-pretty",
                        isLongPrompt && !promptExpanded && "line-clamp-4"
                      )}
                    >
                      {rawPrompt}
                    </div>
                  </div>
                ) : null}

                {run.error_message ? (
                  <div className="mt-2 border-l-2 border-[var(--status-failed)] pl-3 text-xs text-[var(--status-failed)] font-mono">
                    [{run.error_code || "ERROR"}] {run.error_message}
                  </div>
                ) : null}

                {displayMarkdown ? (
                  <div className="ahub-markdown mt-2.5">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayMarkdown}</ReactMarkdown>
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>

      {/* Prompt Composer Footer */}
      <form
        ref={setDropRef}
        onSubmit={(e) => {
          e.preventDefault();
          if (!submitting && composer.prompt.trim()) {
            onSubmitPrompt();
          }
        }}
        data-testid="prompt-composer"
        className={cn(
          "shrink-0 border-t border-border bg-surface-elevated p-3 transition-colors duration-150",
          isOver && "bg-[var(--status-running)]/10 border-[var(--status-running)]"
        )}
      >
        {targetNode?.status === "offline" ? (
          <div className="mb-2 rounded-[5px] border border-[var(--status-approval)]/40 bg-[var(--status-approval)]/10 px-2.5 py-1 text-[11px] text-[var(--status-approval)] text-pretty">
            目标节点当前离线。现在提交的任务将安全进入排队队列，并在节点上线后自动开始执行。
          </div>
        ) : null}

        {/* Target binding mode strip: Reply (locked) vs New (selectable) */}
        {isReplyMode ? (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-[6px] border border-border bg-background/60 px-2.5 py-1.5">
            <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
              <Lock className="h-3 w-3 shrink-0 text-[var(--status-running)]" strokeWidth={1.75} aria-hidden="true" />
              <span className="shrink-0 font-medium text-foreground">续聊绑定</span>
              <span className="truncate font-mono text-muted-foreground" title={selectedThread.workdir}>
                {selectedThread.node_id}:{selectedThread.project_key}
              </span>
            </div>
            <button
              type="button"
              onClick={() => onPatchComposer({ mode: "new" })}
              data-testid="switch-to-new-thread-btn"
              className="inline-flex shrink-0 items-center gap-1 rounded-[4px] border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent cursor-pointer"
            >
              <ArrowLeftRight className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
              切换为新建会话
            </button>
          </div>
        ) : (
          <div className="mb-2 space-y-1.5">
            {selectedThread ? (
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>新建独立会话</span>
                <button
                  type="button"
                  onClick={() =>
                    onPatchComposer({
                      mode: "reply",
                      nodeId: selectedThread.node_id,
                      workdir: selectedThread.workdir,
                      agent: selectedThread.agent
                    })
                  }
                  className="text-[11px] font-medium text-[var(--status-running)] hover:underline cursor-pointer"
                >
                  返回当前会话续聊
                </button>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-1.5">
              <div className="min-w-0">
                <label htmlFor="composer-node" className="mb-1 block text-[10px] text-muted-foreground">
                  选择节点
                </label>
                <Select
                  value={composer.nodeId || undefined}
                  onValueChange={(v) => {
                    const n = nodes.find((item) => item.id === v);
                    onPatchComposer({
                      mode: "new",
                      nodeId: v,
                      workdir: n?.workspaces[0]?.path ?? ""
                    });
                  }}
                >
                  <SelectTrigger id="composer-node" aria-label="选择节点">
                    <SelectValue placeholder="选择节点" />
                  </SelectTrigger>
                  <SelectContent>
                    {nodes.map((n) => (
                      <SelectItem key={n.id} value={n.id}>
                        {n.id} ({n.status === "online" ? "在线" : n.status === "draining" ? "已排空" : "离线"})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="min-w-0">
                <label htmlFor="composer-workdir" className="mb-1 block text-[10px] text-muted-foreground">
                  工作目录
                </label>
                <Select
                  value={composer.workdir || undefined}
                  onValueChange={(v) => onPatchComposer({ mode: "new", workdir: v })}
                >
                  <SelectTrigger id="composer-workdir" aria-label="工作目录">
                    <SelectValue placeholder={composer.workdir || "工作目录"} />
                  </SelectTrigger>
                  <SelectContent>
                    {workspaces.map((ws) => (
                      <SelectItem key={ws.path} value={ws.path}>
                        {ws.key}
                      </SelectItem>
                    ))}
                    {composer.workdir && !workspaces.some((w) => w.path === composer.workdir) ? (
                      <SelectItem value={composer.workdir}>{composer.workdir}</SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        )}

        {/* Mobile compact parameter toggle (< 640px) */}
        <div className="mb-2 flex items-center justify-between gap-2 sm:hidden">
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {composer.agent} · {composer.model || "default"} · {composer.effort || "auto"} ·{" "}
            {NOTIFY_LABELS[composer.notifyTarget]}
          </span>
          <button
            type="button"
            aria-expanded={mobileParamsOpen}
            onClick={() => setMobileParamsOpen((v) => !v)}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[5px] border border-border bg-background/70 px-2 text-[11px] text-foreground cursor-pointer"
          >
            <SlidersHorizontal className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
            {mobileParamsOpen ? "收起参数" : "参数"}
          </button>
        </div>

        {/* Agent, Model, Effort & Notification Channel */}
        <div
          className={cn(
            "mb-2 gap-1.5 sm:grid sm:grid-cols-4",
            mobileParamsOpen ? "grid grid-cols-2" : "hidden"
          )}
        >
          <div className="min-w-0">
            <label htmlFor="composer-agent" className="mb-1 block text-[10px] text-muted-foreground">
              Agent
            </label>
            <Select
              value={composer.agent}
              onValueChange={(v) => {
                const nextAgent = v as AgentName;
                onPatchComposer({
                  agent: nextAgent,
                  model: MODEL_OPTIONS[nextAgent]?.[0] ?? ""
                });
              }}
            >
              <SelectTrigger id="composer-agent" aria-label="Agent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGENT_OPTIONS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-0">
            <label htmlFor="composer-model" className="mb-1 block text-[10px] text-muted-foreground">
              模型
            </label>
            <Select
              value={composer.model}
              onValueChange={(v) => onPatchComposer({ model: v })}
            >
              <SelectTrigger id="composer-model" aria-label="模型">
                <SelectValue placeholder="默认模型" />
              </SelectTrigger>
              <SelectContent>
                {(MODEL_OPTIONS[composer.agent] ?? ["carbon"]).map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-0">
            <label htmlFor="composer-effort" className="mb-1 block text-[10px] text-muted-foreground">
              推理强度
            </label>
            <Select
              value={composer.effort}
              onValueChange={(v) => onPatchComposer({ effort: v as EffortLevel })}
            >
              <SelectTrigger id="composer-effort" aria-label="推理强度">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EFFORT_OPTIONS.map((eff) => (
                  <SelectItem key={eff} value={eff}>
                    {eff}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-0">
            <label htmlFor="composer-notify" className="mb-1 block text-[10px] text-muted-foreground">
              通知通道
            </label>
            <Select
              value={composer.notifyTarget}
              onValueChange={(v) =>
                onPatchComposer({ notifyTarget: v as ComposerDraft["notifyTarget"] })
              }
            >
              <SelectTrigger id="composer-notify" aria-label="通知通道">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">不通知</SelectItem>
                <SelectItem value="webhook">Bot Webhook</SelectItem>
                <SelectItem value="grok">Grok</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <label htmlFor="prompt-input" className="sr-only">
          任务指令
        </label>
        <Textarea
          id="prompt-input"
          value={composer.prompt}
          onChange={(e) => onPatchComposer({ prompt: e.target.value })}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => {
            setComposing(false);
            lastCompositionEndRef.current = Date.now();
          }}
          onKeyDown={handleKeyDown}
          placeholder="输入任务指令（Enter 发送，Shift+Enter 换行，支持将左侧工作区拖入此处）..."
          className="min-h-[68px] text-xs"
        />

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <label className="inline-flex min-h-11 sm:min-h-0 items-center gap-1.5 cursor-pointer">
              <Switch
                checked={composer.sandbox}
                onCheckedChange={(checked) => onPatchComposer({ sandbox: checked })}
              />
              <Shield className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              <span>沙箱隔离</span>
            </label>
          </div>

          <Button
            type="submit"
            disabled={submitting || !composer.prompt.trim()}
            data-testid="submit-run-button"
            className="min-h-11 sm:min-h-0 sm:h-8 px-4"
          >
            <Send className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            {submitting ? "派发中..." : "发送指令"}
          </Button>
        </div>
      </form>
    </section>
  );
}
