import { useEffect, useMemo, useRef, useState } from "react";
import { Group, type LayoutStorage, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { Columns3, List, MessageSquareText, Plus } from "lucide-react";
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
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  isNonListInteractiveControl,
  shouldIgnoreActivationShortcut,
  shouldIgnoreGlobalShortcut
} from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import {
  type BoardKanbanColumnStatus,
  type BoardTopicFilter,
  type BoardViewMode,
  compareTopicsKanban,
  filterAndSortBoardTopics
} from "@/stores/board-store";
import type { AuthScope } from "@/stores/workbench-store";
import type {
  AnswerBoardQuestionPayload,
  BoardChannelSummary,
  BoardMessage,
  BoardTopic,
  BoardTopicStatus,
  CreateBoardMessagePayload,
  CreateBoardTopicPayload
} from "@/types";
import { BoardChannelTree } from "./BoardChannelTree";
import { BoardKanbanView, KANBAN_COLUMNS } from "./BoardKanbanView";
import { BoardTopicInspector } from "./BoardTopicInspector";
import { BoardTopicTimeline } from "./BoardTopicTimeline";

export interface BoardWorkspaceProps {
  channels: BoardChannelSummary[];
  topics: BoardTopic[];
  messagesByTopicId: Record<string, BoardMessage[]>;
  openBoardQuestionCount: number;
  selectedChannel: string | null;
  selectedTopicId: string | null;
  focusedTopicId: string | null;
  topicFilter: BoardTopicFilter;
  viewMode: BoardViewMode;
  kanbanMobileStatus: BoardKanbanColumnStatus;
  searchQuery: string;
  boardPermissionDenied: boolean;
  authScope: AuthScope | null;
  isDesktop: boolean;
  isDragging?: boolean;
  mobileLeftOpen: boolean;
  mobileRightOpen: boolean;
  mobileShowDetail: boolean;
  messagesLoading: boolean;
  submittingMessage: boolean;
  updatingTopic: boolean;
  answeringIds: Record<string, boolean>;
  onMobileLeftOpenChange: (open: boolean) => void;
  onMobileRightOpenChange: (open: boolean) => void;
  onMobileShowDetailChange: (show: boolean) => void;
  onSelectView: (channel: string | null, filter: BoardTopicFilter) => void;
  onViewModeChange: (mode: BoardViewMode) => void;
  onKanbanMobileStatusChange: (status: BoardKanbanColumnStatus) => void;
  onSelectTopic: (topicId: string) => void;
  onFocusedTopicIdChange: (topicId: string | null) => void;
  onSearchQueryChange: (q: string) => void;
  onCreateTopic: (payload: CreateBoardTopicPayload) => Promise<BoardTopic | null>;
  onUpdateTopicStatus: (topicId: string, status: BoardTopicStatus) => void;
  onToggleTopicPin: (topic: BoardTopic) => void;
  onPostMessage: (topicId: string, payload: CreateBoardMessagePayload) => Promise<boolean>;
  onAnswerQuestion: (messageId: string, payload: AnswerBoardQuestionPayload) => Promise<boolean>;
}

const BOARD_PANEL_IDS = ["board-channels", "board-timeline", "board-inspector"];

function createSafeBoardLayoutStorage(): LayoutStorage | undefined {
  if (typeof window === "undefined") return undefined;
  return {
    getItem: (key) => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // ignore storage restrictions
      }
    }
  };
}

const KEYBOARD_STATUS_MAP: Record<string, BoardKanbanColumnStatus> = {
  "1": "todo",
  "2": "in_progress",
  "3": "blocked",
  "4": "done"
};

const BOARD_TOPIC_NAV_SELECTOR =
  '[data-testid^="board-kanban-card-"], [data-testid^="board-list-item-"], [data-testid^="board-topic-item-"]';

const BOARD_TOPIC_TESTID_PREFIXES = [
  "board-kanban-card-",
  "board-list-item-",
  "board-topic-item-"
] as const;

function getDomFocusedTopicId(node: EventTarget | null): string | null {
  if (!(node instanceof Element)) return null;
  const navEl = node.closest(BOARD_TOPIC_NAV_SELECTOR);
  if (!navEl) return null;
  const explicit = navEl.getAttribute("data-topic-id");
  if (explicit) return explicit;
  const testId = navEl.getAttribute("data-testid") ?? "";
  for (const prefix of BOARD_TOPIC_TESTID_PREFIXES) {
    if (testId.startsWith(prefix)) {
      return testId.slice(prefix.length) || null;
    }
  }
  return null;
}

function findTopicNavElement(topicId: string): HTMLElement | null {
  const el =
    document.querySelector(`[data-testid="board-topic-item-${topicId}"]`) ??
    document.querySelector(`[data-testid="board-list-item-${topicId}"]`) ??
    document.querySelector(`[data-testid="board-kanban-card-${topicId}"]`);
  return el instanceof HTMLElement ? el : null;
}

export function BoardWorkspace({
  channels,
  topics,
  messagesByTopicId,
  openBoardQuestionCount,
  selectedChannel,
  selectedTopicId,
  focusedTopicId,
  topicFilter,
  viewMode,
  kanbanMobileStatus,
  searchQuery,
  boardPermissionDenied,
  authScope,
  isDesktop,
  isDragging = false,
  mobileLeftOpen,
  mobileRightOpen,
  mobileShowDetail,
  messagesLoading,
  submittingMessage,
  updatingTopic,
  answeringIds,
  onMobileLeftOpenChange,
  onMobileRightOpenChange,
  onMobileShowDetailChange,
  onSelectView,
  onViewModeChange,
  onKanbanMobileStatusChange,
  onSelectTopic,
  onFocusedTopicIdChange,
  onSearchQueryChange,
  onCreateTopic,
  onUpdateTopicStatus,
  onToggleTopicPin,
  onPostMessage,
  onAnswerQuestion
}: BoardWorkspaceProps) {
  const [newTopicOpen, setNewTopicOpen] = useState(false);
  const [newChannel, setNewChannel] = useState("proj/demo");
  const [newTitle, setNewTitle] = useState("");
  const [newExternalRef, setNewExternalRef] = useState("");
  const [newStatus, setNewStatus] = useState<BoardTopicStatus>("todo");
  const [creatingTopic, setCreatingTopic] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | BoardTopicStatus>("all");
  const [focusZone, setFocusZone] = useState<"list" | "detail">("list");
  const [stagedQuestionOptionIdx, setStagedQuestionOptionIdx] = useState<number | null>(null);
  const returnViewModeRef = useRef<BoardViewMode | null>(null);

  const layoutStorage = useMemo(() => createSafeBoardLayoutStorage(), []);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "ahub-board-layout",
    panelIds: BOARD_PANEL_IDS,
    storage: layoutStorage
  });
  const inspectorPanelRef = usePanelRef();

  const selectedTopic = useMemo(
    () => topics.find((t) => t.id === selectedTopicId) ?? null,
    [selectedTopicId, topics]
  );

  const selectedTopicMessages = useMemo(
    () => (selectedTopic ? messagesByTopicId[selectedTopic.id] ?? [] : []),
    [messagesByTopicId, selectedTopic]
  );

  const primaryOpenQuestion = useMemo(
    () => selectedTopicMessages.find((m) => m.kind === "question" && m.question_state === "open") ?? null,
    [selectedTopicMessages]
  );

  const visibleTopics = useMemo(() => {
    if (viewMode === "kanban") {
      const q = searchQuery.trim().toLowerCase();
      const grouped: Record<BoardKanbanColumnStatus, BoardTopic[]> = {
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
          grouped[topic.status].push(topic);
        }
      }
      for (const col of KANBAN_COLUMNS) {
        grouped[col.status].sort(compareTopicsKanban);
      }
      if (!isDesktop) {
        return grouped[kanbanMobileStatus];
      }
      return [
        ...grouped.todo,
        ...grouped.in_progress,
        ...grouped.blocked,
        ...grouped.done
      ];
    }

    return filterAndSortBoardTopics({
      topics,
      selectedChannel,
      topicFilter,
      statusFilter,
      searchQuery
    });
  }, [
    isDesktop,
    kanbanMobileStatus,
    searchQuery,
    selectedChannel,
    statusFilter,
    topicFilter,
    topics,
    viewMode
  ]);

  useEffect(() => {
    setStagedQuestionOptionIdx(null);
  }, [primaryOpenQuestion?.id, selectedTopicId]);

  useEffect(() => {
    if (!focusedTopicId) return;
    if (!visibleTopics.some((t) => t.id === focusedTopicId)) {
      onFocusedTopicIdChange(null);
    }
  }, [focusedTopicId, onFocusedTopicIdChange, visibleTopics]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (isDragging || shouldIgnoreGlobalShortcut(event) || shouldIgnoreActivationShortcut(event)) {
        return;
      }

      const key = event.key;
      const lower = key.toLowerCase();
      const domNavEl =
        (event.target instanceof Element ? event.target.closest(BOARD_TOPIC_NAV_SELECTOR) : null) ??
        (document.activeElement instanceof Element
          ? document.activeElement.closest(BOARD_TOPIC_NAV_SELECTOR)
          : null);
      const domFocusedTopicId = getDomFocusedTopicId(domNavEl);
      const domFocusedTopic = domFocusedTopicId
        ? visibleTopics.find((t) => t.id === domFocusedTopicId) ?? null
        : null;
      const focusedTopic = focusedTopicId
        ? visibleTopics.find((t) => t.id === focusedTopicId) ?? null
        : null;
      const isFocusedOnDifferentTopic =
        Boolean(domFocusedTopic) && domFocusedTopic?.id !== selectedTopic?.id;
      const isDetailActive =
        !isFocusedOnDifferentTopic && (focusZone === "detail" || (!isDesktop && mobileShowDetail));

      if (lower === "j" || lower === "k") {
        event.preventDefault();
        if (visibleTopics.length === 0) return;

        const currentFocusId = domFocusedTopicId ?? focusedTopicId;
        let nextIdx = 0;
        if (currentFocusId === null) {
          if (lower === "k") {
            const curSelIdx = selectedTopicId
              ? visibleTopics.findIndex((t) => t.id === selectedTopicId)
              : -1;
            nextIdx = curSelIdx > 0 ? curSelIdx - 1 : 0;
          } else {
            nextIdx = 0;
          }
        } else {
          const curIdx = visibleTopics.findIndex((t) => t.id === currentFocusId);
          if (curIdx < 0) {
            nextIdx = 0;
          } else if (lower === "j") {
            nextIdx = Math.min(visibleTopics.length - 1, curIdx + 1);
          } else {
            nextIdx = Math.max(0, curIdx - 1);
          }
        }

        const nextTopic = visibleTopics[nextIdx];
        if (!nextTopic) return;
        onFocusedTopicIdChange(nextTopic.id);
        setFocusZone("list");
        setStagedQuestionOptionIdx(null);

        const el = findTopicNavElement(nextTopic.id);
        const activeEl = document.activeElement;
        if (
          activeEl instanceof HTMLElement &&
          activeEl !== el &&
          (isNonListInteractiveControl(activeEl) ||
            Boolean(activeEl.closest(BOARD_TOPIC_NAV_SELECTOR)))
        ) {
          activeEl.blur();
        }
        if (el) {
          el.scrollIntoView({ block: "nearest" });
          el.focus({ preventScroll: true });
        } else {
          requestAnimationFrame(() => {
            const deferredEl = findTopicNavElement(nextTopic.id);
            if (deferredEl) {
              deferredEl.scrollIntoView({ block: "nearest" });
              deferredEl.focus({ preventScroll: true });
            }
          });
        }
        return;
      }

      if (key === "1" || key === "2" || key === "3" || key === "4") {
        const optionIdx = Number(key) - 1;
        if (isDetailActive && primaryOpenQuestion) {
          if (
            authScope === "admin" &&
            optionIdx < primaryOpenQuestion.question_options.length
          ) {
            event.preventDefault();
            setStagedQuestionOptionIdx(optionIdx);
          }
          return;
        }
        event.preventDefault();
        const target = isDetailActive
          ? selectedTopic ?? domFocusedTopic ?? focusedTopic
          : domFocusedTopic ?? focusedTopic ?? selectedTopic;
        const targetStatus = KEYBOARD_STATUS_MAP[key];
        if (target && targetStatus) {
          onUpdateTopicStatus(target.id, targetStatus);
        }
        return;
      }

      const isFocusedKanbanCard = Boolean(
        domNavEl?.matches('[data-testid^="board-kanban-card-"]')
      );

      if (key === "Enter" || (key === " " && isFocusedKanbanCard)) {
        event.preventDefault();
        if (
          key === "Enter" &&
          stagedQuestionOptionIdx !== null &&
          isDetailActive &&
          authScope === "admin" &&
          primaryOpenQuestion
        ) {
          const opt = primaryOpenQuestion.question_options[stagedQuestionOptionIdx];
          if (opt) {
            void onAnswerQuestion(primaryOpenQuestion.id, { selected_option: opt });
            setStagedQuestionOptionIdx(null);
            return;
          }
        }
        const target = domFocusedTopic ?? focusedTopic ?? visibleTopics[0] ?? selectedTopic;
        if (!target) return;
        onSelectTopic(target.id);
        onFocusedTopicIdChange(target.id);
        setFocusZone("detail");
        if (viewMode !== "timeline") {
          returnViewModeRef.current = viewMode;
          onViewModeChange("timeline");
        }
        if (!isDesktop) {
          onMobileShowDetailChange(true);
        }
        return;
      }

      if (key === "Escape") {
        event.preventDefault();
        if (stagedQuestionOptionIdx !== null) {
          setStagedQuestionOptionIdx(null);
          return;
        }
        if (isDetailActive) {
          setFocusZone("list");
          if (!isDesktop) {
            onMobileShowDetailChange(false);
          }
          if (returnViewModeRef.current && returnViewModeRef.current !== "timeline") {
            const restore = returnViewModeRef.current;
            returnViewModeRef.current = null;
            onViewModeChange(restore);
          }
          return;
        }
        if (focusedTopicId !== null) {
          onFocusedTopicIdChange(null);
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    authScope,
    focusZone,
    focusedTopicId,
    isDesktop,
    isDragging,
    mobileShowDetail,
    onAnswerQuestion,
    onFocusedTopicIdChange,
    onMobileShowDetailChange,
    onSelectTopic,
    onUpdateTopicStatus,
    onViewModeChange,
    primaryOpenQuestion,
    selectedTopic,
    selectedTopicId,
    stagedQuestionOptionIdx,
    viewMode,
    visibleTopics
  ]);

  function handleOpenNewTopic() {
    if (selectedChannel) {
      setNewChannel(selectedChannel);
    } else if (channels.length > 0) {
      setNewChannel(channels[0].channel);
    }
    setNewTitle("");
    setNewExternalRef("");
    setNewStatus("todo");
    setNewTopicOpen(true);
  }

  async function handleSubmitNewTopic() {
    const channel = newChannel.trim().replace(/^\/+|\/+$/g, "");
    const title = newTitle.trim();
    if (!channel || !title) return;
    setCreatingTopic(true);
    try {
      const created = await onCreateTopic({
        channel,
        title,
        ...(newExternalRef.trim() ? { external_ref: newExternalRef.trim() } : {}),
        status: newStatus,
        upsert: Boolean(newExternalRef.trim())
      });
      if (created) {
        setNewTopicOpen(false);
        onSelectTopic(created.id);
        if (!isDesktop) {
          onMobileLeftOpenChange(false);
          onMobileShowDetailChange(true);
        }
      }
    } finally {
      setCreatingTopic(false);
    }
  }

  function handleToggleInspector() {
    const panel = inspectorPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
      setInspectorCollapsed(false);
    } else {
      panel.collapse();
      setInspectorCollapsed(true);
    }
  }

  const channelTreeNode = (inDrawer: boolean) => (
    <BoardChannelTree
      channels={channels}
      topics={topics}
      openBoardQuestionCount={openBoardQuestionCount}
      selectedChannel={selectedChannel}
      topicFilter={topicFilter}
      boardPermissionDenied={boardPermissionDenied}
      inDrawer={inDrawer}
      onSelectView={(ch, filter) => {
        returnViewModeRef.current = null;
        setFocusZone("list");
        onSelectView(ch, filter);
        if (!isDesktop) {
          onMobileLeftOpenChange(false);
          onMobileShowDetailChange(false);
        }
      }}
      onOpenNewTopic={() => {
        if (!isDesktop) {
          onMobileLeftOpenChange(false);
        }
        handleOpenNewTopic();
      }}
    />
  );

  const showKanbanMobileDetail = viewMode === "kanban" && !isDesktop && mobileShowDetail && Boolean(selectedTopic);

  const viewContextLabel = selectedChannel
    ? selectedChannel
    : topicFilter === "recent"
      ? "近期动态"
      : topicFilter === "open_questions"
        ? "待我确认"
        : "全部活跃";

  const viewSwitcherBar = (
    <div
      data-testid="board-view-switcher"
      className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card/50 px-2.5 py-1.5"
    >
      <div
        role="group"
        aria-label="协同板视角切换"
        className="inline-flex items-center rounded-[6px] border border-border bg-background p-0.5 gap-0.5"
      >
        <button
          type="button"
          data-testid="board-view-tab-timeline"
          aria-pressed={viewMode === "timeline"}
          onClick={() => {
            returnViewModeRef.current = null;
            setFocusZone("list");
            onViewModeChange("timeline");
            if (!isDesktop) onMobileShowDetailChange(false);
          }}
          className={cn(
            "inline-flex min-h-11 min-w-11 md:min-h-0 md:min-w-0 md:h-7 items-center justify-center gap-1.5 rounded-[4px] px-2.5 text-xs font-medium transition-colors cursor-pointer",
            viewMode === "timeline"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <MessageSquareText className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span>话题流</span>
        </button>

        <button
          type="button"
          data-testid="board-view-tab-list"
          aria-pressed={viewMode === "list"}
          onClick={() => {
            returnViewModeRef.current = null;
            setFocusZone("list");
            onViewModeChange("list");
            if (!isDesktop) onMobileShowDetailChange(false);
          }}
          className={cn(
            "inline-flex min-h-11 min-w-11 md:min-h-0 md:min-w-0 md:h-7 items-center justify-center gap-1.5 rounded-[4px] px-2.5 text-xs font-medium transition-colors cursor-pointer",
            viewMode === "list"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <List className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span>列表</span>
        </button>

        <button
          type="button"
          data-testid="board-view-tab-kanban"
          aria-pressed={viewMode === "kanban"}
          onClick={() => {
            returnViewModeRef.current = null;
            setFocusZone("list");
            onViewModeChange("kanban");
            if (!isDesktop) onMobileShowDetailChange(false);
          }}
          className={cn(
            "inline-flex min-h-11 min-w-11 md:min-h-0 md:min-w-0 md:h-7 items-center justify-center gap-1.5 rounded-[4px] px-2.5 text-xs font-medium transition-colors cursor-pointer",
            viewMode === "kanban"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Columns3 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span>看板</span>
        </button>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <span className="hidden sm:inline truncate font-mono text-[11px] text-muted-foreground">
          {viewContextLabel}
        </span>
        <span className="hidden xl:inline font-mono text-[10px] text-muted-foreground">
          J/K 焦点 · Enter 进入 · 1-4 状态
        </span>
      </div>
    </div>
  );

  const timelineNode = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {viewSwitcherBar}
      {viewMode === "kanban" && !showKanbanMobileDetail ? (
        <BoardKanbanView
          topics={topics}
          channels={channels}
          selectedChannel={selectedChannel}
          selectedTopicId={selectedTopicId}
          focusedTopicId={focusedTopicId}
          topicFilter={topicFilter}
          searchQuery={searchQuery}
          boardPermissionDenied={boardPermissionDenied}
          isDesktop={isDesktop}
          kanbanMobileStatus={kanbanMobileStatus}
          onSearchQueryChange={onSearchQueryChange}
          onSelectChannel={(ch) => {
            returnViewModeRef.current = null;
            setFocusZone("list");
            onSelectView(ch, "active");
          }}
          onSelectTopic={(tid) => {
            onSelectTopic(tid);
            onFocusedTopicIdChange(tid);
            if (!isDesktop) {
              returnViewModeRef.current = "kanban";
              setFocusZone("detail");
              onMobileShowDetailChange(true);
            }
          }}
          onSelectMobileStatus={onKanbanMobileStatusChange}
          onOpenNewTopic={handleOpenNewTopic}
        />
      ) : (
        <BoardTopicTimeline
          topics={topics}
          selectedChannel={selectedChannel}
          selectedTopic={selectedTopic}
          focusedTopicId={focusedTopicId}
          viewMode={viewMode === "kanban" ? "timeline" : viewMode}
          statusFilter={statusFilter}
          stagedQuestionOptionIdx={stagedQuestionOptionIdx}
          messages={selectedTopicMessages}
          messagesLoading={messagesLoading}
          topicFilter={topicFilter}
          searchQuery={searchQuery}
          authScope={authScope}
          boardPermissionDenied={boardPermissionDenied}
          isDesktop={isDesktop}
          mobileShowDetail={mobileShowDetail}
          inspectorCollapsed={inspectorCollapsed}
          submittingMessage={submittingMessage}
          answeringIds={answeringIds}
          onSearchQueryChange={onSearchQueryChange}
          onStatusFilterChange={setStatusFilter}
          onSelectTopic={(tid) => {
            onSelectTopic(tid);
            onFocusedTopicIdChange(tid);
            setFocusZone("detail");
            if (!isDesktop) {
              onMobileShowDetailChange(true);
            }
          }}
          onOpenTopicDetail={(tid) => {
            onSelectTopic(tid);
            onFocusedTopicIdChange(tid);
            setFocusZone("detail");
            if (viewMode !== "timeline") {
              returnViewModeRef.current = viewMode;
              onViewModeChange("timeline");
            }
            if (!isDesktop) {
              onMobileShowDetailChange(true);
            }
          }}
          onMobileBackToList={() => {
            setFocusZone("list");
            onMobileShowDetailChange(false);
            if (returnViewModeRef.current && returnViewModeRef.current !== "timeline") {
              const restore = returnViewModeRef.current;
              returnViewModeRef.current = null;
              onViewModeChange(restore);
            }
          }}
          onToggleInspector={handleToggleInspector}
          onOpenNewTopic={handleOpenNewTopic}
          onPostMessage={onPostMessage}
          onAnswerQuestion={onAnswerQuestion}
        />
      )}
    </div>
  );

  const inspectorNode = (
    <BoardTopicInspector
      topic={selectedTopic}
      messages={selectedTopicMessages}
      updatingTopic={updatingTopic}
      onUpdateStatus={onUpdateTopicStatus}
      onTogglePin={onToggleTopicPin}
    />
  );

  return (
    <div
      data-testid="board-workspace"
      onFocusCapture={(event) => {
        const topicId = getDomFocusedTopicId(event.target);
        if (topicId && topicId !== focusedTopicId) {
          onFocusedTopicIdChange(topicId);
          setFocusZone("list");
          setStagedQuestionOptionIdx(null);
        }
      }}
      className="relative h-full w-full overflow-hidden tabular-nums"
    >
      {isDesktop ? (
        <Group
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
          className="h-full w-full"
        >
          <Panel
            id="board-channels"
            defaultSize="20%"
            minSize="16%"
            maxSize="30%"
            className="h-full overflow-hidden"
          >
            {channelTreeNode(false)}
          </Panel>
          <Separator className="w-px bg-border transition-colors duration-150 hover:bg-[var(--status-running)]" />
          <Panel
            id="board-timeline"
            defaultSize="54%"
            minSize="34%"
            className="h-full overflow-hidden"
          >
            {timelineNode}
          </Panel>
          <Separator className="w-px bg-border transition-colors duration-150 hover:bg-[var(--status-running)]" />
          <Panel
            id="board-inspector"
            panelRef={inspectorPanelRef}
            collapsible
            collapsedSize={0}
            defaultSize="26%"
            minSize="20%"
            maxSize="42%"
            onResize={(panelSize) => setInspectorCollapsed(panelSize.asPercentage === 0)}
            className="h-full overflow-hidden"
          >
            {inspectorNode}
          </Panel>
        </Group>
      ) : (
        timelineNode
      )}

      {/* Mobile Sheet Drawers */}
      <Sheet open={mobileLeftOpen} onOpenChange={onMobileLeftOpenChange}>
        <SheetContent side="left" title="协同板频道与视图">
          {channelTreeNode(true)}
        </SheetContent>
      </Sheet>

      <Sheet open={mobileRightOpen} onOpenChange={onMobileRightOpenChange}>
        <SheetContent side="right" title="主题上下文与交接快照">
          {inspectorNode}
        </SheetContent>
      </Sheet>

      {/* New Topic Dialog */}
      <Dialog open={newTopicOpen} onOpenChange={setNewTopicOpen}>
        <DialogContent data-testid="board-new-topic-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-4 w-4 text-[var(--status-running)]" strokeWidth={1.75} aria-hidden="true" />
              新建协同主题
            </DialogTitle>
            <DialogDescription>
              创建跨机、跨会话协同主题；填写 external_ref 可按 (channel, external_ref) 幂等复用。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-xs">
            <div className="space-y-1">
              <label htmlFor="board-topic-channel" className="text-[11px] font-medium text-muted-foreground">
                频道路径（channel）
              </label>
              <Input
                id="board-topic-channel"
                value={newChannel}
                onChange={(e) => setNewChannel(e.target.value)}
                placeholder="例如：proj/demo 或 ops/fleet"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                data-testid="board-new-topic-channel-input"
                className="font-mono"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="board-topic-title" className="text-[11px] font-medium text-muted-foreground">
                主题标题（title）
              </label>
              <Input
                id="board-topic-title"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="例如：PR #42 接口契约与跨机联调"
                data-testid="board-new-topic-title-input"
              />
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor="board-topic-ref" className="text-[11px] font-medium text-muted-foreground">
                  外部锚点 external_ref（可选）
                </label>
                <Input
                  id="board-topic-ref"
                  value={newExternalRef}
                  onChange={(e) => setNewExternalRef(e.target.value)}
                  placeholder="例如：pr-42"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-testid="board-new-topic-ref-input"
                  className="font-mono"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground">初始状态</label>
                <Select value={newStatus} onValueChange={(v) => setNewStatus(v as BoardTopicStatus)}>
                  <SelectTrigger aria-label="初始状态">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="todo">待办 (todo)</SelectItem>
                    <SelectItem value="in_progress">进行中 (in_progress)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setNewTopicOpen(false)}
                className="min-h-11 sm:min-h-0 sm:h-8"
              >
                取消
              </Button>
              <Button
                type="button"
                disabled={creatingTopic || !newChannel.trim() || !newTitle.trim()}
                onClick={() => void handleSubmitNewTopic()}
                data-testid="board-create-topic-submit-btn"
                className="min-h-11 sm:min-h-0 sm:h-8"
              >
                {creatingTopic ? "创建中…" : "创建主题"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
