import { useEffect, useMemo, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  Bell,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  CheckCircle2,
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
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  getAvailableAgents,
  reconcileComposerDraft,
  resolveAgentCatalog,
  resolveEffortState,
  resolveInitialComposerModelAndEffort
} from "@/lib/capabilities";
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
import { MARKDOWN_COMPONENTS } from "./markdown-components";
import { RunStatusBadge } from "./StatusBadge";

const DEFAULT_OPTION_VALUE = "__default__";
const CUSTOM_OPTION_VALUE = "__custom__";
const LONG_OUTPUT_CHARS = 4000;
const LONG_OUTPUT_LINES = 60;
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
  composerNotice?: string | null;
  submitting: boolean;
  onPatchComposer: (patch: Partial<ComposerDraft>) => void;
  onDismissComposerNotice?: () => void;
  onSelectRun: (runId: string) => void;
  onLoadFullOutput: (runId: string) => void;
  onCancelRun: (runId: string, cascade: boolean) => void;
  onResolveRun?: (runId: string) => void;
  onForkThread: (thread: ThreadRecord) => void;
  onOpenLineage?: () => void;
  onOpenRunEvents?: (runId: string) => void;
  onOpenRunDeliveries?: (runId: string) => void;
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
  composerNotice,
  submitting,
  onPatchComposer,
  onDismissComposerNotice,
  onSelectRun,
  onLoadFullOutput,
  onCancelRun,
  onResolveRun,
  onForkThread,
  onOpenLineage,
  onOpenRunEvents,
  onOpenRunDeliveries,
  onSubmitPrompt
}: ConversationPaneProps) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: "composer-workdir-dropzone"
  });

  const lastCompositionEndRef = useRef<number>(0);
  const [composing, setComposing] = useState(false);
  const [expandedCmdRuns, setExpandedCmdRuns] = useState<Record<string, boolean>>({});
  const [expandedPrompts, setExpandedPrompts] = useState<Record<string, boolean>>({});
  const [expandedOutputs, setExpandedOutputs] = useState<Record<string, boolean>>({});
  const [mobileParamsOpen, setMobileParamsOpen] = useState(false);
  const [mobileComposerCollapsed, setMobileComposerCollapsed] = useState(false);
  const [customModelMode, setCustomModelMode] = useState(false);

  const selectedNode = nodes.find((n) => n.id === composer.nodeId);
  const workspaces = selectedNode?.workspaces ?? [];
  const approvalRun = threadRuns.find((r) => r.status === "needs_approval") ?? null;

  const isReplyMode = composer.mode === "reply" && selectedThread !== null;
  const targetNodeId = isReplyMode ? selectedThread.node_id : composer.nodeId;
  const targetNode = nodes.find((n) => n.id === targetNodeId);

  const availableAgents = useMemo(() => getAvailableAgents(targetNode), [targetNode]);
  const agentOptions = useMemo(
    () =>
      isReplyMode && selectedThread && !availableAgents.includes(selectedThread.agent)
        ? [selectedThread.agent, ...availableAgents]
        : availableAgents,
    [availableAgents, isReplyMode, selectedThread]
  );
  const catalog = useMemo(
    () => resolveAgentCatalog(targetNode, composer.agent),
    [targetNode, composer.agent]
  );
  const effortState = useMemo(
    () => resolveEffortState(targetNode, composer.agent, composer.model),
    [targetNode, composer.agent, composer.model]
  );

  useEffect(() => {
    const patch = reconcileComposerDraft(composer, targetNode, isReplyMode);
    if (patch) {
      onPatchComposer(patch);
    }
  }, [composer.agent, composer.model, composer.effort, targetNode, isReplyMode, onPatchComposer]);

  useEffect(() => {
    if (threadRuns.length === 0 || composer.mode === "new" || composer.prompt.trim() !== "") {
      setMobileComposerCollapsed(false);
    }
  }, [composer.mode, composer.prompt, threadRuns.length]);

  const showMobileComposerToggle = threadRuns.length > 0;
  const isMobileComposerCompact = showMobileComposerToggle && mobileComposerCollapsed;

  const modelInCatalog = catalog.models.some((m) => m.id === composer.model);
  const showCustomModelInput =
    customModelMode ||
    (catalog.status !== "pending" && composer.model !== "" && !modelInCatalog);
  const modelSelectValue = composer.model ? composer.model : DEFAULT_OPTION_VALUE;
  const effortSelectValue = !effortState.supportsEffort
    ? DEFAULT_OPTION_VALUE
    : composer.effort && effortState.efforts.includes(composer.effort)
      ? composer.effort
      : DEFAULT_OPTION_VALUE;

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
      className="relative flex h-full min-w-0 flex-col bg-background overflow-hidden"
    >
      {/* Active Thread Bar */}
      <div className="flex min-h-12 md:min-h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3 sm:px-4 py-1.5">
        {selectedThread ? (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
              <h2 className="min-w-0 truncate text-xs font-semibold text-foreground text-balance">
                {selectedThread.title || selectedThread.project_key}
              </h2>
              <span
                title={selectedThread.workdir}
                className="inline-flex max-w-[128px] sm:max-w-none shrink-0 items-center gap-1 truncate rounded-[4px] border border-border px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
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
            <div className="flex shrink-0 items-center gap-1.5">
              {hasLineage && onOpenLineage ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onOpenLineage}
                  className="min-h-11 md:min-h-0 md:h-7 px-2 text-xs md:text-[11px]"
                >
                  <GitFork className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                  <span className="hidden sm:inline">委派拓扑</span>
                  <span className="sm:hidden">拓扑</span>
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onForkThread(selectedThread)}
                className="min-h-11 md:min-h-0 md:h-7 px-2.5 text-xs md:text-[11px]"
              >
                <GitBranch className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                <span className="hidden sm:inline">分叉会话</span>
                <span className="sm:hidden">分叉</span>
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
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {approvalRun.remote_control_url ? (
              <Button
                asChild
                size="sm"
                variant="outline"
                className="min-h-11 md:min-h-0 md:h-7 border-[var(--status-approval)]/50"
              >
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
            {onResolveRun ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="resolve-approval-btn"
                onClick={() => onResolveRun(approvalRun.id)}
                className="min-h-11 md:min-h-0 md:h-7 border-[var(--status-approval)]/50"
              >
                <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                标记已放行
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Run Timeline Feed */}
      <div className="relative min-h-0 flex-1 overflow-y-auto divide-y divide-border">
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
            const fullText =
              fullOutputByRunId[run.id] ??
              run.output_md ??
              (run.truncated === false ? run.output_preview : undefined);
            const hasFullOutput = fullText !== undefined && fullText !== "";
            const previewText = !hasFullOutput ? run.output_preview : undefined;
            const canHaveOutput =
              run.status === "done" ||
              run.status === "failed" ||
              run.status === "cancelled" ||
              run.status === "needs_approval";
            const hasUnloadedOutput = canHaveOutput && run.output_bytes > 0 && !hasFullOutput;
            const copyableText = (hasFullOutput ? fullText : undefined) ?? previewText ?? run.summary;
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
            const lineCount = hasFullOutput ? fullText.split("\n").length : 0;
            const isLongOutput =
              hasFullOutput && (fullText.length > LONG_OUTPUT_CHARS || lineCount > LONG_OUTPUT_LINES);
            const outputExpanded = Boolean(expandedOutputs[run.id]);

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
                      onOpenRunDeliveries ? (
                        <button
                          type="button"
                          data-testid={`open-run-deliveries-${run.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenRunDeliveries(run.id);
                          }}
                          className="inline-flex min-h-11 px-2.5 md:min-h-6 md:px-1.5 items-center gap-1 rounded-[5px] border border-border bg-card text-[11px] md:text-[10px] font-medium text-foreground hover:bg-accent cursor-pointer tabular-nums"
                        >
                          <Bell className="h-2.5 w-2.5" strokeWidth={1.75} aria-hidden="true" />
                          <span>{notifyMeta.label}</span>
                          {run.deliveries_summary && run.deliveries_summary.total > 0 ? (
                            <span className="font-mono text-muted-foreground">
                              {run.deliveries_summary.sent}/{run.deliveries_summary.total}
                            </span>
                          ) : null}
                        </button>
                      ) : (
                        <Badge variant={notifyMeta.tone === "neutral" ? "outline" : notifyMeta.tone} className="shrink-0 text-[10px]">
                          <Bell className="h-2.5 w-2.5" strokeWidth={1.75} aria-hidden="true" />
                          {notifyMeta.label}
                        </Badge>
                      )
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground font-mono tabular-nums">
                    <span className="min-w-[3.5rem] text-right">{formatDurationMs(run.duration_ms)}</span>
                    <span className="min-w-[3.75rem] text-right">{formatBytes(run.output_bytes)}</span>
                    <span className="min-w-[4.25rem] text-right">{formatShortTime(run.created_at)}</span>
                  </div>
                </div>

                <div className="mt-1 flex min-h-7 flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-muted-foreground tabular-nums sm:flex-nowrap">
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {run.agent} · {run.resolved_model || run.model || "default"}
                    {run.resolved_effort || run.effort ? `@${run.resolved_effort || run.effort}` : ""} · 过程事件：{evCount} 条
                  </span>
                  <div
                    className="flex shrink-0 flex-wrap items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {copyableText ? (
                      <CopyButton text={copyableText} label="复制输出" copiedLabel="已复制" />
                    ) : null}

                    {isActive ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => onCancelRun(run.id, false)}
                        className="min-h-11 md:min-h-0 md:h-6 px-2.5 md:px-2 text-xs md:text-[11px]"
                      >
                        <Square className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                        取消任务
                      </Button>
                    ) : hasUnloadedOutput ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        data-testid={`load-full-output-${run.id}`}
                        onClick={() => onLoadFullOutput(run.id)}
                        className="min-h-11 md:min-h-0 md:h-6 px-2.5 md:px-2 text-xs md:text-[11px]"
                      >
                        <FileText className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                        加载完整输出
                      </Button>
                    ) : null}

                    {onOpenRunEvents ? (
                      <button
                        type="button"
                        data-testid={`open-run-events-${run.id}`}
                        onClick={() => onOpenRunEvents(run.id)}
                        className="inline-flex min-h-11 md:min-h-6 items-center gap-1 rounded-[5px] border border-border bg-transparent px-2.5 md:px-2 py-0.5 text-xs md:text-[11px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground cursor-pointer tabular-nums"
                      >
                        <Activity className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                        事件 {evCount}
                      </button>
                    ) : null}

                    <button
                      type="button"
                      aria-expanded={cmdExpanded}
                      onClick={() =>
                        setExpandedCmdRuns((prev) => ({ ...prev, [run.id]: !cmdExpanded }))
                      }
                      data-testid={`toggle-cmd-${run.id}`}
                      className={cn(
                        "inline-flex min-h-11 md:min-h-6 items-center gap-1 rounded-[5px] border px-2.5 md:px-2 py-0.5 text-xs md:text-[11px] font-medium transition-colors duration-150 cursor-pointer",
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
                          className="inline-flex min-h-11 px-2 md:min-h-0 md:px-1 items-center gap-0.5 text-xs md:text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
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

                {hasFullOutput ? (
                  <div className="mt-2.5">
                    <div
                      className={cn(
                        "ahub-markdown relative",
                        isLongOutput && !outputExpanded && "max-h-[30rem] overflow-hidden"
                      )}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                        {fullText}
                      </ReactMarkdown>
                      {isLongOutput && !outputExpanded ? (
                        <div
                          aria-hidden="true"
                          className={cn(
                            "pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t to-transparent",
                            isSelected ? "from-surface-elevated" : "from-background"
                          )}
                        />
                      ) : null}
                    </div>
                    {isLongOutput ? (
                      <div className="mt-2 flex items-center">
                        <button
                          type="button"
                          data-testid={`toggle-output-${run.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedOutputs((prev) => ({ ...prev, [run.id]: !outputExpanded }));
                          }}
                          className="inline-flex min-h-11 md:min-h-0 items-center gap-1 rounded-[5px] border border-border bg-muted/40 px-3 md:px-2.5 py-1.5 md:py-1 text-xs md:text-[11px] font-medium text-foreground tabular-nums transition-colors duration-150 hover:bg-accent cursor-pointer"
                        >
                          {outputExpanded ? (
                            <>
                              <ChevronUp className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                              收起长输出
                            </>
                          ) : (
                            <>
                              <ChevronDown className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                              展开全文（{formatBytes(run.output_bytes || fullText.length)} · {lineCount} 行）
                            </>
                          )}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : previewText ? (
                  <div className="mt-2.5 space-y-2">
                    <div
                      data-testid={`run-truncated-notice-${run.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border border-[var(--status-approval)]/40 bg-[var(--status-approval)]/10 px-3 py-1.5 text-[11px] text-foreground tabular-nums"
                    >
                      <span>当前仅展示尾部预览 · 完整输出 {formatBytes(run.output_bytes)}</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid={`load-full-output-banner-${run.id}`}
                        onClick={() => onLoadFullOutput(run.id)}
                        className="min-h-11 md:min-h-0 md:h-6 px-2.5 md:px-2 text-xs md:text-[11px]"
                      >
                        <FileText className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                        加载完整输出
                      </Button>
                    </div>
                    <div className="ahub-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                        {previewText}
                      </ReactMarkdown>
                    </div>
                  </div>
                ) : hasUnloadedOutput ? (
                  <div
                    data-testid={`run-unloaded-notice-${run.id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="mt-2.5 space-y-1.5 rounded-[6px] border border-border bg-muted/25 px-3 py-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground tabular-nums">
                      <span>完整输出加载中（{formatBytes(run.output_bytes)}）...</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid={`load-full-output-banner-${run.id}`}
                        onClick={() => onLoadFullOutput(run.id)}
                        className="min-h-11 md:min-h-0 md:h-6 px-2.5 md:px-2 text-xs md:text-[11px]"
                      >
                        <FileText className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                        加载完整输出
                      </Button>
                    </div>
                    {run.summary ? (
                      <p className="line-clamp-2 text-xs text-muted-foreground text-pretty">
                        末行摘要：{run.summary}
                      </p>
                    ) : null}
                  </div>
                ) : run.summary ? (
                  <div className="ahub-markdown mt-2.5">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                      {run.summary}
                    </ReactMarkdown>
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
          "relative shrink-0 border-t border-border bg-surface-elevated pt-2.5 pb-[max(0.75rem,var(--safe-bottom))] pl-[max(0.75rem,var(--safe-left))] pr-[max(0.75rem,var(--safe-right))] sm:p-3 sm:pb-[max(0.75rem,var(--safe-bottom))] transition-colors duration-150",
          isOver && "bg-[var(--status-running)]/10 border-[var(--status-running)]"
        )}
      >
        {isMobileComposerCompact ? (
          <div className="flex items-center justify-between gap-2 md:hidden">
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              {isReplyMode
                ? `续聊 ${selectedThread.node_id}:${selectedThread.project_key} · ${selectedThread.agent}`
                : `新建 ${composer.nodeId || "节点"} · ${composer.agent}`}
            </span>
            <button
              type="button"
              data-testid="toggle-mobile-composer"
              aria-expanded={false}
              onClick={() => {
                setMobileComposerCollapsed(false);
                window.requestAnimationFrame(() => {
                  document.getElementById("prompt-input")?.focus();
                });
              }}
              className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-[5px] border border-border bg-card px-2.5 text-xs font-medium text-foreground hover:bg-accent cursor-pointer"
            >
              <ChevronUp className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              展开输入指令
            </button>
          </div>
        ) : null}

        <div className={cn(isMobileComposerCompact && "hidden md:block")}>
          {composerNotice ? (
            <div
              role="status"
              data-testid="composer-notice"
              className="mb-2 flex items-center justify-between gap-2 rounded-[5px] border border-[var(--status-running)]/35 bg-[var(--status-running)]/10 px-2.5 py-1.5 text-[11px] text-foreground text-pretty"
            >
              <span>{composerNotice}</span>
              {onDismissComposerNotice ? (
                <button
                  type="button"
                  onClick={onDismissComposerNotice}
                  aria-label="关闭提示"
                  className="inline-flex min-h-11 px-2 md:min-h-0 md:px-0 shrink-0 items-center text-xs md:text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  关闭
                </button>
              ) : null}
            </div>
          ) : null}
          {targetNode?.status === "offline" ? (
            <div className="mb-2 rounded-[5px] border border-[var(--status-approval)]/40 bg-[var(--status-approval)]/10 px-2.5 py-1 text-[11px] text-[var(--status-approval)] text-pretty">
              目标节点当前离线。现在提交的任务将安全进入排队队列，并在节点上线后自动开始执行。
            </div>
          ) : null}

          {/* Target binding mode strip: Reply (locked) vs New (selectable) */}
          {isReplyMode ? (
            <div className="mb-2 flex items-center justify-between gap-1.5 rounded-[6px] border border-border bg-background/60 px-2.5 py-1 md:py-1.5">
              <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
                <Lock className="h-3 w-3 shrink-0 text-[var(--status-running)]" strokeWidth={1.75} aria-hidden="true" />
                <span className="hidden sm:inline shrink-0 font-medium text-foreground">续聊绑定</span>
                <span className="truncate font-mono text-muted-foreground" title={selectedThread.workdir}>
                  {selectedThread.node_id}:{selectedThread.project_key} · {selectedThread.agent}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => onPatchComposer({ mode: "new" })}
                  data-testid="switch-to-new-thread-btn"
                  className="inline-flex min-h-11 sm:min-h-0 shrink-0 items-center gap-1 rounded-[4px] border border-border bg-card px-2.5 sm:px-2 py-1 sm:py-0.5 text-xs sm:text-[11px] font-medium text-foreground hover:bg-accent cursor-pointer"
                >
                  <ArrowLeftRight className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                  <span className="hidden sm:inline">切换为新建会话</span>
                  <span className="sm:hidden">新建</span>
                </button>
                {showMobileComposerToggle ? (
                  <button
                    type="button"
                    data-testid="toggle-mobile-composer"
                    aria-expanded={true}
                    onClick={() => setMobileComposerCollapsed(true)}
                    className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-[4px] border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer md:hidden"
                  >
                    <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                    收起
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="mb-2 space-y-1.5">
              {selectedThread ? (
                <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span>新建独立会话</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        const sameBinding =
                          selectedThread.node_id === composer.nodeId &&
                          selectedThread.agent === composer.agent;
                        setCustomModelMode(false);
                        onPatchComposer({
                          mode: "reply",
                          nodeId: selectedThread.node_id,
                          workdir: selectedThread.workdir,
                          agent: selectedThread.agent,
                          ...(sameBinding ? {} : { model: "", effort: "" })
                        });
                      }}
                      className="inline-flex min-h-11 sm:min-h-0 items-center px-2 sm:px-0 text-xs sm:text-[11px] font-medium text-[var(--status-running)] hover:underline cursor-pointer"
                    >
                      返回当前会话续聊
                    </button>
                    {showMobileComposerToggle ? (
                      <button
                        type="button"
                        data-testid="toggle-mobile-composer"
                        aria-expanded={true}
                        onClick={() => setMobileComposerCollapsed(true)}
                        className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-[4px] border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer md:hidden"
                      >
                        <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                        收起
                      </button>
                    ) : null}
                  </div>
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
                    const nextAgents = getAvailableAgents(n);
                    const nextAgent = nextAgents.includes(composer.agent)
                      ? composer.agent
                      : (nextAgents[0] ?? composer.agent);
                    const { model: nextModel, effort: nextEffort } =
                      resolveInitialComposerModelAndEffort(n, nextAgent);
                    setCustomModelMode(false);
                    onPatchComposer({
                      mode: "new",
                      nodeId: v,
                      workdir: n?.workspaces[0]?.path ?? "",
                      agent: nextAgent,
                      model: nextModel,
                      effort: nextEffort
                    });
                  }}
                >
                  <SelectTrigger id="composer-node" aria-label="选择节点">
                    <SelectValue placeholder="选择节点" />
                  </SelectTrigger>
                  <SelectContent>
                    {nodes.map((n) => (
                      <SelectItem key={n.id} value={n.id} data-testid={`composer-node-option-${n.id}`}>
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
            {composer.agent} · {composer.model || catalog.defaultModel || "default"} ·{" "}
            {composer.effort || effortState.defaultEffort || "auto"} ·{" "}
            {NOTIFY_LABELS[composer.notifyTarget]}
          </span>
          <button
            type="button"
            data-testid="toggle-mobile-params"
            aria-expanded={mobileParamsOpen}
            onClick={() => setMobileParamsOpen((v) => !v)}
            className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-[5px] border border-border bg-background/70 px-2.5 text-xs text-foreground cursor-pointer"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
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
              disabled={isReplyMode}
              value={composer.agent}
              onValueChange={(v) => {
                const nextAgent = v as AgentName;
                const { model: nextModel, effort: nextEffort } =
                  resolveInitialComposerModelAndEffort(targetNode, nextAgent);
                setCustomModelMode(false);
                onPatchComposer({
                  agent: nextAgent,
                  model: nextModel,
                  effort: nextEffort
                });
              }}
            >
              <SelectTrigger id="composer-agent" aria-label="Agent" disabled={isReplyMode}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {agentOptions.map((a) => (
                  <SelectItem key={a} value={a} data-testid={`composer-agent-option-${a}`}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-0">
            <label
              htmlFor={showCustomModelInput ? "composer-model-custom" : "composer-model"}
              className="mb-1 block text-[10px] text-muted-foreground"
            >
              模型
            </label>
            {showCustomModelInput ? (
              <div className="flex items-center gap-1">
                <Input
                  id="composer-model-custom"
                  data-testid="composer-model-custom-input"
                  value={composer.model}
                  onChange={(e) => onPatchComposer({ model: e.target.value })}
                  placeholder={catalog.defaultModel ? `默认: ${catalog.defaultModel}` : "输入模型 ID"}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setCustomModelMode(false);
                    onPatchComposer({ model: catalog.defaultModel || "" });
                  }}
                  className="min-h-11 sm:min-h-0 sm:h-8 shrink-0 px-2.5 text-xs sm:text-[11px]"
                >
                  列表
                </Button>
              </div>
            ) : (
              <Select
                value={modelSelectValue}
                onValueChange={(v) => {
                  if (v === CUSTOM_OPTION_VALUE) {
                    setCustomModelMode(true);
                    return;
                  }
                  setCustomModelMode(false);
                  const nextModel = v === DEFAULT_OPTION_VALUE ? "" : v;
                  const nextEffState = resolveEffortState(targetNode, composer.agent, nextModel);
                  let nextEffort = composer.effort;
                  if (!nextEffState.supportsEffort) {
                    nextEffort = "";
                  } else if (nextEffort !== "" && !nextEffState.efforts.includes(nextEffort)) {
                    nextEffort = nextEffState.defaultEffort || nextEffState.efforts[0] || "";
                  }
                  onPatchComposer({ model: nextModel, effort: nextEffort });
                }}
              >
                <SelectTrigger id="composer-model" aria-label="模型">
                  <SelectValue placeholder="跟随节点默认" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_OPTION_VALUE} data-testid="composer-model-option-default">
                    {catalog.defaultModel ? `跟随默认 (${catalog.defaultModel})` : "跟随节点默认"}
                  </SelectItem>
                  {catalog.models.map((m) => (
                    <SelectItem key={m.id} value={m.id} data-testid={`composer-model-option-${m.id}`}>
                      {m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id}
                    </SelectItem>
                  ))}
                  {composer.model !== "" && !modelInCatalog ? (
                    <SelectItem value={composer.model}>{composer.model}</SelectItem>
                  ) : null}
                  <SelectItem value={CUSTOM_OPTION_VALUE} data-testid="composer-model-option-custom">
                    手动输入模型...
                  </SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="min-w-0">
            <label htmlFor="composer-effort" className="mb-1 block text-[10px] text-muted-foreground">
              推理强度
            </label>
            <Select
              disabled={!effortState.supportsEffort}
              value={effortSelectValue}
              onValueChange={(v) =>
                onPatchComposer({
                  effort: v === DEFAULT_OPTION_VALUE ? "" : (v as EffortLevel)
                })
              }
            >
              <SelectTrigger id="composer-effort" aria-label="推理强度" disabled={!effortState.supportsEffort}>
                <SelectValue placeholder={!effortState.supportsEffort ? "无推理档位" : "默认 / 自动"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_OPTION_VALUE} data-testid="composer-effort-option-default">
                  {!effortState.supportsEffort
                    ? "当前模型无推理档位"
                    : effortState.defaultEffort
                      ? `跟随默认 (${effortState.defaultEffort})`
                      : "默认 / 自动"}
                </SelectItem>
                {effortState.efforts.map((eff) => (
                  <SelectItem key={eff} value={eff} data-testid={`composer-effort-option-${eff}`}>
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
          placeholder="输入任务指令（Enter 发送，Shift+Enter 换行）..."
          className="min-h-[64px] sm:min-h-[68px]"
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
        </div>
      </form>
    </section>
  );
}
