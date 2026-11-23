import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  HelpCircle,
  Inbox,
  Send,
  ShieldAlert,
  Terminal
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  isNonListInteractiveControl,
  shouldIgnoreActivationShortcut,
  shouldIgnoreGlobalShortcut
} from "@/lib/keyboard";
import { cn, formatShortDateTime, formatShortTime } from "@/lib/utils";
import type { AuthScope } from "@/stores/workbench-store";
import type {
  AnswerBoardQuestionPayload,
  BoardMessage,
  BoardTopic,
  NativeEventView,
  RunRecord
} from "@/types";
import { MARKDOWN_COMPONENTS } from "./markdown-components";
import { BoardTopicStatusBadge, RunStatusBadge } from "./StatusBadge";

export type InboxDomainFilter = "all" | "board" | "runs" | "native";

const INBOX_ITEM_SELECTOR = '[data-testid^="inbox-item-"]';

function getDomFocusedInboxKey(node: EventTarget | null): string | null {
  if (!(node instanceof Element)) return null;
  const itemEl = node.closest(INBOX_ITEM_SELECTOR);
  if (!itemEl) return null;
  const explicit = itemEl.getAttribute("data-inbox-key");
  if (explicit) return explicit;
  const testId = itemEl.getAttribute("data-testid") ?? "";
  return testId.startsWith("inbox-item-") ? testId.slice("inbox-item-".length) || null : null;
}

function findInboxItemElement(key: string): HTMLElement | null {
  const el = document.querySelector(`[data-testid="inbox-item-${key}"]`);
  return el instanceof HTMLElement ? el : null;
}

export type UnifiedInboxItem =
  | {
      key: string;
      domain: "board";
      createdAt: string;
      topic: BoardTopic | null;
      message: BoardMessage;
    }
  | {
      key: string;
      domain: "runs";
      createdAt: string;
      run: RunRecord;
    }
  | {
      key: string;
      domain: "native";
      createdAt: string;
      event: NativeEventView;
    };

export interface PendingInboxProps {
  topics: BoardTopic[];
  messagesByTopicId: Record<string, BoardMessage[]>;
  runs: RunRecord[];
  nativeEvents: NativeEventView[];
  authScope: AuthScope | null;
  selectedItemKey: string | null;
  isDesktop: boolean;
  answeringIds: Record<string, boolean>;
  acknowledgingIds: Record<string, boolean>;
  onSelectItemKey: (key: string | null) => void;
  onAnswerBoardQuestion: (
    messageId: string,
    payload: AnswerBoardQuestionPayload
  ) => Promise<boolean>;
  onResolveRun: (runId: string) => Promise<void>;
  onAckNativeEvent: (eventId: string, scope: "single" | "session") => Promise<void>;
  onOpenBoardTopic: (topicId: string) => void;
  onOpenRunInWorkbench: (run: RunRecord) => void;
  onOpenNativeInWorkbench: (event: NativeEventView) => void;
}

export function PendingInbox({
  topics,
  messagesByTopicId,
  runs,
  nativeEvents,
  authScope,
  selectedItemKey,
  isDesktop,
  answeringIds,
  acknowledgingIds,
  onSelectItemKey,
  onAnswerBoardQuestion,
  onResolveRun,
  onAckNativeEvent,
  onOpenBoardTopic,
  onOpenRunInWorkbench,
  onOpenNativeInWorkbench
}: PendingInboxProps) {
  const isAdmin = authScope === "admin";
  const [domainFilter, setDomainFilter] = useState<InboxDomainFilter>("all");
  const [answerDraftByMsgId, setAnswerDraftByMsgId] = useState<Record<string, string>>({});
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const [stagedOptionIdx, setStagedOptionIdx] = useState<number | null>(null);
  const [mobileFocusedKey, setMobileFocusedKey] = useState<string | null>(null);
  const [desktopDetailDismissed, setDesktopDetailDismissed] = useState(false);
  const seenSelectedKeyRef = useRef<string | null>(null);

  const topicById = useMemo(() => new Map(topics.map((t) => [t.id, t])), [topics]);

  const items = useMemo<UnifiedInboxItem[]>(() => {
    const out: UnifiedInboxItem[] = [];

    for (const [topicId, list] of Object.entries(messagesByTopicId)) {
      const topic = topicById.get(topicId) ?? null;
      if (topic && (topic.open_question_count ?? 0) <= 0) continue;
      for (const msg of list) {
        if (msg.kind === "question" && msg.question_state === "open") {
          out.push({
            key: `board:${msg.id}`,
            domain: "board",
            createdAt: msg.created_at,
            topic,
            message: msg
          });
        }
      }
    }

    for (const run of runs) {
      if (run.status === "needs_approval") {
        out.push({
          key: `run:${run.id}`,
          domain: "runs",
          createdAt: run.updated_at || run.created_at,
          run
        });
      }
    }

    if (isAdmin) {
      for (const ev of nativeEvents) {
        if (ev.event_kind === "interaction_needed" && ev.attention_state === "open") {
          out.push({
            key: `native:${ev.id}`,
            domain: "native",
            createdAt: ev.created_at,
            event: ev
          });
        }
      }
    }

    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.key.localeCompare(b.key));
  }, [isAdmin, messagesByTopicId, nativeEvents, runs, topicById]);

  const counts = useMemo(() => {
    let board = 0;
    let runsCount = 0;
    let native = 0;
    for (const item of items) {
      if (item.domain === "board") board += 1;
      else if (item.domain === "runs") runsCount += 1;
      else native += 1;
    }
    return { total: items.length, board, runs: runsCount, native };
  }, [items]);

  const filteredItems = useMemo(() => {
    if (domainFilter === "all") return items;
    return items.filter((item) => item.domain === domainFilter);
  }, [domainFilter, items]);

  const selectedItem = useMemo(() => {
    if (selectedItemKey) {
      const exact = filteredItems.find((i) => i.key === selectedItemKey);
      if (exact) return exact;
    }
    if (isDesktop && !desktopDetailDismissed) {
      return filteredItems[0] ?? null;
    }
    return null;
  }, [desktopDetailDismissed, filteredItems, isDesktop, selectedItemKey]);

  useEffect(() => {
    setStagedOptionIdx(null);
  }, [domainFilter, selectedItem?.key]);

  useEffect(() => {
    if (mobileFocusedKey && !filteredItems.some((i) => i.key === mobileFocusedKey)) {
      setMobileFocusedKey(null);
    }
  }, [filteredItems, mobileFocusedKey]);

  useEffect(() => {
    if (!isAdmin && domainFilter === "native") {
      setDomainFilter("all");
    }
  }, [domainFilter, isAdmin]);

  useEffect(() => {
    if (!selectedItemKey) {
      seenSelectedKeyRef.current = null;
      if (mobileShowDetail) {
        setMobileShowDetail(false);
      }
      return;
    }

    const exists = filteredItems.some((i) => i.key === selectedItemKey);
    if (exists) {
      seenSelectedKeyRef.current = selectedItemKey;
      if (!isDesktop) {
        setMobileShowDetail(true);
      }
      return;
    }

    if (seenSelectedKeyRef.current === selectedItemKey) {
      seenSelectedKeyRef.current = null;
      if (mobileShowDetail) {
        setMobileShowDetail(false);
      }
      onSelectItemKey(null);
      return;
    }

    seenSelectedKeyRef.current = null;
    if (!selectedItem && mobileShowDetail) {
      setMobileShowDetail(false);
    }
  }, [filteredItems, isDesktop, mobileShowDetail, onSelectItemKey, selectedItem, selectedItemKey]);

  async function handleAnswer(messageId: string, selectedOption?: string) {
    if (!isAdmin) return;
    const text = (answerDraftByMsgId[messageId] ?? "").trim();
    if (!selectedOption && !text) return;
    const ok = await onAnswerBoardQuestion(messageId, {
      ...(selectedOption ? { selected_option: selectedOption } : {}),
      ...(text ? { answer_text: text } : {})
    });
    if (ok) {
      setStagedOptionIdx(null);
      setAnswerDraftByMsgId((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (shouldIgnoreGlobalShortcut(event) || shouldIgnoreActivationShortcut(event)) {
        return;
      }

      const key = event.key;
      const lower = key.toLowerCase();
      const domFocusedKey =
        getDomFocusedInboxKey(event.target) ?? getDomFocusedInboxKey(document.activeElement);

      if (lower === "j" || lower === "k") {
        event.preventDefault();
        if (filteredItems.length === 0) return;

        const currentKey =
          domFocusedKey ??
          (isDesktop ? selectedItem?.key ?? null : mobileFocusedKey ?? selectedItem?.key ?? null);
        let nextIdx = 0;
        if (currentKey === null) {
          nextIdx = lower === "k" ? filteredItems.length - 1 : 0;
        } else {
          const curIdx = filteredItems.findIndex((i) => i.key === currentKey);
          if (curIdx < 0) {
            nextIdx = 0;
          } else if (lower === "j") {
            nextIdx = Math.min(filteredItems.length - 1, curIdx + 1);
          } else {
            nextIdx = Math.max(0, curIdx - 1);
          }
        }

        const nextItem = filteredItems[nextIdx];
        if (!nextItem) return;
        setStagedOptionIdx(null);

        if (isDesktop) {
          setDesktopDetailDismissed(false);
          onSelectItemKey(nextItem.key);
        } else {
          setMobileFocusedKey(nextItem.key);
          if (mobileShowDetail) {
            onSelectItemKey(nextItem.key);
          }
        }

        const el = findInboxItemElement(nextItem.key);
        const activeEl = document.activeElement;
        if (
          activeEl instanceof HTMLElement &&
          activeEl !== el &&
          (isNonListInteractiveControl(activeEl) || Boolean(activeEl.closest(INBOX_ITEM_SELECTOR)))
        ) {
          activeEl.blur();
        }
        if (el) {
          el.scrollIntoView({ block: "nearest" });
          el.focus({ preventScroll: true });
        } else {
          requestAnimationFrame(() => {
            const deferredEl = findInboxItemElement(nextItem.key);
            if (deferredEl) {
              deferredEl.scrollIntoView({ block: "nearest" });
              deferredEl.focus({ preventScroll: true });
            }
          });
        }
        return;
      }

      if (key === "1" || key === "2" || key === "3" || key === "4") {
        if (!selectedItem || selectedItem.domain !== "board" || !isAdmin) {
          return;
        }
        const optionIdx = Number(key) - 1;
        if (optionIdx < selectedItem.message.question_options.length) {
          event.preventDefault();
          setStagedOptionIdx(optionIdx);
        }
        return;
      }

      if (key === "Enter") {
        event.preventDefault();
        if (!isDesktop && !mobileShowDetail) {
          const targetKey = domFocusedKey ?? mobileFocusedKey ?? filteredItems[0]?.key ?? null;
          if (targetKey) {
            setMobileFocusedKey(targetKey);
            onSelectItemKey(targetKey);
            setMobileShowDetail(true);
          }
          return;
        }
        if (!selectedItem) {
          const targetKey = domFocusedKey ?? filteredItems[0]?.key ?? null;
          if (targetKey) {
            setDesktopDetailDismissed(false);
            setMobileFocusedKey(targetKey);
            onSelectItemKey(targetKey);
          }
          return;
        }
        if (domFocusedKey && domFocusedKey !== selectedItem.key) {
          setDesktopDetailDismissed(false);
          setMobileFocusedKey(domFocusedKey);
          onSelectItemKey(domFocusedKey);
          return;
        }
        if (selectedItem.domain === "board") {
          if (!isAdmin) return;
          if (stagedOptionIdx !== null) {
            const opt = selectedItem.message.question_options[stagedOptionIdx];
            if (opt) {
              void handleAnswer(selectedItem.message.id, opt);
            }
          } else if ((answerDraftByMsgId[selectedItem.message.id] ?? "").trim()) {
            void handleAnswer(selectedItem.message.id);
          }
          return;
        }
        if (selectedItem.domain === "runs") {
          void onResolveRun(selectedItem.run.id);
          return;
        }
        if (selectedItem.domain === "native") {
          void onAckNativeEvent(selectedItem.event.id, "single");
        }
        return;
      }

      if (key === "Escape") {
        event.preventDefault();
        if (stagedOptionIdx !== null) {
          setStagedOptionIdx(null);
          return;
        }
        if (!isDesktop && mobileShowDetail) {
          setMobileShowDetail(false);
          onSelectItemKey(null);
          return;
        }
        if (isDesktop && selectedItem !== null) {
          setDesktopDetailDismissed(true);
          onSelectItemKey(null);
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    answerDraftByMsgId,
    filteredItems,
    isAdmin,
    isDesktop,
    mobileFocusedKey,
    mobileShowDetail,
    onAckNativeEvent,
    onResolveRun,
    onSelectItemKey,
    selectedItem,
    stagedOptionIdx
  ]);

  const listPane = (
    <div
      data-testid="inbox-list-pane"
      className={cn(
        "flex min-h-0 flex-col bg-surface-elevated overflow-hidden",
        isDesktop ? "w-[340px] shrink-0 border-r border-border" : "flex-1"
      )}
    >
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Inbox className="h-3.5 w-3.5 text-[var(--status-approval)]" strokeWidth={1.75} aria-hidden="true" />
            <span className="text-xs font-semibold text-foreground">统一待决收件箱</span>
          </div>
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
            共 {counts.total} 项
          </span>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            type="button"
            data-testid="inbox-filter-all"
            aria-pressed={domainFilter === "all"}
            onClick={() => {
              setDesktopDetailDismissed(false);
              setDomainFilter("all");
            }}
            className={cn(
              "shrink-0 min-h-11 md:min-h-0 md:h-7 rounded-[4px] border px-2.5 md:px-2 text-xs md:text-[11px] tabular-nums transition-colors cursor-pointer",
              domainFilter === "all"
                ? "border-[var(--status-running)]/50 bg-[var(--status-running)]/12 text-foreground font-medium"
                : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
            )}
          >
            全部 {counts.total}
          </button>
          <button
            type="button"
            data-testid="inbox-filter-board"
            aria-pressed={domainFilter === "board"}
            onClick={() => {
              setDesktopDetailDismissed(false);
              setDomainFilter("board");
            }}
            className={cn(
              "shrink-0 min-h-11 md:min-h-0 md:h-7 rounded-[4px] border px-2.5 md:px-2 text-xs md:text-[11px] tabular-nums transition-colors cursor-pointer",
              domainFilter === "board"
                ? "border-[var(--status-approval)]/60 bg-[var(--status-approval)]/15 text-foreground font-medium"
                : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
            )}
          >
            协同提问 {counts.board}
          </button>
          <button
            type="button"
            data-testid="inbox-filter-runs"
            aria-pressed={domainFilter === "runs"}
            onClick={() => {
              setDesktopDetailDismissed(false);
              setDomainFilter("runs");
            }}
            className={cn(
              "shrink-0 min-h-11 md:min-h-0 md:h-7 rounded-[4px] border px-2.5 md:px-2 text-xs md:text-[11px] tabular-nums transition-colors cursor-pointer",
              domainFilter === "runs"
                ? "border-[var(--status-approval)]/60 bg-[var(--status-approval)]/15 text-foreground font-medium"
                : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
            )}
          >
            受控审批 {counts.runs}
          </button>
          {isAdmin ? (
            <button
              type="button"
              data-testid="inbox-filter-native"
              aria-pressed={domainFilter === "native"}
              onClick={() => {
                setDesktopDetailDismissed(false);
                setDomainFilter("native");
              }}
              className={cn(
                "shrink-0 min-h-11 md:min-h-0 md:h-7 rounded-[4px] border px-2.5 md:px-2 text-xs md:text-[11px] tabular-nums transition-colors cursor-pointer",
                domainFilter === "native"
                  ? "border-[var(--status-approval)]/60 bg-[var(--status-approval)]/15 text-foreground font-medium"
                  : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
              )}
            >
              原生互动 {counts.native}
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-border">
        {filteredItems.length === 0 ? (
          <div
            data-testid="inbox-empty-state"
            className="p-6 text-center text-xs text-muted-foreground text-pretty"
          >
            当前没有待确认或待审批的阻塞事项。
          </div>
        ) : (
          filteredItems.map((item) => {
            const active = selectedItem?.key === item.key;
            const focused = isDesktop ? active : mobileFocusedKey === item.key || active;
            const handleItemClick = () => {
              setDesktopDetailDismissed(false);
              setMobileFocusedKey(item.key);
              onSelectItemKey(item.key);
              if (!isDesktop) setMobileShowDetail(true);
            };
            if (item.domain === "board") {
              const title = item.topic?.title || item.message.channel;
              const actor = `${item.message.actor_profile || item.message.actor_scope}${item.message.source_node ? `@${item.message.source_node}` : ""}`;
              return (
                <button
                  key={item.key}
                  type="button"
                  data-testid={`inbox-item-${item.key}`}
                  data-focused={focused ? "true" : "false"}
                  onClick={handleItemClick}
                  className={cn(
                    "flex w-full min-h-11 flex-col gap-1.5 border-l-2 border-l-[var(--status-approval)] px-3 py-2.5 text-left transition-colors cursor-pointer",
                    active ? "bg-accent/70" : focused ? "bg-accent/50" : "hover:bg-accent/40"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="approval">协同提问</Badge>
                    <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                      {formatShortTime(item.createdAt)}
                    </span>
                  </div>
                  <div className="truncate text-xs font-medium text-foreground">{title}</div>
                  <div className="line-clamp-2 text-[11px] text-muted-foreground">
                    {item.message.text_md}
                  </div>
                  <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground">
                    <span className="truncate">{item.message.channel}</span>
                    <span className="shrink-0">{actor}</span>
                  </div>
                </button>
              );
            }

            if (item.domain === "runs") {
              return (
                <button
                  key={item.key}
                  type="button"
                  data-testid={`inbox-item-${item.key}`}
                  data-focused={focused ? "true" : "false"}
                  onClick={handleItemClick}
                  className={cn(
                    "flex w-full min-h-11 flex-col gap-1.5 border-l-2 border-l-[var(--status-approval)] px-3 py-2.5 text-left transition-colors cursor-pointer",
                    active ? "bg-accent/70" : focused ? "bg-accent/50" : "hover:bg-accent/40"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="approval">受控审批</Badge>
                    <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                      {formatShortTime(item.createdAt)}
                    </span>
                  </div>
                  <div className="truncate font-mono text-xs font-medium text-foreground">
                    {item.run.node_id} · {item.run.agent} · {item.run.id}
                  </div>
                  <div className="line-clamp-2 text-[11px] text-muted-foreground">
                    {item.run.summary || item.run.prompt || item.run.workdir}
                  </div>
                </button>
              );
            }

            return (
              <button
                key={item.key}
                type="button"
                data-testid={`inbox-item-${item.key}`}
                data-focused={focused ? "true" : "false"}
                onClick={handleItemClick}
                className={cn(
                  "flex w-full min-h-11 flex-col gap-1.5 border-l-2 border-l-[var(--status-approval)] px-3 py-2.5 text-left transition-colors cursor-pointer",
                  active ? "bg-accent/70" : focused ? "bg-accent/50" : "hover:bg-accent/40"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="approval">原生互动</Badge>
                  <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                    {formatShortTime(item.createdAt)}
                  </span>
                </div>
                <div className="truncate text-xs font-medium text-foreground">
                  {item.event.title || `${item.event.node_id} · ${item.event.agent}`}
                </div>
                <div className="line-clamp-2 text-[11px] text-muted-foreground">
                  {item.event.summary || item.event.workdir}
                </div>
                <div className="font-mono text-[10px] text-muted-foreground truncate">
                  {item.event.node_id} · {item.event.agent}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  const detailPane = (
    <div
      data-testid="inbox-detail-pane"
      className="relative flex min-h-0 flex-1 flex-col bg-background overflow-hidden"
    >
      {!selectedItem ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
          <CheckCircle2 className="h-6 w-6 text-[var(--status-done)]" strokeWidth={1.75} aria-hidden="true" />
          <p>
            {filteredItems.length > 0
              ? "按 J/K 切换条目，按 Enter 展开详情。"
              : "当前没有待确认或待审批的阻塞事项。"}
          </p>
        </div>
      ) : selectedItem.domain === "board" ? (
        (() => {
          const { message, topic } = selectedItem;
          const busy = Boolean(answeringIds[message.id]);
          const draft = answerDraftByMsgId[message.id] ?? "";
          return (
            <>
              <div className="flex min-h-11 md:min-h-0 md:h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-card/60 px-3 py-1.5 md:py-0">
                <div className="flex min-w-0 items-center gap-2">
                  {!isDesktop ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setMobileShowDetail(false);
                        onSelectItemKey(null);
                      }}
                      data-testid="inbox-mobile-back-btn"
                      className="min-h-11 px-2 -ml-1 shrink-0"
                    >
                      <ArrowLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                      收件箱
                    </Button>
                  ) : null}
                  <HelpCircle className="h-4 w-4 shrink-0 text-[var(--status-approval)]" strokeWidth={1.75} aria-hidden="true" />
                  <span className="truncate text-xs font-semibold text-foreground">
                    {topic?.title || message.channel}
                  </span>
                  {topic ? <BoardTopicStatusBadge status={topic.status} /> : null}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onOpenBoardTopic(message.topic_id)}
                  data-testid="inbox-open-topic-btn"
                  className="min-h-11 md:min-h-0 md:h-7 shrink-0"
                >
                  查看所属主题
                </Button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground tabular-nums">
                  <Badge variant="outline">{message.channel}</Badge>
                  <span>
                    提问方：{message.actor_profile || message.actor_scope}
                    {message.source_node ? `@${message.source_node}` : ""}
                  </span>
                  <span>#{message.seq}</span>
                  <span>{formatShortTime(message.created_at)}</span>
                  {message.question_expires_at ? (
                    <span title={message.question_expires_at}>
                      截止 {formatShortDateTime(message.question_expires_at)}
                    </span>
                  ) : null}
                </div>

                <div className="rounded-[6px] border border-border bg-card p-3 ahub-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                    {message.text_md}
                  </ReactMarkdown>
                </div>

                {topic?.latest_handoff ? (
                  <div className="rounded-[6px] border border-border bg-surface-elevated p-3 space-y-1.5">
                    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">主题最近交接上下文</span>
                      <span className="font-mono tabular-nums">
                        {topic.latest_handoff.actor_profile || "agent"}
                        {topic.latest_handoff.source_node
                          ? `@${topic.latest_handoff.source_node}`
                          : ""}
                      </span>
                    </div>
                    <div className="ahub-markdown text-muted-foreground">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                        {topic.latest_handoff.text_md}
                      </ReactMarkdown>
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Sticky bottom Q&A action bar */}
              <div
                data-testid="inbox-action-bar"
                className="sticky bottom-0 z-10 shrink-0 overflow-x-hidden border-t border-border bg-card px-3 pt-2.5 pb-[max(0.75rem,var(--safe-bottom))] pl-[max(0.75rem,var(--safe-left))] pr-[max(0.75rem,var(--safe-right))] space-y-2"
              >
                {isAdmin ? (
                  <>
                    {message.question_options.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {message.question_options.map((opt, idx) => {
                          const isStaged = stagedOptionIdx === idx;
                          return (
                            <Button
                              key={`${message.id}-inbox-opt-${idx}`}
                              type="button"
                              variant="outline"
                              disabled={busy}
                              aria-pressed={isStaged}
                              data-selected={isStaged ? "true" : "false"}
                              data-testid={`inbox-question-option-${idx}`}
                              onClick={() => void handleAnswer(message.id, opt)}
                              className={cn(
                                "min-h-11 min-w-11 md:min-h-0 md:min-w-0 md:h-8 bg-background hover:bg-accent",
                                isStaged
                                  ? "border-[var(--status-running)] bg-[var(--status-running)]/15 text-foreground ring-1 ring-[var(--status-running)]"
                                  : "border-[var(--status-approval)]/50"
                              )}
                            >
                              {opt}
                            </Button>
                          );
                        })}
                      </div>
                    ) : null}
                    <div className="flex items-center gap-2">
                      <Input
                        value={draft}
                        onChange={(e) =>
                          setAnswerDraftByMsgId((prev) => ({
                            ...prev,
                            [message.id]: e.target.value
                          }))
                        }
                        placeholder="输入管理员答复并立即唤醒等待会话..."
                        aria-label="管理员答复内容"
                        disabled={busy}
                        data-testid="inbox-answer-input"
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                            e.preventDefault();
                            void handleAnswer(message.id);
                          }
                        }}
                      />
                      <Button
                        type="button"
                        disabled={busy || !draft.trim()}
                        onClick={() => void handleAnswer(message.id)}
                        data-testid="inbox-answer-submit-btn"
                        className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 md:h-8 shrink-0 px-3"
                      >
                        <Send className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                        {busy ? "提交中…" : "提交答复"}
                      </Button>
                    </div>
                  </>
                ) : (
                  <div
                    data-testid="inbox-client-readonly-banner"
                    className="rounded-[5px] border border-border bg-background/70 px-3 py-2 text-xs text-muted-foreground"
                  >
                    仅管理员可答复协同板阻塞提问。请使用管理员账号登录后在收件箱或当前主题作答。
                  </div>
                )}
              </div>
            </>
          );
        })()
      ) : selectedItem.domain === "runs" ? (
        (() => {
          const { run } = selectedItem;
          return (
            <>
              <div className="flex min-h-11 md:min-h-0 md:h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-card/60 px-3 py-1.5 md:py-0">
                <div className="flex min-w-0 items-center gap-2">
                  {!isDesktop ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setMobileShowDetail(false);
                        onSelectItemKey(null);
                      }}
                      data-testid="inbox-mobile-back-btn"
                      className="min-h-11 px-2 -ml-1 shrink-0"
                    >
                      <ArrowLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                      收件箱
                    </Button>
                  ) : null}
                  <ShieldAlert className="h-4 w-4 shrink-0 text-[var(--status-approval)]" strokeWidth={1.75} aria-hidden="true" />
                  <span className="truncate font-mono text-xs font-semibold text-foreground">
                    {run.id}
                  </span>
                  <RunStatusBadge status={run.status} />
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onOpenRunInWorkbench(run)}
                  data-testid="inbox-open-run-btn"
                  className="min-h-11 md:min-h-0 md:h-7 shrink-0"
                >
                  在执行台查看
                </Button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3 text-xs">
                <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground tabular-nums">
                  <span>节点：{run.node_id}</span>
                  <span>Agent：{run.agent}</span>
                  <span>目录：{run.workdir}</span>
                </div>
                {run.prompt ? (
                  <div className="rounded-[6px] border border-border bg-card p-3 space-y-1">
                    <div className="text-[11px] font-medium text-muted-foreground">下发指令</div>
                    <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] text-foreground">
                      {run.prompt}
                    </pre>
                  </div>
                ) : null}
                {run.summary ? (
                  <div className="rounded-[6px] border border-border bg-card p-3 ahub-markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                      {run.summary}
                    </ReactMarkdown>
                  </div>
                ) : null}
              </div>

              <div
                data-testid="inbox-action-bar"
                className="sticky bottom-0 z-10 flex shrink-0 flex-wrap items-center justify-end gap-2 overflow-x-hidden border-t border-border bg-card px-3 pt-2.5 pb-[max(0.75rem,var(--safe-bottom))] pl-[max(0.75rem,var(--safe-left))] pr-[max(0.75rem,var(--safe-right))]"
              >
                {run.remote_control_url && /^https?:\/\//i.test(run.remote_control_url) ? (
                  <Button asChild variant="outline" className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 md:h-8">
                    <a href={run.remote_control_url} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      打开远控审批
                    </a>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  onClick={() => void onResolveRun(run.id)}
                  data-testid="inbox-resolve-run-btn"
                  className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 md:h-8"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  标记已放行
                </Button>
              </div>
            </>
          );
        })()
      ) : (
        (() => {
          const { event } = selectedItem;
          const busy = Boolean(acknowledgingIds[event.id]);
          return (
            <>
              <div className="flex min-h-11 md:min-h-0 md:h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-card/60 px-3 py-1.5 md:py-0">
                <div className="flex min-w-0 items-center gap-2">
                  {!isDesktop ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setMobileShowDetail(false);
                        onSelectItemKey(null);
                      }}
                      data-testid="inbox-mobile-back-btn"
                      className="min-h-11 px-2 -ml-1 shrink-0"
                    >
                      <ArrowLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                      收件箱
                    </Button>
                  ) : null}
                  <Terminal className="h-4 w-4 shrink-0 text-[var(--status-approval)]" strokeWidth={1.75} aria-hidden="true" />
                  <span className="truncate text-xs font-semibold text-foreground">
                    {event.title || `${event.node_id} · ${event.agent}`}
                  </span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onOpenNativeInWorkbench(event)}
                  data-testid="inbox-open-native-btn"
                  className="min-h-11 md:min-h-0 md:h-7 shrink-0"
                >
                  查看原生会话
                </Button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3 text-xs">
                <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground tabular-nums">
                  <span>节点：{event.node_id}</span>
                  <span>Agent：{event.agent}</span>
                  <span>目录：{event.workdir}</span>
                  <span>{formatShortTime(event.created_at)}</span>
                </div>
                <div className="rounded-[6px] border border-border bg-card p-3 ahub-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                    {event.summary || "需要本机终端人工确认。"}
                  </ReactMarkdown>
                </div>
              </div>

              <div
                data-testid="inbox-action-bar"
                className="sticky bottom-0 z-10 flex shrink-0 items-center justify-end gap-2 overflow-x-hidden border-t border-border bg-card px-3 pt-2.5 pb-[max(0.75rem,var(--safe-bottom))] pl-[max(0.75rem,var(--safe-left))] pr-[max(0.75rem,var(--safe-right))]"
              >
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void onAckNativeEvent(event.id, "single")}
                  data-testid="inbox-ack-native-btn"
                  className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 md:h-8"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  {busy ? "确认中…" : "标记已处理"}
                </Button>
              </div>
            </>
          );
        })()
      )}
    </div>
  );

  return (
    <section
      aria-label="统一待决收件箱"
      data-testid="pending-inbox"
      onFocusCapture={(event) => {
        const key = getDomFocusedInboxKey(event.target);
        if (key && !isDesktop && key !== mobileFocusedKey) {
          setMobileFocusedKey(key);
        }
      }}
      className="relative flex h-full w-full overflow-hidden bg-background tabular-nums"
    >
      {isDesktop ? (
        <>
          {listPane}
          {detailPane}
        </>
      ) : mobileShowDetail && selectedItem ? (
        detailPane
      ) : (
        listPane
      )}
    </section>
  );
}
