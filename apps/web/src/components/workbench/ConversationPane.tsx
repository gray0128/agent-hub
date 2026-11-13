import { useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { AlertTriangle, ExternalLink, FileText, GitBranch, Send, Shield, Square } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatBytes, formatDurationMs, formatShortTime } from "@/lib/utils";
import type { ComposerDraft } from "@/stores/workbench-store";
import type { AgentName, EffortLevel, NodeRecord, RunEventItem, RunRecord, ThreadRecord } from "@/types";
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

export interface ConversationPaneProps {
  nodes: NodeRecord[];
  selectedThread: ThreadRecord | null;
  threadRuns: RunRecord[];
  selectedRunId: string | null;
  fullOutputByRunId: Record<string, string>;
  eventsByRunId: Record<string, RunEventItem[]>;
  composer: ComposerDraft;
  submitting: boolean;
  onPatchComposer: (patch: Partial<ComposerDraft>) => void;
  onSelectRun: (runId: string) => void;
  onLoadFullOutput: (runId: string) => void;
  onCancelRun: (runId: string, cascade: boolean) => void;
  onForkThread: (thread: ThreadRecord) => void;
  onSubmitPrompt: () => void;
}

export function ConversationPane({
  nodes,
  selectedThread,
  threadRuns,
  selectedRunId,
  fullOutputByRunId,
  eventsByRunId,
  composer,
  submitting,
  onPatchComposer,
  onSelectRun,
  onLoadFullOutput,
  onCancelRun,
  onForkThread,
  onSubmitPrompt
}: ConversationPaneProps) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: "composer-workdir-dropzone"
  });

  const lastCompositionEndRef = useRef<number>(0);
  const [composing, setComposing] = useState(false);

  const selectedNode = nodes.find((n) => n.id === composer.nodeId);
  const workspaces = selectedNode?.workspaces ?? [];
  const approvalRun = threadRuns.find((r) => r.status === "needs_approval") ?? null;

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
              <span className="truncate text-xs font-semibold text-foreground">
                {selectedThread.title || selectedThread.project_key}
              </span>
              <span className="rounded-[4px] border border-border px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                {selectedThread.node_id}:{selectedThread.project_key}
              </span>
              {selectedThread.native_session_id ? (
                <span className="hidden sm:inline text-[10px] font-mono text-muted-foreground">
                  session:{selectedThread.native_session_id.slice(0, 14)}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onForkThread(selectedThread)}
                className="min-h-11 md:min-h-0 md:h-7 text-[11px]"
              >
                <GitBranch className="h-3 w-3" strokeWidth={1.75} />
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
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
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
            <p className="text-sm font-medium text-foreground">就绪 · 等待指令</p>
            <p className="max-w-md text-xs text-muted-foreground">
              从左侧拖拽或点击工作区，然后在下方输入 Prompt 派发至指定节点的本地 Agent。
            </p>
          </div>
        ) : (
          threadRuns.map((run) => {
            const isSelected = selectedRunId === run.id;
            const fullText = fullOutputByRunId[run.id];
            const displayMarkdown = fullText ?? run.output_md ?? run.output_preview ?? run.summary;
            const evCount = eventsByRunId[run.id]?.length ?? 0;
            const isActive = run.status === "queued" || run.status === "claimed" || run.status === "running" || run.status === "needs_approval";

            return (
              <article
                key={run.id}
                data-testid={`run-row-${run.id}`}
                data-run-id={run.id}
                onClick={() => onSelectRun(run.id)}
                className={cn(
                  "px-4 py-3 transition-colors duration-150 cursor-pointer",
                  isSelected ? "bg-surface-elevated/90" : "hover:bg-surface-elevated/40"
                )}
              >
                <div className="flex h-7 items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <RunStatusBadge status={run.status} />
                    <span className="truncate text-xs font-mono text-foreground">{run.id}</span>
                    {run.depth > 0 ? (
                      <span className="shrink-0 rounded-[4px] border border-border px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground tabular-nums">
                        depth={run.depth}
                      </span>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground font-mono tabular-nums">
                    <span className="min-w-[3.5rem] text-right">{formatDurationMs(run.duration_ms)}</span>
                    <span className="min-w-[3.75rem] text-right">{formatBytes(run.output_bytes)}</span>
                    <span className="min-w-[4.25rem] text-right">{formatShortTime(run.created_at)}</span>
                  </div>
                </div>

                <div className="mt-1 flex h-7 items-center justify-between gap-2 text-[11px] text-muted-foreground tabular-nums">
                  <span className="min-w-0 truncate font-mono">
                    {run.agent} · {run.resolved_model || run.model || "default"} · 过程事件：{evCount} 条
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {isActive ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          onCancelRun(run.id, false);
                        }}
                        className="h-7 px-2 text-[11px]"
                      >
                        <Square className="h-3 w-3" strokeWidth={1.75} />
                        取消任务
                      </Button>
                    ) : run.truncated && !fullText ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          onLoadFullOutput(run.id);
                        }}
                        className="h-7 px-2 text-[11px]"
                      >
                        <FileText className="h-3 w-3" strokeWidth={1.75} />
                        加载完整输出
                      </Button>
                    ) : null}
                  </div>
                </div>

                {run.prompt ? (
                  <div className="mt-2 border-l-2 border-border pl-3 text-xs text-foreground/90 whitespace-pre-wrap break-words">
                    {run.prompt}
                  </div>
                ) : null}

                {run.error_message ? (
                  <div className="mt-2 border-l-2 border-[var(--status-failed)] pl-3 text-xs text-[var(--status-failed)] font-mono">
                    [{run.error_code || "ERROR"}] {run.error_message}
                  </div>
                ) : null}

                {displayMarkdown ? (
                  <div className="mt-2.5 text-xs leading-relaxed text-foreground prose prose-sm max-w-none dark:prose-invert prose-pre:rounded-[6px] prose-pre:border prose-pre:border-border prose-pre:bg-muted/60 prose-pre:p-2.5 prose-code:text-[11px]">
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
        <div className="mb-2 grid grid-cols-2 gap-1.5 sm:grid-cols-5">
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

          <div className="min-w-0 col-span-2 sm:col-span-1">
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
            <label className="inline-flex min-h-11 md:min-h-0 items-center gap-1.5 cursor-pointer">
              <Switch
                checked={composer.sandbox}
                onCheckedChange={(checked) => onPatchComposer({ sandbox: checked })}
              />
              <Shield className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>沙箱隔离</span>
            </label>

            {selectedThread && composer.mode === "reply" ? (
              <span className="text-[11px] font-mono text-muted-foreground">
                续聊会话：{selectedThread.title || selectedThread.id}
              </span>
            ) : null}
          </div>

          <Button
            type="submit"
            disabled={submitting || !composer.prompt.trim()}
            data-testid="submit-run-button"
            className="min-h-11 md:min-h-0 md:h-8 px-4"
          >
            <Send className="h-3.5 w-3.5" strokeWidth={1.75} />
            {submitting ? "派发中..." : "发送指令"}
          </Button>
        </div>
      </form>
    </section>
  );
}
