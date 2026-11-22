import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  PanelRight,
  Pin,
  Plus,
  Search,
  Send,
  X
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatShortTime } from "@/lib/utils";
import type { BoardTopicFilter } from "@/stores/board-store";
import type { AuthScope } from "@/stores/workbench-store";
import type {
  AnswerBoardQuestionPayload,
  BoardMessage,
  BoardMessageKind,
  BoardTopic,
  BoardTopicStatus,
  CreateBoardMessagePayload
} from "@/types";
import { MARKDOWN_COMPONENTS } from "./markdown-components";
import { BoardTopicStatusBadge } from "./StatusBadge";

export interface BoardTopicTimelineProps {
  topics: BoardTopic[];
  selectedChannel: string | null;
  selectedTopic: BoardTopic | null;
  messages: BoardMessage[];
  messagesLoading: boolean;
  topicFilter: BoardTopicFilter;
  searchQuery: string;
  authScope: AuthScope | null;
  boardPermissionDenied: boolean;
  isDesktop: boolean;
  mobileShowDetail: boolean;
  inspectorCollapsed: boolean;
  submittingMessage: boolean;
  answeringIds: Record<string, boolean>;
  onSearchQueryChange: (q: string) => void;
  onSelectTopic: (topicId: string) => void;
  onMobileBackToList: () => void;
  onToggleInspector: () => void;
  onOpenNewTopic: () => void;
  onPostMessage: (topicId: string, payload: CreateBoardMessagePayload) => Promise<boolean>;
  onAnswerQuestion: (messageId: string, payload: AnswerBoardQuestionPayload) => Promise<boolean>;
}

const MESSAGE_KIND_META: Record<
  BoardMessageKind,
  { label: string; variant: "outline" | "running" | "approval" | "done" | "secondary" }
> = {
  note: { label: "备注", variant: "outline" },
  handoff: { label: "交接", variant: "running" },
  question: { label: "提问", variant: "approval" },
  answer: { label: "答复", variant: "done" },
  artifact: { label: "产物", variant: "secondary" }
};

const QUESTION_STATE_LABEL: Record<string, string> = {
  open: "待答复",
  answered: "已答复",
  expired: "已过期",
  cancelled: "已取消"
};

function renderStructuredDataPreview(msg: BoardMessage) {
  const entries = Object.entries(msg.data ?? {}).filter(([, val]) => {
    if (val === null || val === undefined) return false;
    if (typeof val === "string") return val.trim().length > 0;
    if (Array.isArray(val)) return val.length > 0;
    return true;
  });
  if (entries.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[10px] text-muted-foreground">
      {entries.slice(0, 6).map(([key, val]) => {
        const display =
          typeof val === "string"
            ? val
            : Array.isArray(val)
              ? `${val.length} 项`
              : JSON.stringify(val);
        return (
          <span
            key={key}
            className="max-w-full truncate rounded-[4px] border border-border bg-background/70 px-1.5 py-0.5"
          >
            {key}: {display}
          </span>
        );
      })}
    </div>
  );
}

export function BoardTopicTimeline({
  topics,
  selectedChannel,
  selectedTopic,
  messages,
  messagesLoading,
  topicFilter,
  searchQuery,
  authScope,
  boardPermissionDenied,
  isDesktop,
  mobileShowDetail,
  inspectorCollapsed,
  submittingMessage,
  answeringIds,
  onSearchQueryChange,
  onSelectTopic,
  onMobileBackToList,
  onToggleInspector,
  onOpenNewTopic,
  onPostMessage,
  onAnswerQuestion
}: BoardTopicTimelineProps) {
  const [statusFilter, setStatusFilter] = useState<"all" | BoardTopicStatus>("all");
  const [composerKind, setComposerKind] = useState<"note" | "handoff" | "question" | "artifact">("note");
  const [composerText, setComposerText] = useState("");
  const [composerProfile, setComposerProfile] = useState("");
  const [questionOptions, setQuestionOptions] = useState<string[]>(["", ""]);
  const [questionExpiresSec, setQuestionExpiresSec] = useState<number>(86400);
  const [answerTextByMsgId, setAnswerTextByMsgId] = useState<Record<string, string>>({});
  const [mobileComposerExpanded, setMobileComposerExpanded] = useState(false);

  const isAdmin = authScope === "admin";

  const filteredTopics = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return topics.filter((t) => {
      if (selectedChannel && t.channel !== selectedChannel) return false;
      if (topicFilter === "open_questions" && (t.open_question_count ?? 0) <= 0) return false;
      if (statusFilter === "all") {
        if (topicFilter === "active" && t.status === "archived") return false;
      } else if (t.status !== statusFilter) {
        return false;
      }
      if (q) {
        const hay = `${t.title}\n${t.channel}\n${t.external_ref}\n${t.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [searchQuery, selectedChannel, statusFilter, topicFilter, topics]);

  const openQuestions = useMemo(
    () => messages.filter((m) => m.kind === "question" && m.question_state === "open"),
    [messages]
  );

  const primaryOpenQuestion = openQuestions[0] ?? null;

  async function handleSubmitMessage() {
    if (!selectedTopic) return;
    const text = composerText.trim();
    if (!text) return;

    const cleanOptions =
      composerKind === "question"
        ? questionOptions.map((o) => o.trim()).filter(Boolean).slice(0, 8)
        : undefined;

    const payload: CreateBoardMessagePayload = {
      kind: composerKind,
      text_md: text,
      ...(composerProfile.trim() ? { actor_profile: composerProfile.trim() } : {}),
      ...(composerKind === "question"
        ? {
            ...(cleanOptions && cleanOptions.length > 0 ? { question_options: cleanOptions } : {}),
            question_expires_sec: questionExpiresSec
          }
        : {})
    };

    const ok = await onPostMessage(selectedTopic.id, payload);
    if (ok) {
      setComposerText("");
      if (composerKind === "question") {
        setQuestionOptions(["", ""]);
      }
      setMobileComposerExpanded(false);
    }
  }

  async function handleAnswerSubmit(question: BoardMessage, selectedOption?: string) {
    if (!isAdmin) return;
    const customText = (answerTextByMsgId[question.id] ?? "").trim();
    if (!selectedOption && !customText) return;

    const ok = await onAnswerQuestion(question.id, {
      ...(selectedOption ? { selected_option: selectedOption } : {}),
      ...(customText ? { answer_text: customText } : {})
    });
    if (ok) {
      setAnswerTextByMsgId((prev) => {
        const next = { ...prev };
        delete next[question.id];
        return next;
      });
    }
  }

  const showMobileList = !isDesktop && (!mobileShowDetail || !selectedTopic);
  const showMobileDetail = !isDesktop && mobileShowDetail && Boolean(selectedTopic);

  const topicListElement = (
    <div
      data-testid="board-topic-list"
      className={cn(
        "flex min-h-0 flex-col bg-background overflow-hidden",
        isDesktop ? "border-b xl:border-b-0 xl:border-r border-border max-h-[38%] xl:max-h-none xl:w-[270px] xl:shrink-0" : "flex-1"
      )}
    >
      <div className="shrink-0 space-y-2 border-b border-border p-2.5">
        <div className="flex items-center gap-1.5">
          <div className="relative flex min-w-0 flex-1 items-center">
            <Search
              className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <Input
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              placeholder="搜索主题、频道或 external_ref..."
              aria-label="搜索协同主题"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="search"
              data-testid="board-search-input"
              className="pl-8"
            />
          </div>
          {!isDesktop && !boardPermissionDenied ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onOpenNewTopic}
              className="min-h-11 shrink-0 px-3"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              新建
            </Button>
          ) : null}
        </div>

        <div className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {(
            [
              { key: "all", label: "全部" },
              { key: "in_progress", label: "进行中" },
              { key: "blocked", label: "阻塞" },
              { key: "todo", label: "待办" },
              { key: "done", label: "已完成" },
              { key: "archived", label: "归档" }
            ] as const
          ).map((pill) => (
            <button
              key={pill.key}
              type="button"
              onClick={() => setStatusFilter(pill.key)}
              className={cn(
                "shrink-0 min-h-11 md:min-h-0 md:h-6 rounded-[4px] border px-2.5 md:px-2 text-xs md:text-[11px] transition-colors cursor-pointer",
                statusFilter === pill.key
                  ? "border-[var(--status-running)]/50 bg-[var(--status-running)]/12 text-foreground font-medium"
                  : "border-border bg-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {pill.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-border">
        {boardPermissionDenied ? (
          <div className="p-4 text-center text-xs text-muted-foreground text-pretty">
            当前凭证尚未分配协同板频道前缀权限（`allowed_board_prefixes`）。请联系管理员在凭证管理中授权后再访问。
          </div>
        ) : filteredTopics.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground text-pretty">
            {topics.length === 0
              ? "暂无协同主题。点击新建主题或通过 `ahub board post` 发起跨机协作。"
              : "当前筛选条件下没有匹配的协同主题。"}
          </div>
        ) : (
          filteredTopics.map((topic) => {
            const active = selectedTopic?.id === topic.id;
            const openCount = topic.open_question_count ?? 0;
            return (
              <button
                key={topic.id}
                type="button"
                data-testid={`board-topic-item-${topic.id}`}
                onClick={() => onSelectTopic(topic.id)}
                className={cn(
                  "flex w-full min-h-11 flex-col gap-1.5 px-3 py-2.5 text-left transition-colors cursor-pointer",
                  active ? "bg-accent/70" : "hover:bg-accent/35"
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {topic.pinned ? (
                      <Pin className="h-3 w-3 shrink-0 text-[var(--status-running)]" strokeWidth={1.75} aria-hidden="true" />
                    ) : null}
                    <span className="truncate text-xs font-medium text-foreground">
                      {topic.title}
                    </span>
                  </div>
                  <BoardTopicStatusBadge status={topic.status} />
                </div>
                <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground tabular-nums">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{topic.channel}</span>
                    {topic.external_ref ? (
                      <span className="truncate rounded border border-border px-1 py-px text-foreground/80">
                        {topic.external_ref}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {openCount > 0 ? (
                      <span className="rounded bg-[var(--status-approval)] px-1 py-px font-semibold text-black">
                        提问 {openCount}
                      </span>
                    ) : null}
                    <span>{formatShortTime(topic.updated_at)}</span>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  const renderDesktopOpenQuestionBanner = (q: BoardMessage) => {
    const busy = Boolean(answeringIds[q.id]);
    const draft = answerTextByMsgId[q.id] ?? "";
    return (
      <div
        key={q.id}
        data-testid={`board-open-question-banner-${q.id}`}
        className="shrink-0 space-y-2.5 border-b border-[var(--status-approval)]/40 bg-[var(--status-approval)]/10 px-3 py-2.5"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <HelpCircle className="h-3.5 w-3.5 shrink-0 text-[var(--status-approval)]" strokeWidth={1.75} aria-hidden="true" />
            <span className="truncate text-xs font-semibold text-foreground">
              阻塞提问待确认 ·{" "}
              <span className="font-mono">
                {q.actor_profile || q.actor_scope}
                {q.source_node ? `@${q.source_node}` : ""}
              </span>
            </span>
          </div>
          {q.question_expires_at ? (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
              截止 {formatShortTime(q.question_expires_at)}
            </span>
          ) : null}
        </div>

        <div className="ahub-markdown text-xs text-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
            {q.text_md}
          </ReactMarkdown>
        </div>

        {isAdmin ? (
          <div className="space-y-2">
            {q.question_options.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {q.question_options.map((opt, idx) => (
                  <Button
                    key={`${q.id}-opt-${idx}`}
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    data-testid={`board-question-option-${q.id}-${idx}`}
                    onClick={() => void handleAnswerSubmit(q, opt)}
                    className="min-h-11 md:min-h-0 md:h-7 border-[var(--status-approval)]/50 bg-background/80 hover:bg-accent"
                  >
                    {opt}
                  </Button>
                ))}
              </div>
            ) : null}

            <div className="flex items-center gap-2">
              <Input
                value={draft}
                onChange={(e) =>
                  setAnswerTextByMsgId((prev) => ({ ...prev, [q.id]: e.target.value }))
                }
                placeholder="输入管理员答复或补充说明..."
                aria-label="答复提问"
                disabled={busy}
                data-testid={`board-question-answer-input-${q.id}`}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void handleAnswerSubmit(q);
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                disabled={busy || !draft.trim()}
                onClick={() => void handleAnswerSubmit(q)}
                data-testid={`board-answer-submit-btn-${q.id}`}
                className="min-h-11 md:min-h-0 md:h-8 shrink-0"
              >
                <Send className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                {busy ? "提交中…" : "提交答复"}
              </Button>
            </div>
          </div>
        ) : (
          <div
            data-testid="board-client-readonly-banner"
            className="rounded-[5px] border border-border bg-background/70 px-2.5 py-1.5 text-[11px] text-muted-foreground"
          >
            仅管理员可答复协同板阻塞提问。请使用管理员账号登录后在收件箱或当前主题作答。
          </div>
        )}
      </div>
    );
  };

  const composerForm = (
    <div
      data-testid="board-composer"
      className={cn(
        "shrink-0 border-t border-border bg-card p-2.5 space-y-2",
        !isDesktop && openQuestions.length === 0 && "pb-[max(0.625rem,var(--safe-bottom))]"
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Select
            value={composerKind}
            onValueChange={(v) => setComposerKind(v as typeof composerKind)}
          >
            <SelectTrigger
              aria-label="消息类型"
              data-testid="board-composer-kind"
              className="w-28"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="note">备注 (note)</SelectItem>
              <SelectItem value="handoff">交接 (handoff)</SelectItem>
              <SelectItem value="question">提问 (question)</SelectItem>
              <SelectItem value="artifact">产物 (artifact)</SelectItem>
            </SelectContent>
          </Select>

          <Input
            value={composerProfile}
            onChange={(e) => setComposerProfile(e.target.value)}
            placeholder="actor_profile (可选)"
            aria-label="署名角色 actor_profile"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            data-testid="board-composer-profile"
            className="w-40 font-mono"
          />
        </div>

        {composerKind !== "question" ? (
          <span
            data-testid="board-composer-no-push-hint"
            className="text-[11px] text-muted-foreground"
          >
            不触发外发推送
          </span>
        ) : (
          <Select
            value={String(questionExpiresSec)}
            onValueChange={(v) => setQuestionExpiresSec(Number(v))}
          >
            <SelectTrigger aria-label="提问超时时间" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="3600">1 小时后过期</SelectItem>
              <SelectItem value="21600">6 小时后过期</SelectItem>
              <SelectItem value="86400">24 小时后过期</SelectItem>
              <SelectItem value="259200">72 小时后过期</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      {composerKind === "question" ? (
        <div className="space-y-1.5 rounded-[5px] border border-border bg-background/50 p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground tabular-nums">
              预设快捷选项（最多 8 项，当前 {questionOptions.length}）
            </span>
            {questionOptions.length < 8 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setQuestionOptions((prev) => [...prev, ""])}
                className="min-h-11 md:min-h-0 md:h-6 px-2 text-xs md:text-[11px]"
              >
                <Plus className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                加选项
              </Button>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {questionOptions.map((opt, idx) => (
              <div key={idx} className="flex items-center gap-1">
                <Input
                  value={opt}
                  onChange={(e) =>
                    setQuestionOptions((prev) =>
                      prev.map((item, i) => (i === idx ? e.target.value : item))
                    )
                  }
                  placeholder={`选项 ${idx + 1}`}
                  aria-label={`提问选项 ${idx + 1}`}
                />
                {questionOptions.length > 1 ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`移除选项 ${idx + 1}`}
                    onClick={() =>
                      setQuestionOptions((prev) => prev.filter((_, i) => i !== idx))
                    }
                    className="h-11 w-11 md:h-7 md:w-7 shrink-0"
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Textarea
          value={composerText}
          onChange={(e) => setComposerText(e.target.value)}
          placeholder={
            composerKind === "question"
              ? "输入需要阻塞确认的问题（发送后主题将联锁进入 blocked 并推送提醒）..."
              : composerKind === "handoff"
                ? "输入跨机交接摘要、验证结论与下一步..."
                : "输入协同板消息（支持 Markdown，⌘Enter / Ctrl+Enter 发送）..."
          }
          aria-label="协同板消息内容"
          data-testid="board-composer-text"
          className="min-h-[64px] flex-1"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void handleSubmitMessage();
            }
          }}
        />
        <Button
          type="button"
          disabled={submittingMessage || !composerText.trim()}
          onClick={() => void handleSubmitMessage()}
          data-testid="board-composer-submit"
          className="min-h-11 md:min-h-0 md:h-9 shrink-0"
        >
          <Send className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          {submittingMessage
            ? "发送中…"
            : composerKind === "question"
              ? "发起提问"
              : "发布消息"}
        </Button>
      </div>
    </div>
  );

  const timelineDetailElement = (
    <div className="relative flex min-h-0 flex-1 flex-col bg-background overflow-hidden">
      {/* Detail Header */}
      <div className="flex min-h-11 md:min-h-0 md:h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-card/60 px-3 py-1.5 md:py-0">
        <div className="flex min-w-0 items-center gap-2">
          {!isDesktop ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onMobileBackToList}
              data-testid="board-mobile-back-btn"
              className="min-h-11 px-2 -ml-1 shrink-0"
            >
              <ArrowLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              列表
            </Button>
          ) : null}
          {selectedTopic ? (
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-xs font-semibold text-foreground">
                {selectedTopic.title}
              </span>
              <span className="hidden sm:inline font-mono text-[11px] text-muted-foreground">
                {selectedTopic.channel}
              </span>
              <BoardTopicStatusBadge status={selectedTopic.status} />
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">协同板时间线</span>
          )}
        </div>

        {isDesktop ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onToggleInspector}
            data-testid="board-toggle-inspector-btn"
            aria-label={inspectorCollapsed ? "展开主题上下文检视器" : "收起主题上下文检视器"}
            className="h-7 px-2 text-[11px] shrink-0"
          >
            <PanelRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            {inspectorCollapsed ? "展开上下文" : "收起上下文"}
          </Button>
        ) : null}
      </div>

      {!selectedTopic ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground text-pretty">
          {boardPermissionDenied
            ? "当前凭证尚未分配协同板频道前缀权限（`allowed_board_prefixes`）。请联系管理员在凭证管理中授权后再访问。"
            : "选择左侧协同主题查看消息时间线、阻塞提问与交接快照。"}
        </div>
      ) : (
        <>
          {/* Desktop pinned open question banners */}
          {isDesktop && openQuestions.length > 0 ? (
            <div className="shrink-0 max-h-64 overflow-y-auto">
              {openQuestions.map((q) => renderDesktopOpenQuestionBanner(q))}
            </div>
          ) : null}

          {/* Scrollable Message Timeline */}
          <div
            data-testid="board-messages-list"
            className="min-h-0 flex-1 overflow-y-auto divide-y divide-border"
          >
            {messagesLoading && messages.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                正在加载主题时间线…
              </div>
            ) : messages.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                该主题暂无消息。可在下方发布备注、交接摘要或提问。
              </div>
            ) : (
              messages.map((msg) => {
                const kindMeta = MESSAGE_KIND_META[msg.kind];
                const isOpenQuestion = msg.kind === "question" && msg.question_state === "open";
                const actorLabel = `${msg.actor_profile || msg.actor_scope}${msg.source_node ? `@${msg.source_node}` : ""}`;
                return (
                  <article
                    key={msg.id}
                    data-testid={`board-message-row-${msg.id}`}
                    data-message-kind={msg.kind}
                    className={cn(
                      "px-3 py-3 space-y-1.5",
                      isOpenQuestion && "border-l-2 border-l-[var(--status-approval)] bg-[var(--status-approval)]/5"
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <Badge variant={kindMeta.variant}>{kindMeta.label}</Badge>
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {msg.actor_scope}
                        </Badge>
                        <span className="truncate font-mono text-[11px] font-medium text-foreground">
                          {actorLabel}
                        </span>
                        {msg.kind === "question" && msg.question_state ? (
                          <Badge
                            variant={
                              msg.question_state === "open"
                                ? "approval"
                                : msg.question_state === "answered"
                                  ? "done"
                                  : "outline"
                            }
                          >
                            {QUESTION_STATE_LABEL[msg.question_state] ?? msg.question_state}
                          </Badge>
                        ) : null}
                      </div>

                      <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-muted-foreground tabular-nums">
                        <span>#{msg.seq}</span>
                        <span>{formatShortTime(msg.created_at)}</span>
                      </div>
                    </div>

                    <div className="ahub-markdown text-foreground">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                        {msg.text_md}
                      </ReactMarkdown>
                    </div>

                    {msg.kind === "question" && msg.question_options.length > 0 ? (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {msg.question_options.map((opt, idx) => (
                          <span
                            key={`${msg.id}-preview-opt-${idx}`}
                            className="rounded-[4px] border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                          >
                            {opt}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    {renderStructuredDataPreview(msg)}
                  </article>
                );
              })
            )}
          </div>

          {/* Mobile Sticky Bottom Q&A Bar when open question exists */}
          {!isDesktop && primaryOpenQuestion ? (
            <div className="shrink-0 border-t border-border bg-card">
              <div className="flex items-center justify-between border-b border-border px-3 py-1">
                <span className="text-[11px] text-muted-foreground">
                  {mobileComposerExpanded ? "收起常规发帖" : "待决提问优先处理"}
                </span>
                <button
                  type="button"
                  onClick={() => setMobileComposerExpanded((v) => !v)}
                  className="inline-flex min-h-11 items-center gap-1 px-2 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  {mobileComposerExpanded ? (
                    <>
                      <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      收起发帖
                    </>
                  ) : (
                    <>
                      <ChevronUp className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      发布其他消息
                    </>
                  )}
                </button>
              </div>
              {mobileComposerExpanded ? composerForm : null}

              <div
                data-testid="board-mobile-qa-bar"
                className="sticky bottom-0 z-10 overflow-x-hidden space-y-2 border-t border-[var(--status-approval)]/40 bg-[var(--status-approval)]/10 px-3 pt-2.5 pb-[max(0.75rem,var(--safe-bottom))] pl-[max(0.75rem,var(--safe-left))] pr-[max(0.75rem,var(--safe-right))]"
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-semibold text-foreground">
                    阻塞提问 · {primaryOpenQuestion.actor_profile || primaryOpenQuestion.actor_scope}
                  </span>
                  {openQuestions.length > 1 ? (
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                      共 {openQuestions.length} 条待答复
                    </span>
                  ) : null}
                </div>

                {isAdmin ? (
                  <div className="space-y-2">
                    {primaryOpenQuestion.question_options.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {primaryOpenQuestion.question_options.map((opt, idx) => (
                          <Button
                            key={`mob-${primaryOpenQuestion.id}-opt-${idx}`}
                            type="button"
                            variant="outline"
                            disabled={Boolean(answeringIds[primaryOpenQuestion.id])}
                            data-testid={`board-mobile-question-option-${idx}`}
                            onClick={() => void handleAnswerSubmit(primaryOpenQuestion, opt)}
                            className="min-h-11 min-w-11 border-[var(--status-approval)]/50 bg-background text-xs"
                          >
                            {opt}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                    <div className="flex items-center gap-2">
                      <Input
                        value={answerTextByMsgId[primaryOpenQuestion.id] ?? ""}
                        onChange={(e) =>
                          setAnswerTextByMsgId((prev) => ({
                            ...prev,
                            [primaryOpenQuestion.id]: e.target.value
                          }))
                        }
                        placeholder="输入管理员答复..."
                        aria-label="移动端答复提问"
                        disabled={Boolean(answeringIds[primaryOpenQuestion.id])}
                        data-testid="board-mobile-answer-input"
                      />
                      <Button
                        type="button"
                        disabled={
                          Boolean(answeringIds[primaryOpenQuestion.id]) ||
                          !(answerTextByMsgId[primaryOpenQuestion.id] ?? "").trim()
                        }
                        onClick={() => void handleAnswerSubmit(primaryOpenQuestion)}
                        data-testid="board-mobile-answer-submit-btn"
                        className="min-h-11 min-w-11 shrink-0 px-3"
                      >
                        <Send className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                        提交
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      提交答复后将立即唤醒等待中的本地或远端会话。
                    </p>
                  </div>
                ) : (
                  <div
                    data-testid="board-client-readonly-banner"
                    className="rounded-[5px] border border-border bg-background/80 px-2.5 py-2 text-xs text-muted-foreground"
                  >
                    仅管理员可答复协同板阻塞提问。请使用管理员账号登录后在收件箱或当前主题作答。
                  </div>
                )}
              </div>
            </div>
          ) : (
            composerForm
          )}
        </>
      )}
    </div>
  );

  return (
    <section
      aria-label="协同板主题列表与时间线"
      data-testid="board-topic-timeline"
      className="relative flex h-full flex-col xl:flex-row overflow-hidden bg-background"
    >
      {isDesktop ? (
        <>
          {topicListElement}
          {timelineDetailElement}
        </>
      ) : showMobileDetail ? (
        timelineDetailElement
      ) : (
        showMobileList ? topicListElement : null
      )}
    </section>
  );
}
