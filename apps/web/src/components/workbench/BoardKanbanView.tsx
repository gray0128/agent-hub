import { useMemo } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Lock, Pin, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, formatShortTime } from "@/lib/utils";
import {
  type BoardKanbanColumnStatus,
  type BoardTopicFilter,
  compareTopicsKanban
} from "@/stores/board-store";
import type { BoardChannelSummary, BoardTopic } from "@/types";

export const KANBAN_COLUMNS: ReadonlyArray<{
  status: BoardKanbanColumnStatus;
  label: string;
  dotClass: string;
}> = [
  { status: "todo", label: "待开始", dotClass: "bg-muted-foreground" },
  { status: "in_progress", label: "进行中", dotClass: "bg-[var(--status-running)]" },
  { status: "blocked", label: "待确认", dotClass: "bg-[var(--status-approval)]" },
  { status: "done", label: "已完成", dotClass: "bg-[var(--status-done)]" }
];

export interface BoardKanbanViewProps {
  topics: BoardTopic[];
  channels: BoardChannelSummary[];
  selectedChannel: string | null;
  selectedTopicId: string | null;
  focusedTopicId: string | null;
  topicFilter: BoardTopicFilter;
  searchQuery: string;
  boardPermissionDenied: boolean;
  isDesktop: boolean;
  kanbanMobileStatus: BoardKanbanColumnStatus;
  onSearchQueryChange: (q: string) => void;
  onSelectChannel: (channel: string) => void;
  onSelectTopic: (topicId: string) => void;
  onSelectMobileStatus: (status: BoardKanbanColumnStatus) => void;
  onOpenNewTopic: () => void;
}

interface SortableKanbanCardProps {
  topic: BoardTopic;
  canDrag: boolean;
  isSelected: boolean;
  isFocused: boolean;
  showChannel: boolean;
  onSelect: (topicId: string) => void;
}

function SortableKanbanCard({
  topic,
  canDrag,
  isSelected,
  isFocused,
  showChannel,
  onSelect
}: SortableKanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({
    id: `board-topic:${topic.id}`,
    data: {
      type: "board-topic",
      topicId: topic.id,
      channel: topic.channel,
      status: topic.status
    },
    disabled: !canDrag
  });

  const { onKeyDown: _dragKeyDown, ...pointerListeners } = listeners ?? {};
  const openCount = topic.open_question_count ?? 0;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition
      }}
      data-dragging={isDragging ? "true" : "false"}
      {...(canDrag ? pointerListeners : {})}
      className={cn(
        "group relative flex min-h-11 items-start gap-1.5 rounded-[6px] border p-2.5 transition-colors select-none",
        canDrag && "touch-none",
        isDragging ? "opacity-40" : "opacity-100",
        isFocused
          ? "border-[var(--status-running)] bg-accent/60 ring-1 ring-[var(--status-running)]/50"
          : isSelected
            ? "border-foreground/30 bg-accent/40"
            : "border-border bg-card hover:bg-accent/30",
        openCount > 0 && "border-l-2 border-l-[var(--status-approval)]"
      )}
    >
      <button
        type="button"
        data-testid={`board-kanban-card-${topic.id}`}
        data-topic-id={topic.id}
        data-topic-status={topic.status}
        data-focused={isFocused ? "true" : "false"}
        data-selected={isSelected ? "true" : "false"}
        onClick={() => onSelect(topic.id)}
        className="flex min-h-11 md:min-h-0 w-full min-w-0 flex-1 flex-col gap-1.5 rounded-[4px] text-left cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--status-running)]"
      >
        <span className="flex w-full min-w-0 items-center gap-1">
          {topic.pinned ? (
            <Pin className="h-3 w-3 shrink-0 text-[var(--status-running)]" strokeWidth={1.75} aria-hidden="true" />
          ) : null}
          <span className="line-clamp-2 text-xs font-medium leading-snug text-foreground">
            {topic.title}
          </span>
        </span>

        {topic.latest_handoff ? (
          <span className="block w-full truncate font-mono text-[10px] text-muted-foreground">
            交接：{topic.latest_handoff.actor_profile || "agent"}
            {topic.latest_handoff.source_node ? `@${topic.latest_handoff.source_node}` : ""}
          </span>
        ) : null}

        <span className="flex w-full items-center justify-between gap-1.5 font-mono text-[10px] text-muted-foreground tabular-nums">
          <span className="flex min-w-0 items-center gap-1">
            {showChannel ? (
              <span className="truncate rounded border border-border bg-background/60 px-1 py-px">
                {topic.channel}
              </span>
            ) : null}
            {topic.external_ref ? (
              <span className="truncate rounded border border-border px-1 py-px text-foreground/80">
                {topic.external_ref}
              </span>
            ) : null}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {openCount > 0 ? (
              <span className="rounded bg-[var(--status-approval)] px-1 py-px font-semibold text-black">
                提问 {openCount}
              </span>
            ) : null}
            <span>{formatShortTime(topic.updated_at)}</span>
          </span>
        </span>
      </button>

      {canDrag ? (
        <button
          type="button"
          {...attributes}
          {...listeners}
          data-testid={`board-kanban-drag-handle-${topic.id}`}
          aria-label={`拖拽排序主题 ${topic.title}`}
          className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--status-running)] cursor-grab active:cursor-grabbing"
        >
          <GripVertical className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

interface DroppableKanbanColumnProps {
  status: BoardKanbanColumnStatus;
  label: string;
  dotClass: string;
  topics: BoardTopic[];
  canDrag: boolean;
  selectedTopicId: string | null;
  focusedTopicId: string | null;
  showChannel: boolean;
  onSelectTopic: (topicId: string) => void;
}

function DroppableKanbanColumn({
  status,
  label,
  dotClass,
  topics,
  canDrag,
  selectedTopicId,
  focusedTopicId,
  showChannel,
  onSelectTopic
}: DroppableKanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `board-col:${status}`,
    data: { type: "board-column", status },
    disabled: !canDrag
  });

  const pinnedTopics = useMemo(() => topics.filter((t) => Boolean(t.pinned)), [topics]);
  const unpinnedTopics = useMemo(() => topics.filter((t) => !t.pinned), [topics]);
  const pinnedItemIds = useMemo(() => pinnedTopics.map((t) => `board-topic:${t.id}`), [pinnedTopics]);
  const unpinnedItemIds = useMemo(() => unpinnedTopics.map((t) => `board-topic:${t.id}`), [unpinnedTopics]);

  return (
    <div
      ref={setNodeRef}
      data-testid={`board-kanban-column-${status}`}
      data-kanban-status={status}
      className={cn(
        "flex min-h-0 min-w-0 flex-col rounded-[6px] border bg-surface-elevated overflow-hidden transition-colors",
        isOver && canDrag
          ? "border-[var(--status-running)] bg-[var(--status-running)]/5"
          : "border-border"
      )}
    >
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", dotClass)} aria-hidden="true" />
          <span className="truncate text-xs font-semibold text-foreground">{label}</span>
        </div>
        <span className="shrink-0 rounded-[4px] border border-border bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">
          {topics.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {topics.length === 0 ? (
          <div className="flex h-20 items-center justify-center rounded-[5px] border border-dashed border-border px-2 text-center text-[11px] text-muted-foreground">
            暂无{label}主题
          </div>
        ) : (
          <>
            {pinnedTopics.length > 0 ? (
              <SortableContext items={pinnedItemIds} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {pinnedTopics.map((topic) => (
                    <SortableKanbanCard
                      key={topic.id}
                      topic={topic}
                      canDrag={canDrag}
                      isSelected={selectedTopicId === topic.id}
                      isFocused={focusedTopicId === topic.id}
                      showChannel={showChannel}
                      onSelect={onSelectTopic}
                    />
                  ))}
                </div>
              </SortableContext>
            ) : null}
            {unpinnedTopics.length > 0 ? (
              <SortableContext items={unpinnedItemIds} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {unpinnedTopics.map((topic) => (
                    <SortableKanbanCard
                      key={topic.id}
                      topic={topic}
                      canDrag={canDrag}
                      isSelected={selectedTopicId === topic.id}
                      isFocused={focusedTopicId === topic.id}
                      showChannel={showChannel}
                      onSelect={onSelectTopic}
                    />
                  ))}
                </div>
              </SortableContext>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export function BoardKanbanView({
  topics,
  channels,
  selectedChannel,
  selectedTopicId,
  focusedTopicId,
  topicFilter,
  searchQuery,
  boardPermissionDenied,
  isDesktop,
  kanbanMobileStatus,
  onSearchQueryChange,
  onSelectChannel,
  onSelectTopic,
  onSelectMobileStatus,
  onOpenNewTopic
}: BoardKanbanViewProps) {
  const canDrag = isDesktop && selectedChannel !== null;

  const groupedByStatus = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const groups: Record<BoardKanbanColumnStatus, BoardTopic[]> = {
      todo: [],
      in_progress: [],
      blocked: [],
      done: []
    };

    for (const topic of topics) {
      if (topic.status === "archived") continue;
      if (selectedChannel && topic.channel !== selectedChannel) continue;
      if (topicFilter === "open_questions" && (topic.open_question_count ?? 0) <= 0) continue;
      if (q) {
        const hay = `${topic.title}\n${topic.channel}\n${topic.external_ref}\n${topic.id}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      if (
        topic.status === "todo" ||
        topic.status === "in_progress" ||
        topic.status === "blocked" ||
        topic.status === "done"
      ) {
        groups[topic.status].push(topic);
      }
    }

    for (const col of KANBAN_COLUMNS) {
      groups[col.status].sort(compareTopicsKanban);
    }

    return groups;
  }, [searchQuery, selectedChannel, topicFilter, topics]);

  if (boardPermissionDenied) {
    return (
      <div
        data-testid="board-kanban-view"
        className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground text-pretty tabular-nums"
      >
        当前凭证尚未分配协同板频道前缀权限（`allowed_board_prefixes`）。请联系管理员在凭证管理中授权后再访问。
      </div>
    );
  }

  const mobileTopics = groupedByStatus[kanbanMobileStatus];

  return (
    <section
      aria-label="协同板 4 列状态看板"
      data-testid="board-kanban-view"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background tabular-nums"
    >
      {/* Search + Optional New Topic Bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search
            className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <Input
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            placeholder="搜索看板主题、频道或 external_ref..."
            aria-label="搜索看板协同主题"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="search"
            data-testid="board-search-input"
            className="pl-8"
          />
        </div>
        {!isDesktop ? (
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

      {/* Single-channel drag guard banner */}
      {selectedChannel === null ? (
        <div
          data-testid="board-kanban-channel-guard"
          className="shrink-0 space-y-2 border-b border-border bg-surface-elevated px-3 py-2 text-xs"
        >
          <div className="flex items-start gap-2 text-muted-foreground">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-approval)]" strokeWidth={1.75} aria-hidden="true" />
            <span className="text-pretty">
              当前处于跨频道聚合视图，看板拖拽仅在单个频道内启用。请先从左侧频道树或下方按钮切换至单个频道。
            </span>
          </div>
          {channels.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {channels.map((ch) => (
                <Button
                  key={ch.channel}
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid={`board-kanban-switch-channel-${ch.channel}`}
                  onClick={() => onSelectChannel(ch.channel)}
                  className="min-h-11 max-w-full min-w-0 md:min-h-0 md:h-7 px-2.5 font-mono text-xs md:text-[11px]"
                >
                  <span className="min-w-0 truncate">{ch.channel}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">{ch.active_topic_count}</span>
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {isDesktop ? (
        <div className="grid min-h-0 flex-1 grid-cols-4 gap-2.5 overflow-hidden p-2.5">
          {KANBAN_COLUMNS.map((col) => (
            <DroppableKanbanColumn
              key={col.status}
              status={col.status}
              label={col.label}
              dotClass={col.dotClass}
              topics={groupedByStatus[col.status]}
              canDrag={canDrag}
              selectedTopicId={selectedTopicId}
              focusedTopicId={focusedTopicId}
              showChannel={selectedChannel === null}
              onSelectTopic={onSelectTopic}
            />
          ))}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            role="tablist"
            aria-label="看板状态分页"
            data-testid="board-kanban-mobile-pills"
            className="grid shrink-0 grid-cols-4 gap-1 border-b border-border bg-card/50 p-2"
          >
            {KANBAN_COLUMNS.map((col) => {
              const active = kanbanMobileStatus === col.status;
              const count = groupedByStatus[col.status].length;
              return (
                <button
                  key={col.status}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`board-kanban-mobile-pill-${col.status}`}
                  onClick={() => onSelectMobileStatus(col.status)}
                  className={cn(
                    "flex min-h-11 min-w-0 flex-col items-center justify-center rounded-[5px] border px-1 py-1 text-[11px] leading-tight transition-colors cursor-pointer",
                    active
                      ? "border-[var(--status-running)]/60 bg-[var(--status-running)]/12 text-foreground font-semibold"
                      : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
                  )}
                >
                  <span className="truncate">{col.label}</span>
                  <span className="font-mono text-[10px] tabular-nums">{count}</span>
                </button>
              );
            })}
          </div>

          <div
            data-testid="board-kanban-mobile-list"
            className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5"
          >
            {mobileTopics.length === 0 ? (
              <div className="rounded-[6px] border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                暂无{KANBAN_COLUMNS.find((c) => c.status === kanbanMobileStatus)?.label ?? ""}主题
              </div>
            ) : (
              mobileTopics.map((topic) => (
                <SortableKanbanCard
                  key={topic.id}
                  topic={topic}
                  canDrag={false}
                  isSelected={selectedTopicId === topic.id}
                  isFocused={focusedTopicId === topic.id}
                  showChannel={selectedChannel === null}
                  onSelect={onSelectTopic}
                />
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}
