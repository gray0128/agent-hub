import { useMemo, useState } from "react";
import { Group, type LayoutStorage, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { Plus } from "lucide-react";
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
import type { BoardTopicFilter } from "@/stores/board-store";
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
import { BoardTopicInspector } from "./BoardTopicInspector";
import { BoardTopicTimeline } from "./BoardTopicTimeline";

export interface BoardWorkspaceProps {
  channels: BoardChannelSummary[];
  topics: BoardTopic[];
  messagesByTopicId: Record<string, BoardMessage[]>;
  openBoardQuestionCount: number;
  selectedChannel: string | null;
  selectedTopicId: string | null;
  topicFilter: BoardTopicFilter;
  searchQuery: string;
  boardPermissionDenied: boolean;
  authScope: AuthScope | null;
  isDesktop: boolean;
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
  onSelectTopic: (topicId: string) => void;
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

export function BoardWorkspace({
  channels,
  topics,
  messagesByTopicId,
  openBoardQuestionCount,
  selectedChannel,
  selectedTopicId,
  topicFilter,
  searchQuery,
  boardPermissionDenied,
  authScope,
  isDesktop,
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
  onSelectTopic,
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

  const timelineNode = (
    <BoardTopicTimeline
      topics={topics}
      selectedChannel={selectedChannel}
      selectedTopic={selectedTopic}
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
      onSelectTopic={(tid) => {
        onSelectTopic(tid);
        if (!isDesktop) {
          onMobileShowDetailChange(true);
        }
      }}
      onMobileBackToList={() => onMobileShowDetailChange(false)}
      onToggleInspector={handleToggleInspector}
      onOpenNewTopic={handleOpenNewTopic}
      onPostMessage={onPostMessage}
      onAnswerQuestion={onAnswerQuestion}
    />
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
