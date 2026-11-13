import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Activity, GitFork, GripVertical, ListOrdered, PauseCircle, PlayCircle, Sliders, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, formatShortTime } from "@/lib/utils";
import type { InspectorTab } from "@/stores/workbench-store";
import type { NodeRecord, RunEventItem, RunRecord } from "@/types";
import { NodeStatusDot, RunStatusBadge } from "./StatusBadge";

function SortableQueuedRunRow({
  run,
  onSelect
}: {
  run: RunRecord;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `queued:${run.id}`,
    data: { type: "queued", runId: run.id, nodeId: run.node_id }
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`queued-item-${run.id}`}
      className={cn(
        "flex items-center gap-2 border-b border-border px-2.5 py-2 hover:bg-accent/40 transition-colors duration-150",
        isDragging && "opacity-60"
      )}
    >
      <button
        type="button"
        aria-label="拖拽调整队列优先级"
        {...attributes}
        {...listeners}
        className="inline-flex h-7 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>

      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left cursor-pointer">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-mono text-foreground">{run.id}</span>
          <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
            prio {run.priority_order}
          </span>
        </div>
        <div className="truncate text-[11px] text-muted-foreground font-mono">
          {run.node_id} · {run.agent} · {run.workdir.split("/").pop()}
        </div>
      </button>
    </div>
  );
}

export interface InspectorPaneProps {
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  selectedRun: RunRecord | null;
  allRuns: RunRecord[];
  selectedNode: NodeRecord | null;
  events: RunEventItem[];
  onSelectRun: (runId: string) => void;
  onCancelRun: (runId: string, cascade: boolean) => void;
  onToggleNodeDrain: (node: NodeRecord) => void;
  onUpdateNodeConcurrency: (nodeId: string, maxConcurrency: number) => void;
}

export function InspectorPane({
  activeTab,
  onTabChange,
  selectedRun,
  allRuns,
  selectedNode,
  events,
  onSelectRun,
  onCancelRun,
  onToggleNodeDrain,
  onUpdateNodeConcurrency
}: InspectorPaneProps) {
  const queuedRuns = allRuns
    .filter((r) => r.status === "queued")
    .sort((a, b) => a.priority_order - b.priority_order);

  const rootRunId = selectedRun?.root_run_id;
  const lineageRuns = rootRunId
    ? allRuns
        .filter((r) => r.root_run_id === rootRunId)
        .sort((a, b) => a.depth - b.depth || a.created_at.localeCompare(b.created_at))
    : [];

  return (
    <aside
      data-testid="inspector-pane"
      className="flex h-full flex-col bg-surface-elevated overflow-hidden"
    >
      <Tabs
        value={activeTab}
        onValueChange={(v) => onTabChange(v as InspectorTab)}
        className="flex h-full flex-col overflow-hidden"
      >
        <div className="shrink-0 border-b border-border px-2.5 py-1.5">
          <TabsList className="grid w-full grid-cols-4 h-8">
            <TabsTrigger value="events" className="gap-1 px-1.5 text-[11px]">
              <Activity className="h-3 w-3 hidden sm:inline" strokeWidth={1.75} />
              过程事件
            </TabsTrigger>
            <TabsTrigger value="queue" className="gap-1 px-1.5 text-[11px]">
              <ListOrdered className="h-3 w-3 hidden sm:inline" strokeWidth={1.75} />
              待跑队列
            </TabsTrigger>
            <TabsTrigger value="lineage" className="gap-1 px-1.5 text-[11px]">
              <GitFork className="h-3 w-3 hidden sm:inline" strokeWidth={1.75} />
              委派拓扑
            </TabsTrigger>
            <TabsTrigger value="control" className="gap-1 px-1.5 text-[11px]">
              <Sliders className="h-3 w-3 hidden sm:inline" strokeWidth={1.75} />
              节点控制
            </TabsTrigger>
          </TabsList>
        </div>

        {/* 1. Process Events (<= 500 ring buffer) */}
        <TabsContent value="events" className="mt-0 min-h-0 flex-1 flex flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2 text-[11px] text-muted-foreground tabular-nums">
            <span>
              {selectedRun ? `${selectedRun.id} · ${events.length} 条缓冲` : "未选择任务"}
            </span>
            {selectedRun &&
            (selectedRun.status === "queued" ||
              selectedRun.status === "claimed" ||
              selectedRun.status === "running" ||
              selectedRun.status === "needs_approval") ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => onCancelRun(selectedRun.id, false)}
                className="h-7 px-2 text-[11px]"
              >
                取消任务
              </Button>
            ) : null}
          </div>

          <div
            data-testid="events-feed"
            data-event-count={events.length}
            className="min-h-0 flex-1 overflow-y-auto divide-y divide-border font-mono text-[11px]"
          >
            {events.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs font-sans text-muted-foreground">
                暂无过程事件
              </div>
            ) : (
              events.map((ev) => (
                <div key={ev.seq} data-testid="event-row" className="px-3 py-1.5">
                  <div className="flex items-center justify-between gap-2 text-muted-foreground tabular-nums">
                    <span>
                      #{ev.seq} · {ev.kind}
                    </span>
                    <span>{formatShortTime(ev.ts ?? ev.created_at)}</span>
                  </div>
                  <div className="mt-0.5 truncate text-foreground/90">
                    {JSON.stringify(ev.payload)}
                  </div>
                </div>
              ))
            )}
          </div>
        </TabsContent>

        {/* 2. Queued Priority Reorder */}
        <TabsContent value="queue" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          {queuedRuns.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              当前无待执行排队任务
            </div>
          ) : (
            <SortableContext
              items={queuedRuns.map((r) => `queued:${r.id}`)}
              strategy={verticalListSortingStrategy}
            >
              {queuedRuns.map((run) => (
                <SortableQueuedRunRow
                  key={run.id}
                  run={run}
                  onSelect={() => onSelectRun(run.id)}
                />
              ))}
            </SortableContext>
          )}
        </TabsContent>

        {/* 3. Delegation Lineage Tree */}
        <TabsContent value="lineage" className="mt-0 min-h-0 flex-1 overflow-y-auto divide-y divide-border">
          {lineageRuns.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              选择任务查看跨机委派拓扑树
            </div>
          ) : (
            lineageRuns.map((r) => (
              <div
                key={r.id}
                onClick={() => onSelectRun(r.id)}
                style={{ paddingLeft: `${12 + r.depth * 18}px` }}
                className={cn(
                  "flex items-center justify-between gap-2 pr-3 py-2 cursor-pointer hover:bg-accent/40 transition-colors duration-150",
                  selectedRun?.id === r.id && "bg-accent/60"
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
                      D{r.depth}
                    </span>
                    <span className="truncate text-xs font-mono text-foreground">{r.id}</span>
                  </div>
                  <div className="truncate text-[11px] font-mono text-muted-foreground">
                    {r.node_id}:{r.workdir.split("/").pop()} ({r.agent})
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <RunStatusBadge status={r.status} />
                  {r.depth === 0 && lineageRuns.length > 1 ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCancelRun(r.id, true);
                      }}
                      title="级联取消整棵树"
                      className="h-7 px-2 text-[10px]"
                    >
                      <XCircle className="h-3 w-3" strokeWidth={1.75} />
                      级联取消整棵树
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </TabsContent>

        {/* 4. Node Control */}
        <TabsContent value="control" className="mt-0 min-h-0 flex-1 overflow-y-auto p-3">
          {!selectedNode ? (
            <div className="py-6 text-center text-xs text-muted-foreground">请从左侧选择节点</div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-border pb-2.5">
                <div>
                  <div className="text-xs font-semibold text-foreground">{selectedNode.display_name}</div>
                  <div className="text-[11px] font-mono text-muted-foreground">
                    {selectedNode.id} · {selectedNode.os}/{selectedNode.arch} · {selectedNode.version || "dev"}
                  </div>
                </div>
                <NodeStatusDot status={selectedNode.status} />
              </div>

              <div className="flex items-center justify-between border-b border-border pb-2.5 text-xs">
                <span className="text-muted-foreground">运行调度</span>
                <Button
                  type="button"
                  size="sm"
                  variant={selectedNode.status === "draining" ? "default" : "outline"}
                  onClick={() => onToggleNodeDrain(selectedNode)}
                >
                  {selectedNode.status === "draining" ? (
                    <>
                      <PlayCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
                      恢复派发
                    </>
                  ) : (
                    <>
                      <PauseCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
                      排空节点
                    </>
                  )}
                </Button>
              </div>

              <div className="flex items-center justify-between border-b border-border pb-2.5 text-xs">
                <label htmlFor="node-max-concurrency" className="text-muted-foreground">
                  最大并发
                </label>
                <div className="flex items-center gap-1.5">
                  <Input
                    id="node-max-concurrency"
                    type="number"
                    min={1}
                    max={16}
                    defaultValue={selectedNode.max_concurrency}
                    key={`${selectedNode.id}-${selectedNode.max_concurrency}`}
                    onBlur={(e) => {
                      const val = Number.parseInt(e.target.value, 10);
                      if (Number.isFinite(val) && val >= 1 && val <= 16 && val !== selectedNode.max_concurrency) {
                        onUpdateNodeConcurrency(selectedNode.id, val);
                      }
                    }}
                    className="h-8 w-16 text-right font-mono tabular-nums"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-[11px] font-medium text-muted-foreground">已上报工作区</div>
                <div className="divide-y divide-border border-t border-b border-border">
                  {selectedNode.workspaces.map((ws) => (
                    <div key={ws.path} className="flex items-center justify-between py-1.5 text-[11px] font-mono">
                      <span className="truncate text-foreground">{ws.key}</span>
                      <span className="truncate max-w-[160px] text-muted-foreground">{ws.path}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </aside>
  );
}
