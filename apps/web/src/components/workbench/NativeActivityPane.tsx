import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Info,
  Terminal
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, formatBytes, formatShortTime, shellQuote } from "@/lib/utils";
import type { NativeEventView } from "@/types";
import { CopyButton } from "./CopyButton";

const LONG_OUTPUT_CHARS = 4000;
const LONG_OUTPUT_LINES = 60;

export function buildNativeResumeCommand(
  ev: Pick<NativeEventView, "agent" | "native_session_id" | "workdir">
): { command: string; supportsSessionFlag: boolean } {
  const sid = ev.native_session_id.trim();
  const dir = ev.workdir.trim();
  const prefix = dir ? `cd -- ${shellQuote(dir)} && ` : "";
  if (!sid) {
    return { command: `${prefix}${ev.agent}`, supportsSessionFlag: ev.agent !== "grok" };
  }
  switch (ev.agent) {
    case "claude":
      return { command: `${prefix}claude --resume ${shellQuote(sid)}`, supportsSessionFlag: true };
    case "agy":
      return {
        command: `${prefix}agy --conversation ${shellQuote(sid)}`,
        supportsSessionFlag: true
      };
    case "codex":
      return { command: `${prefix}codex resume ${shellQuote(sid)}`, supportsSessionFlag: true };
    case "pi":
      return { command: `${prefix}pi --session ${shellQuote(sid)}`, supportsSessionFlag: true };
    case "omp":
      return { command: `${prefix}omp --resume=${shellQuote(sid)}`, supportsSessionFlag: true };
    case "grok":
      return { command: `${prefix}grok`, supportsSessionFlag: false };
  }
}

function eventKindMeta(kind: NativeEventView["event_kind"]): {
  label: string;
  variant: "approval" | "done" | "running";
} {
  switch (kind) {
    case "interaction_needed":
      return { label: "待互动", variant: "approval" };
    case "turn_summary":
      return { label: "回合总结", variant: "done" };
    case "progress":
      return { label: "阶段里程碑", variant: "running" };
  }
}

function attentionBadgeMeta(state: NativeEventView["attention_state"]): {
  label: string;
  variant: "approval" | "outline";
} | null {
  switch (state) {
    case "open":
      return { label: "待处理", variant: "approval" };
    case "acked":
      return { label: "已处理", variant: "outline" };
    case "superseded":
      return { label: "已由后续推进", variant: "outline" };
    case "stale":
      return { label: "已陈旧 (>24h)", variant: "outline" };
    default:
      return null;
  }
}

function notifyStatusMeta(status: NativeEventView["notify_status"]): {
  label: string;
  variant: "done" | "running" | "approval" | "failed" | "outline";
} {
  switch (status) {
    case "sent":
      return { label: "已送达", variant: "done" };
    case "partial":
      return { label: "部分送达", variant: "approval" };
    case "queued":
      return { label: "队列投递中", variant: "running" };
    case "failed":
      return { label: "投递失败", variant: "failed" };
    case "skipped":
      return { label: "已跳过", variant: "outline" };
    case "none":
    default:
      return { label: "未投递", variant: "outline" };
  }
}

export interface NativeActivityPaneProps {
  events: NativeEventView[];
  selectedEventId: string | null;
  hasActiveFilter: boolean;
  acknowledgingIds: Record<string, boolean>;
  onSelectEvent: (eventId: string) => void;
  onAckEvent: (eventId: string, scope: "single" | "session") => void;
  onOpenDeliveries: (eventId: string) => void;
  onCreateControlledRun: (anchorEvent: NativeEventView, sessionEvents: NativeEventView[]) => void;
}

export function NativeActivityPane({
  events,
  selectedEventId,
  hasActiveFilter,
  acknowledgingIds,
  onSelectEvent,
  onAckEvent,
  onOpenDeliveries,
  onCreateControlledRun
}: NativeActivityPaneProps) {
  const [expandedBodies, setExpandedBodies] = useState<Record<string, boolean>>({});

  const orderedEvents = useMemo(
    () =>
      [...events].sort((a, b) =>
        a.created_at !== b.created_at
          ? a.created_at.localeCompare(b.created_at)
          : a.id.localeCompare(b.id)
      ),
    [events]
  );

  const anchorEvent = useMemo(() => {
    if (selectedEventId) {
      const found = orderedEvents.find((e) => e.id === selectedEventId);
      if (found) return found;
    }
    return orderedEvents[orderedEvents.length - 1] ?? null;
  }, [orderedEvents, selectedEventId]);

  const openCountInSession = useMemo(
    () => orderedEvents.filter((ev) => ev.attention_state === "open").length,
    [orderedEvents]
  );

  const resumeInfo = useMemo(
    () => (anchorEvent ? buildNativeResumeCommand(anchorEvent) : null),
    [anchorEvent]
  );

  return (
    <section
      data-testid="native-activity-pane"
      className="relative flex h-full min-w-0 flex-col bg-background overflow-hidden"
    >
      {/* Read-Only Header Bar */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        {anchorEvent && resumeInfo ? (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="font-mono text-[10px]">
                {anchorEvent.node_id}
              </Badge>
              <Badge variant="secondary" className="font-mono text-[10px]">
                {anchorEvent.agent}
              </Badge>
              {anchorEvent.workdir ? (
                <span
                  title={anchorEvent.workdir}
                  className="max-w-[220px] truncate font-mono text-[11px] text-foreground"
                >
                  {anchorEvent.workdir}
                </span>
              ) : null}
              {anchorEvent.native_session_id ? (
                <span
                  title={anchorEvent.native_session_id}
                  className="hidden lg:inline font-mono text-[10px] text-muted-foreground"
                >
                  session:{anchorEvent.native_session_id.slice(0, 12)}
                </span>
              ) : null}
              <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                {formatShortTime(anchorEvent.created_at)}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <CopyButton
                text={resumeInfo.command}
                label="复制本机续接命令"
                copiedLabel="已复制命令"
                variant="outline"
                testId="copy-native-resume-btn"
              />
              {Boolean(anchorEvent.native_session_id.trim()) && openCountInSession > 1 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="ack-native-session-btn"
                  disabled={Boolean(acknowledgingIds[anchorEvent.id])}
                  onClick={() => onAckEvent(anchorEvent.id, "session")}
                  className="min-h-11 md:min-h-0 md:h-7 px-2.5 text-[11px]"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  确认本会话全部 ({openCountInSession})
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="default"
                data-testid="native-to-controlled-btn"
                onClick={() => onCreateControlledRun(anchorEvent, orderedEvents)}
                className="min-h-11 md:min-h-0 md:h-7 px-2.5 text-[11px]"
              >
                <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                携带摘要新建受控任务
              </Button>
            </div>
          </>
        ) : (
          <div className="text-xs text-muted-foreground">原生活动详情（只读时间线）</div>
        )}
      </div>

      {/* Timeline Body */}
      <div className="relative min-h-0 flex-1 overflow-y-auto divide-y divide-border">
        {orderedEvents.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="max-w-md text-xs text-muted-foreground text-pretty">
              {hasActiveFilter
                ? "当前筛选条件下没有匹配的原生活动记录。尝试切换筛选条件或清除搜索关键字。"
                : "暂无本地原生会话记录。请在节点 `node.json` 中启用 `native_notify.enabled` 并安装官方 Hook。"}
            </p>
          </div>
        ) : (
          orderedEvents.map((ev) => {
            const isSelected = anchorEvent?.id === ev.id;
            const kindMeta = eventKindMeta(ev.event_kind);
            const attMeta = attentionBadgeMeta(ev.attention_state);
            const notifyMeta = notifyStatusMeta(ev.notify_status);
            const isOpenInteraction =
              ev.event_kind === "interaction_needed" && ev.attention_state === "open";
            const summaryText = ev.summary || ev.title || "";
            const lineCount = summaryText ? summaryText.split("\n").length : 0;
            const isLongSummary =
              summaryText.length > LONG_OUTPUT_CHARS || lineCount > LONG_OUTPUT_LINES;
            const bodyExpanded = Boolean(expandedBodies[ev.id]);
            const dSummary = ev.deliveries_summary;

            return (
              <article
                key={ev.id}
                data-testid={`native-event-row-${ev.id}`}
                data-event-kind={ev.event_kind}
                data-attention-state={ev.attention_state ?? ""}
                onClick={() => onSelectEvent(ev.id)}
                className={cn(
                  "py-3 pr-4 transition-colors duration-150 cursor-pointer",
                  isOpenInteraction
                    ? "border-l-2 border-l-[var(--status-approval)] bg-[var(--status-approval)]/8 pl-3.5"
                    : isSelected
                      ? "border-l-2 border-l-[var(--status-running)] bg-surface-elevated/80 pl-3.5"
                      : "pl-4 hover:bg-surface-elevated/40"
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <Badge variant={kindMeta.variant}>{kindMeta.label}</Badge>
                    {attMeta ? <Badge variant={attMeta.variant}>{attMeta.label}</Badge> : null}
                    <span className="truncate font-mono text-xs font-medium text-foreground">
                      {ev.title || ev.id}
                    </span>
                    <span className="hidden sm:inline font-mono text-[10px] text-muted-foreground">
                      {ev.id}
                    </span>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground tabular-nums">
                    <button
                      type="button"
                      data-testid={`open-native-deliveries-${ev.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectEvent(ev.id);
                        onOpenDeliveries(ev.id);
                      }}
                      className="inline-flex items-center gap-1 rounded-[5px] border border-border bg-card px-1.5 py-0.5 text-[10px] font-sans text-foreground hover:bg-accent cursor-pointer tabular-nums"
                    >
                      <Bell className="h-2.5 w-2.5" strokeWidth={1.75} aria-hidden="true" />
                      <span>{notifyMeta.label}</span>
                      {dSummary && dSummary.total > 0 ? (
                        <span className="font-mono text-muted-foreground">
                          {dSummary.sent}/{dSummary.total}
                        </span>
                      ) : null}
                    </button>
                    <span>{formatShortTime(ev.created_at)}</span>
                  </div>
                </div>

                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span className="font-mono truncate">
                    {ev.node_id} · {ev.agent} · {ev.source || "hook"}
                    {ev.ack_at ? ` · 确认于 ${formatShortTime(ev.ack_at)}` : ""}
                  </span>
                  <div
                    className="flex shrink-0 items-center gap-1.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {isOpenInteraction ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid={`ack-native-event-${ev.id}`}
                        disabled={Boolean(acknowledgingIds[ev.id])}
                        onClick={() => onAckEvent(ev.id, "single")}
                        className="h-7 border-[var(--status-approval)]/60 px-2.5 text-[11px] text-[var(--status-approval)] hover:bg-[var(--status-approval)]/15"
                      >
                        <CheckCircle2 className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                        {acknowledgingIds[ev.id] ? "确认中..." : "标记已处理"}
                      </Button>
                    ) : null}
                    {ev.summary ? <CopyButton text={ev.summary} label="复制摘要" copiedLabel="已复制" /> : null}
                  </div>
                </div>

                {ev.notify_error ? (
                  <div className="mt-2 border-l-2 border-[var(--status-failed)] pl-2.5 font-mono text-[11px] text-[var(--status-failed)]">
                    通知异常：{ev.notify_error}
                  </div>
                ) : null}

                {ev.summary ? (
                  <div className="mt-2.5">
                    <div
                      className={cn(
                        "ahub-markdown relative",
                        isLongSummary && !bodyExpanded && "max-h-[30rem] overflow-hidden"
                      )}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{ev.summary}</ReactMarkdown>
                      {isLongSummary && !bodyExpanded ? (
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-background to-transparent"
                        />
                      ) : null}
                    </div>
                    {isLongSummary ? (
                      <div className="mt-2 flex items-center">
                        <button
                          type="button"
                          data-testid={`toggle-native-summary-${ev.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedBodies((prev) => ({ ...prev, [ev.id]: !bodyExpanded }));
                          }}
                          className="inline-flex items-center gap-1 rounded-[5px] border border-border bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-foreground tabular-nums transition-colors duration-150 hover:bg-accent cursor-pointer"
                        >
                          {bodyExpanded ? (
                            <>
                              <ChevronUp className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                              收起长摘要
                            </>
                          ) : (
                            <>
                              <ChevronDown className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                              展开全文（{formatBytes(ev.summary.length)} · {lineCount} 行）
                            </>
                          )}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>

      {/* Honest Physical Boundary Footer (Read-Only, NO Pseudo-Terminal Input) */}
      <footer className="shrink-0 border-t border-border bg-surface-elevated px-4 py-2.5 text-xs text-muted-foreground">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-pretty">
              原生会话运行在节点本机终端中，不支持从云端向交互式 TTY 注入指令或强杀进程。
            </p>
            {resumeInfo ? (
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <Terminal className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                <code
                  data-testid="native-resume-cmd-preview"
                  className="truncate rounded-[4px] border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground"
                >
                  {resumeInfo.command}
                </code>
                {!resumeInfo.supportsSessionFlag && anchorEvent?.agent === "grok" ? (
                  <span className="text-[10px] text-muted-foreground">
                    （grok 无原生会话恢复参数，仅进入工作目录）
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </footer>
    </section>
  );
}
