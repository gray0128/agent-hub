import { useMemo } from "react";
import { useDraggable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FolderGit2, GitBranch, GripVertical, Pin, Plus, Search, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, formatShortTime } from "@/lib/utils";
import type { NodeRecord, ThreadRecord, WorkspaceEntry } from "@/types";
import { NodeStatusDot } from "./StatusBadge";

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
      title={`${ws.path}（点击或拖拽至派发台）`}
      className={cn(
        "inline-flex min-h-11 md:min-h-0 items-center gap-1 rounded-[5px] border px-2 py-1 text-[11px] font-mono transition-colors duration-150 cursor-pointer",
        active
          ? "border-[var(--status-running)] bg-[var(--status-running)]/12 text-foreground"
          : "border-border bg-background/60 text-muted-foreground hover:border-foreground/30 hover:text-foreground",
        isDragging && "opacity-50"
      )}
    >
      <FolderGit2 className="h-3 w-3 shrink-0" strokeWidth={1.75} />
      <span className="truncate max-w-[130px]">{ws.key}</span>
    </button>
  );
}

function SortableThreadRow({
  thread,
  selected,
  onSelect,
  onTogglePin,
  onFork
}: {
  thread: ThreadRecord;
  selected: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
  onFork: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `thread:${thread.id}`,
    data: { type: "thread", threadId: thread.id }
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`thread-item-${thread.id}`}
      className={cn(
        "group flex items-start gap-1.5 border-b border-border px-2.5 py-2 transition-colors duration-150",
        selected ? "bg-accent/80" : "hover:bg-accent/40",
        isDragging && "opacity-60"
      )}
    >
      <button
        type="button"
        aria-label="拖拽排序会话"
        {...attributes}
        {...listeners}
        className="mt-0.5 inline-flex h-6 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:text-foreground cursor-grab active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>

      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 text-left cursor-pointer"
      >
        <div className="flex items-center justify-between gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">
            {thread.title || thread.project_key || thread.id}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
            {formatShortTime(thread.updated_at)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono">
          <span className="truncate">{thread.node_id}</span>
          <span>/</span>
          <span className="truncate">{thread.project_key}</span>
          <span>·</span>
          <span>{thread.agent}</span>
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={onTogglePin}
          aria-label="置顶会话"
          title="置顶会话"
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-[5px] transition-colors duration-150 cursor-pointer",
            thread.pinned
              ? "text-[var(--status-approval)] bg-[var(--status-approval)]/10"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          <Pin className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={onFork}
          aria-label="分叉会话"
          title="分叉会话"
          className="inline-flex h-7 w-7 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors duration-150 cursor-pointer"
        >
          <GitBranch className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

export interface FleetThreadsPaneProps {
  nodes: NodeRecord[];
  selectedNodeId: string | null;
  threads: ThreadRecord[];
  selectedThreadId: string | null;
  activeWorkdir: string;
  activeTargetNodeId: string;
  threadQuery: string;
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
  selectedThreadId,
  activeWorkdir,
  activeTargetNodeId,
  threadQuery,
  onThreadQueryChange,
  onSelectNode,
  onPickWorkspace,
  onSelectThread,
  onNewThread,
  onTogglePinThread,
  onForkThread
}: FleetThreadsPaneProps) {
  const filteredThreads = useMemo(() => {
    const q = threadQuery.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.node_id.toLowerCase().includes(q) ||
        t.project_key.toLowerCase().includes(q) ||
        t.agent.toLowerCase().includes(q)
    );
  }, [threads, threadQuery]);

  return (
    <aside
      data-testid="fleet-threads-pane"
      className="flex h-full flex-col bg-surface-elevated overflow-hidden"
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-semibold tracking-tight text-foreground">节点与会话</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onNewThread}
          className="h-7 px-2 text-[11px]"
        >
          <Plus className="h-3 w-3" strokeWidth={1.75} />
          新建会话
        </Button>
      </div>

      {/* Node directory + workspace chips */}
      <div className="max-h-[44%] overflow-y-auto border-b border-border divide-y divide-border">
        {nodes.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground">暂无在线或历史节点</div>
        ) : (
          nodes.map((node) => {
            const isSelected = selectedNodeId === node.id;
            return (
              <div
                key={node.id}
                data-testid={`node-row-${node.id}`}
                data-node-status={node.status}
                className={cn(
                  "px-3 py-2 transition-colors duration-150",
                  isSelected ? "bg-accent/60" : "hover:bg-accent/30"
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelectNode(node.id)}
                  className="flex w-full items-center justify-between gap-2 text-left cursor-pointer"
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                    <span className="truncate text-xs font-medium text-foreground">
                      {node.display_name || node.id}
                    </span>
                    <span className="text-[10px] text-muted-foreground font-mono">{node.id}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-[11px] font-mono text-muted-foreground tabular-nums">
                      {node.active_runs_count}/{node.max_concurrency}
                    </span>
                    <NodeStatusDot status={node.status} />
                  </div>
                </button>

                {node.workspaces.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1">
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

      {/* Thread search + sortable list */}
      <div className="shrink-0 border-b border-border px-2.5 py-2">
        <div className="relative flex items-center">
          <Search
            className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground"
            strokeWidth={1.75}
          />
          <Input
            aria-label="筛选会话"
            value={threadQuery}
            onChange={(e) => onThreadQueryChange(e.target.value)}
            placeholder="搜索会话标题、节点或目录..."
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filteredThreads.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">暂无匹配会话</div>
        ) : (
          <SortableContext
            items={filteredThreads.map((t) => `thread:${t.id}`)}
            strategy={verticalListSortingStrategy}
          >
            {filteredThreads.map((thread) => (
              <SortableThreadRow
                key={thread.id}
                thread={thread}
                selected={selectedThreadId === thread.id}
                onSelect={() => onSelectThread(thread.id)}
                onTogglePin={() => onTogglePinThread(thread)}
                onFork={() => onForkThread(thread)}
              />
            ))}
          </SortableContext>
        )}
      </div>
    </aside>
  );
}
