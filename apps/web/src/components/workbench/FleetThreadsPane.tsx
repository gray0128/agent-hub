import { useMemo, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FolderGit2,
  GitBranch,
  GripVertical,
  Pin,
  Plus,
  Search,
  Server
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ALL_AGENTS } from "@/lib/capabilities";
import { cn, formatShortTime } from "@/lib/utils";
import type { AgentName, NodeRecord, RunRecord, RunStatus, ThreadRecord, WorkspaceEntry } from "@/types";
import { NodeStatusDot } from "./StatusBadge";

type ThreadFilterMode = "all" | "active" | "needs_approval";
type FleetTabMode = "threads" | "nodes";

function statusDotClass(status?: RunStatus): string {
  switch (status) {
    case "running":
    case "claimed":
      return "bg-[var(--status-running)] animate-pulse";
    case "needs_approval":
      return "bg-[var(--status-approval)]";
    case "failed":
      return "bg-[var(--status-failed)]";
    case "done":
      return "bg-[var(--status-done)]";
    case "queued":
    case "cancelled":
    default:
      return "bg-muted-foreground/50";
  }
}

function statusShortLabel(status?: RunStatus): string | null {
  switch (status) {
    case "running":
    case "claimed":
      return "执行中";
    case "needs_approval":
      return "待审批";
    case "queued":
      return "排队";
    case "failed":
      return "失败";
    default:
      return null;
  }
}

function getNodeReadyAgents(node: NodeRecord): AgentName[] {
  const agentsMap = node.capabilities?.agents;
  if (!agentsMap) return [];
  return ALL_AGENTS.filter((agent) => {
    const cap = agentsMap[agent];
    return Boolean(cap && cap.enabled !== false && cap.available !== false);
  });
}

function DraggableWorkspaceChip({
  nodeId,
  ws,
  active,
  onSelect
}: {
  nodeId: string;
  ws: WorkspaceEntry;
  active: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `ws:${nodeId}:${ws.path}`,
    data: { type: "workspace", nodeId, workdir: ws.path }
  });

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onSelect}
      {...listeners}
      {...attributes}
      data-testid={`workspace-chip-${nodeId}-${ws.key}`}
      title={`${ws.path}（点击选中或拖拽至派发台）`}
      className={cn(
        "inline-flex min-h-11 md:min-h-0 max-w-full items-center gap-1 rounded-[5px] border px-2 py-1 text-[11px] font-mono transition-[color,background-color,border-color] duration-150 cursor-pointer",
        active
          ? "border-[var(--status-running)] bg-[var(--status-running)]/12 text-foreground"
          : "border-border bg-background/60 text-muted-foreground hover:border-foreground/30 hover:text-foreground",
        isDragging && "opacity-40"
      )}
    >
      <FolderGit2 className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      <span className="truncate max-w-[150px]">{ws.key}</span>
    </button>
  );
}

function SortableThreadRow({
  thread,
  latestRunStatus,
  selected,
  onSelect,
  onTogglePin,
  onFork
}: {
  thread: ThreadRecord;
  latestRunStatus?: RunStatus;
  selected: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
  onFork: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `thread:${thread.id}`,
    data: { type: "thread", threadId: thread.id, pinned: thread.pinned }
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  const stateHint = statusShortLabel(latestRunStatus);

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`thread-item-${thread.id}`}
      className={cn(
        "group flex items-start gap-1.5 border-b border-border px-2.5 py-2 transition-colors duration-150",
        selected
          ? "border-l-2 border-l-[var(--status-running)] bg-accent/80 pl-2"
          : "hover:bg-accent/40",
        isDragging && "opacity-40"
      )}
    >
      {/* 1st button child: drag handle (must remain 1st <button> for CDP eval selector) */}
      <button
        type="button"
        aria-label="拖拽排序会话"
        {...attributes}
        {...listeners}
        className="mt-0.5 inline-flex h-6 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:text-foreground cursor-grab active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
      </button>

      {/* 2nd button child: select thread (must remain 2nd <button> for CDP eval selector) */}
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 text-left cursor-pointer"
      >
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn("h-2 w-2 shrink-0 rounded-full", statusDotClass(latestRunStatus))}
              aria-hidden="true"
            />
            <span className="truncate text-xs font-medium text-foreground">
              {thread.title || thread.project_key || thread.id}
            </span>
          </div>
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
            {formatShortTime(thread.updated_at)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-1.5 text-[11px] font-mono text-muted-foreground">
          <span className="min-w-0 truncate">
            {thread.node_id} / {thread.project_key} · {thread.agent}
          </span>
          {stateHint ? (
            <span
              className={cn(
                "shrink-0 font-sans text-[10px] font-medium",
                latestRunStatus === "needs_approval" && "text-[var(--status-approval)]",
                (latestRunStatus === "running" || latestRunStatus === "claimed") && "text-[var(--status-running)]",
                latestRunStatus === "failed" && "text-[var(--status-failed)]"
              )}
            >
              {stateHint}
            </span>
          ) : null}
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={onTogglePin}
          aria-label={thread.pinned ? "取消置顶会话" : "置顶会话"}
          title={thread.pinned ? "取消置顶" : "置顶会话"}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-[5px] transition-colors duration-150 cursor-pointer",
            thread.pinned
              ? "text-[var(--status-approval)] bg-[var(--status-approval)]/10"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          <Pin className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onFork}
          aria-label="分叉会话"
          title="分叉会话"
          className="inline-flex h-7 w-7 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors duration-150 cursor-pointer"
        >
          <GitBranch className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export interface FleetThreadsPaneProps {
  nodes: NodeRecord[];
  selectedNodeId: string | null;
  threads: ThreadRecord[];
  runs: RunRecord[];
  selectedThreadId: string | null;
  activeWorkdir: string;
  activeTargetNodeId: string;
  threadQuery: string;
  inDrawer?: boolean;
  onThreadQueryChange: (q: string) => void;
  onSelectNode: (nodeId: string) => void;
  onPickWorkspace: (nodeId: string, workdir: string) => void;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
  onTogglePinThread: (thread: ThreadRecord) => void;
  onForkThread: (thread: ThreadRecord) => void;
}

export function FleetThreadsPane({
  nodes,
  selectedNodeId,
  threads,
  runs,
  selectedThreadId,
  activeWorkdir,
  activeTargetNodeId,
  threadQuery,
  inDrawer = false,
  onThreadQueryChange,
  onSelectNode,
  onPickWorkspace,
  onSelectThread,
  onNewThread,
  onTogglePinThread,
  onForkThread
}: FleetThreadsPaneProps) {
  const [leftTab, setLeftTab] = useState<FleetTabMode>("threads");
  const [collapsedNodes, setCollapsedNodes] = useState<Record<string, boolean>>({});
  const [statusFilter, setStatusFilter] = useState<ThreadFilterMode>("all");
  const [onlySelectedNode, setOnlySelectedNode] = useState(false);

  const latestRunByThread = useMemo(() => {
    const map = new Map<string, RunRecord>();
    for (const run of runs) {
      const prev = map.get(run.thread_id);
      if (!prev || run.created_at > prev.created_at) {
        map.set(run.thread_id, run);
      }
    }
    return map;
  }, [runs]);

  const { activeCount, approvalCount } = useMemo(() => {
    let active = 0;
    let approval = 0;
    for (const t of threads) {
      const st = latestRunByThread.get(t.id)?.status;
      if (st === "needs_approval") {
        approval += 1;
        active += 1;
      } else if (st === "running" || st === "claimed" || st === "queued") {
        active += 1;
      }
    }
    return { activeCount: active, approvalCount: approval };
  }, [latestRunByThread, threads]);

  const filteredThreads = useMemo(() => {
    const q = threadQuery.trim().toLowerCase();
    return threads.filter((t) => {
      if (onlySelectedNode && selectedNodeId && t.node_id !== selectedNodeId) {
        return false;
      }
      const st = latestRunByThread.get(t.id)?.status;
      if (statusFilter === "active") {
        if (st !== "running" && st !== "claimed" && st !== "queued" && st !== "needs_approval") {
          return false;
        }
      } else if (statusFilter === "needs_approval") {
        if (st !== "needs_approval") {
          return false;
        }
      }
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        t.node_id.toLowerCase().includes(q) ||
        t.project_key.toLowerCase().includes(q) ||
        t.agent.toLowerCase().includes(q)
      );
    });
  }, [latestRunByThread, onlySelectedNode, selectedNodeId, statusFilter, threadQuery, threads]);

  const onlineNodeCount = useMemo(
    () => nodes.filter((n) => n.status === "online").length,
    [nodes]
  );
  const totalWorkspaceCount = useMemo(
    () => nodes.reduce((sum, n) => sum + n.workspaces.length, 0),
    [nodes]
  );
  const nodesWithWorkspaces = useMemo(
    () => nodes.filter((n) => n.workspaces.length > 0),
    [nodes]
  );
  const hasExpandedNode = nodesWithWorkspaces.some((n) => !collapsedNodes[n.id]);
  const hasActiveFilter = Boolean(threadQuery.trim() || statusFilter !== "all" || onlySelectedNode);

  return (
    <aside
      aria-label="节点与会话列表"
      data-testid="fleet-threads-pane"
      className="relative flex h-full flex-col bg-surface-elevated overflow-hidden"
    >
      <Tabs
        value={leftTab}
        onValueChange={(v) => setLeftTab(v as FleetTabMode)}
        className="flex h-full flex-col overflow-hidden"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2.5 py-1.5">
          <TabsList className={cn("grid flex-1 grid-cols-2", inDrawer ? "h-10" : "h-8")}>
            <TabsTrigger
              value="threads"
              data-testid="fleet-tab-threads"
              className="gap-1.5 px-2 text-xs tabular-nums"
            >
              <span>会话</span>
              <span className="inline-block min-w-[1.1rem] rounded px-1 text-center text-[10px] leading-tight text-muted-foreground tabular-nums">
                {threads.length}
              </span>
            </TabsTrigger>
            <TabsTrigger
              value="nodes"
              data-testid="fleet-tab-nodes"
              className="gap-1.5 px-2 text-xs tabular-nums"
            >
              <span>节点</span>
              <span className="inline-block min-w-[1.1rem] rounded px-1 text-center text-[10px] leading-tight text-muted-foreground tabular-nums">
                {onlineNodeCount}/{nodes.length}
              </span>
            </TabsTrigger>
          </TabsList>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onNewThread}
            data-testid="new-thread-btn"
            className={cn("shrink-0 px-2 text-[11px]", inDrawer ? "h-10" : "h-8")}
          >
            <Plus className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
            新建会话
          </Button>
        </div>

        {/* Tab 1: Threads (search + status filter + sortable list) */}
        <TabsContent value="threads" className="mt-0 min-h-0 flex-1 flex flex-col overflow-hidden">
          <div className="shrink-0 space-y-1.5 border-b border-border px-2.5 py-2">
            <div className="relative flex items-center">
              <Search
                className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <Input
                aria-label="筛选会话"
                data-testid="thread-search-input"
                value={threadQuery}
                onChange={(e) => onThreadQueryChange(e.target.value)}
                placeholder="搜索会话标题、节点或目录..."
                className="h-8 pl-8 text-xs"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                aria-pressed={statusFilter === "all"}
                onClick={() => setStatusFilter("all")}
                className={cn(
                  "inline-flex h-6 items-center rounded-[4px] border px-2 text-[10px] font-medium transition-colors duration-150 cursor-pointer tabular-nums",
                  statusFilter === "all"
                    ? "border-[var(--status-running)]/50 bg-[var(--status-running)]/12 text-foreground"
                    : "border-border bg-background/50 text-muted-foreground hover:text-foreground"
                )}
              >
                全部 {threads.length}
              </button>
              <button
                type="button"
                aria-pressed={statusFilter === "active"}
                onClick={() => setStatusFilter((prev) => (prev === "active" ? "all" : "active"))}
                className={cn(
                  "inline-flex h-6 items-center rounded-[4px] border px-2 text-[10px] font-medium transition-colors duration-150 cursor-pointer tabular-nums",
                  statusFilter === "active"
                    ? "border-[var(--status-running)]/50 bg-[var(--status-running)]/12 text-foreground"
                    : "border-border bg-background/50 text-muted-foreground hover:text-foreground"
                )}
              >
                进行中 {activeCount}
              </button>
              <button
                type="button"
                aria-pressed={statusFilter === "needs_approval"}
                onClick={() =>
                  setStatusFilter((prev) => (prev === "needs_approval" ? "all" : "needs_approval"))
                }
                className={cn(
                  "inline-flex h-6 items-center rounded-[4px] border px-2 text-[10px] font-medium transition-colors duration-150 cursor-pointer tabular-nums",
                  statusFilter === "needs_approval"
                    ? "border-[var(--status-approval)]/60 bg-[var(--status-approval)]/15 text-[var(--status-approval)]"
                    : "border-border bg-background/50 text-muted-foreground hover:text-foreground"
                )}
              >
                待审批 {approvalCount}
              </button>
              {selectedNodeId ? (
                <button
                  type="button"
                  aria-pressed={onlySelectedNode}
                  onClick={() => setOnlySelectedNode((prev) => !prev)}
                  className={cn(
                    "ml-auto inline-flex h-6 items-center rounded-[4px] border px-2 text-[10px] font-mono transition-colors duration-150 cursor-pointer",
                    onlySelectedNode
                      ? "border-foreground/40 bg-accent text-foreground"
                      : "border-border bg-background/50 text-muted-foreground hover:text-foreground"
                  )}
                >
                  仅 {selectedNodeId}
                </button>
              ) : null}
            </div>
          </div>

          <div className="relative min-h-0 flex-1 overflow-y-auto">
            {filteredThreads.length === 0 ? (
              <div className="space-y-2 px-3 py-6 text-center text-xs text-muted-foreground text-pretty">
                <p>
                  {hasActiveFilter
                    ? "当前筛选条件下没有匹配的会话或任务。尝试清除节点或状态筛选条件。"
                    : "暂无历史会话"}
                </p>
                {hasActiveFilter ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onThreadQueryChange("");
                      setStatusFilter("all");
                      setOnlySelectedNode(false);
                    }}
                  >
                    清除筛选
                  </Button>
                ) : null}
              </div>
            ) : (
              <SortableContext
                items={filteredThreads.map((t) => `thread:${t.id}`)}
                strategy={verticalListSortingStrategy}
              >
                {filteredThreads.map((thread) => (
                  <SortableThreadRow
                    key={thread.id}
                    thread={thread}
                    latestRunStatus={latestRunByThread.get(thread.id)?.status}
                    selected={selectedThreadId === thread.id}
                    onSelect={() => onSelectThread(thread.id)}
                    onTogglePin={() => onTogglePinThread(thread)}
                    onFork={() => onForkThread(thread)}
                  />
                ))}
              </SortableContext>
            )}
          </div>
        </TabsContent>

        {/* Tab 2: Nodes (per-node collapsible workspaces + drag/pick target) */}
        <TabsContent value="nodes" className="mt-0 min-h-0 flex-1 flex flex-col overflow-hidden">
          {nodes.length > 0 ? (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground tabular-nums">
              <span>
                {onlineNodeCount}/{nodes.length} 在线 · {totalWorkspaceCount} 目录
              </span>
              {nodesWithWorkspaces.length > 0 ? (
                <button
                  type="button"
                  data-testid="toggle-all-node-ws"
                  onClick={() => {
                    const nextCollapsed: Record<string, boolean> = {};
                    for (const n of nodesWithWorkspaces) {
                      nextCollapsed[n.id] = hasExpandedNode;
                    }
                    setCollapsedNodes(nextCollapsed);
                  }}
                  className="inline-flex items-center gap-1 rounded-[4px] border border-border bg-background/60 px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-accent transition-colors duration-150 cursor-pointer"
                >
                  {hasExpandedNode ? (
                    <>
                      全部收起
                      <ChevronUp className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                    </>
                  ) : (
                    <>
                      全部展开
                      <ChevronDown className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                    </>
                  )}
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="relative min-h-0 flex-1 overflow-y-auto divide-y divide-border">
            {nodes.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">暂无在线或历史节点</div>
            ) : (
              nodes.map((node) => {
                const isSelected = selectedNodeId === node.id;
                const totalWs = node.workspaces.length;
                const isWsCollapsed = Boolean(collapsedNodes[node.id]);
                const readyAgents = getNodeReadyAgents(node);

                return (
                  <div
                    key={node.id}
                    data-testid={`node-row-${node.id}`}
                    data-node-status={node.status}
                    className={cn(
                      "px-3 py-2.5 transition-colors duration-150",
                      isSelected ? "bg-accent/60" : "hover:bg-accent/30"
                    )}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <button
                        type="button"
                        data-testid={`select-node-${node.id}`}
                        onClick={() => onSelectNode(node.id)}
                        className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left cursor-pointer"
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          <NodeStatusDot status={node.status} />
                          <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
                          <span className="truncate text-xs font-medium text-foreground">
                            {node.display_name || node.id}
                          </span>
                          {node.display_name && node.display_name !== node.id ? (
                            <span className="truncate text-[10px] text-muted-foreground font-mono">
                              {node.id}
                            </span>
                          ) : null}
                        </div>
                        <span className="shrink-0 text-[11px] font-mono text-muted-foreground tabular-nums">
                          {node.active_runs_count}/{node.max_concurrency}
                        </span>
                      </button>

                      {totalWs > 0 ? (
                        <button
                          type="button"
                          data-testid={`toggle-ws-${node.id}`}
                          aria-expanded={!isWsCollapsed}
                          aria-label={isWsCollapsed ? `展开 ${node.id} 工作目录` : `收起 ${node.id} 工作目录`}
                          onClick={() =>
                            setCollapsedNodes((prev) => ({
                              ...prev,
                              [node.id]: !isWsCollapsed
                            }))
                          }
                          className="inline-flex shrink-0 items-center gap-1 rounded-[5px] border border-border bg-background/60 px-2 py-0.5 text-[10px] font-mono text-muted-foreground hover:border-foreground/30 hover:text-foreground transition-colors duration-150 tabular-nums cursor-pointer"
                        >
                          <span>{totalWs} 目录</span>
                          {isWsCollapsed ? (
                            <ChevronRight className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                          ) : (
                            <ChevronDown className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                          )}
                        </button>
                      ) : null}
                    </div>

                    {readyAgents.length > 0 ? (
                      <div className="mt-1 truncate pl-5 font-mono text-[10px] text-muted-foreground">
                        {readyAgents.join(" · ")}
                      </div>
                    ) : null}

                    {!isWsCollapsed && totalWs > 0 ? (
                      <div
                        data-testid={`node-workspaces-${node.id}`}
                        className="mt-2 flex flex-wrap items-center gap-1"
                      >
                        {node.workspaces.map((ws) => (
                          <DraggableWorkspaceChip
                            key={`${node.id}-${ws.path}`}
                            nodeId={node.id}
                            ws={ws}
                            active={activeTargetNodeId === node.id && activeWorkdir === ws.path}
                            onSelect={() => onPickWorkspace(node.id, ws.path)}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </TabsContent>
      </Tabs>
    </aside>
  );
}
