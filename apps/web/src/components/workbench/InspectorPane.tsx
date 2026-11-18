import { useEffect, useMemo, useState } from "react";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  GitFork,
  GripVertical,
  ListOrdered,
  PauseCircle,
  PlayCircle,
  Search,
  Send,
  Sliders,
  XCircle
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  cn,
  type EventTone,
  formatLeaseRemainingSec,
  formatShortTime,
  summarizeRunEvent
} from "@/lib/utils";
import type { InspectorTab } from "@/stores/workbench-store";
import type { ApiKeyRecord, NodeRecord, RunEventItem, RunRecord } from "@/types";
import { CopyButton } from "./CopyButton";
import { NodeStatusDot, RunStatusBadge } from "./StatusBadge";

function toneBadgeClass(tone: EventTone): string {
  switch (tone) {
    case "running":
      return "border-[var(--status-running)]/35 bg-[var(--status-running)]/10 text-[var(--status-running)]";
    case "warn":
      return "border-[var(--status-failed)]/35 bg-[var(--status-failed)]/10 text-[var(--status-failed)]";
    case "approval":
      return "border-[var(--status-approval)]/40 bg-[var(--status-approval)]/12 text-[var(--status-approval)]";
    case "done":
      return "border-[var(--status-done)]/35 bg-[var(--status-done)]/10 text-[var(--status-done)]";
    case "neutral":
    default:
      return "border-border bg-muted/60 text-muted-foreground";
  }
}

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
        isDragging && "opacity-40"
      )}
    >
      <button
        type="button"
        aria-label="拖拽调整队列优先级"
        {...attributes}
        {...listeners}
        className="inline-flex h-7 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
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
  botKeys?: ApiKeyRecord[];
  events: RunEventItem[];
  onSelectRun: (runId: string) => void;
  onCancelRun: (runId: string, cascade: boolean) => void;
  onToggleNodeDrain: (node: NodeRecord) => void;
  onUpdateNodeConcurrency: (nodeId: string, maxConcurrency: number) => void;
  onUpdateNodeDefaultNotify?: (nodeId: string, keyId: string | null) => void;
  onPickWorkspace: (nodeId: string, workdir: string) => void;
}

const UNBOUND_NOTIFY_VALUE = "__unbound__";

export function InspectorPane({
  activeTab,
  onTabChange,
  selectedRun,
  allRuns,
  selectedNode,
  botKeys = [],
  events,
  onSelectRun,
  onCancelRun,
  onToggleNodeDrain,
  onUpdateNodeConcurrency,
  onUpdateNodeDefaultNotify,
  onPickWorkspace
}: InspectorPaneProps) {
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});
  const [wsQuery, setWsQuery] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());

  const runIsActive = Boolean(
    selectedRun &&
      (selectedRun.status === "queued" ||
        selectedRun.status === "claimed" ||
        selectedRun.status === "running" ||
        selectedRun.status === "needs_approval")
  );
  const hasLease = Boolean(runIsActive && selectedRun?.lease_expires_at);

  useEffect(() => {
    if (!hasLease) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasLease]);

  const leaseText = useMemo(() => {
    if (!hasLease || !selectedRun?.lease_expires_at) return null;
    return formatLeaseRemainingSec(selectedRun.lease_expires_at, nowMs);
  }, [hasLease, nowMs, selectedRun?.lease_expires_at]);

  const queuedRuns = useMemo(
    () =>
      allRuns
        .filter((r) => r.status === "queued")
        .sort((a, b) => a.priority_order - b.priority_order),
    [allRuns]
  );

  const rootRunId = selectedRun?.root_run_id;
  const lineageRuns = useMemo(
    () =>
      rootRunId
        ? allRuns
            .filter((r) => r.root_run_id === rootRunId)
            .sort((a, b) => a.depth - b.depth || a.created_at.localeCompare(b.created_at))
        : [],
    [allRuns, rootRunId]
  );

  const filteredWorkspaces = useMemo(() => {
    const list = selectedNode?.workspaces ?? [];
    const q = wsQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (ws) => ws.key.toLowerCase().includes(q) || ws.path.toLowerCase().includes(q)
    );
  }, [selectedNode?.workspaces, wsQuery]);

  const agentCapabilities = useMemo(() => {
    const map = selectedNode?.capabilities?.agents ?? {};
    return Object.entries(map).filter(([, cfg]) => cfg.enabled !== false && cfg.available !== false);
  }, [selectedNode?.capabilities?.agents]);

  const eligibleBotKeys = useMemo(() => {
    if (!selectedNode) return [];
    return botKeys.filter(
      (k) =>
        k.scope === "client" &&
        k.revoked_at === null &&
        k.has_webhook &&
        (k.allowed_nodes.length === 0 || k.allowed_nodes.includes(selectedNode.id))
    );
  }, [botKeys, selectedNode]);

  return (
    <aside
      aria-label="实时检视与节点控制"
      data-testid="inspector-pane"
      className="relative flex h-full flex-col bg-surface-elevated overflow-hidden"
    >
      <Tabs
        value={activeTab}
        onValueChange={(v) => onTabChange(v as InspectorTab)}
        className="flex h-full flex-col overflow-hidden"
      >
        <div className="shrink-0 border-b border-border px-2.5 py-1.5">
          <TabsList className="grid w-full grid-cols-4 h-8">
            <TabsTrigger value="events" className="gap-1 px-1 text-[11px]">
              <Activity className="h-3 w-3 hidden sm:inline" strokeWidth={1.75} aria-hidden="true" />
              过程事件
            </TabsTrigger>
            <TabsTrigger value="queue" className="gap-1 px-1 text-[11px] tabular-nums">
              <ListOrdered className="h-3 w-3 hidden sm:inline" strokeWidth={1.75} aria-hidden="true" />
              <span>待跑队列</span>
              <span
                className={cn(
                  "inline-block min-w-[1.1rem] rounded px-1 text-center text-[10px] leading-tight tabular-nums",
                  queuedRuns.length > 0 ? "bg-foreground/10 text-foreground" : "text-muted-foreground/60"
                )}
              >
                {queuedRuns.length}
              </span>
            </TabsTrigger>
            <TabsTrigger value="lineage" className="gap-1 px-1 text-[11px]">
              <GitFork className="h-3 w-3 hidden sm:inline" strokeWidth={1.75} aria-hidden="true" />
              委派拓扑
            </TabsTrigger>
            <TabsTrigger value="control" className="gap-1 px-1 text-[11px]">
              <Sliders className="h-3 w-3 hidden sm:inline" strokeWidth={1.75} aria-hidden="true" />
              节点控制
            </TabsTrigger>
          </TabsList>
        </div>

        {/* 1. Process Events (<= 500 ring buffer) */}
        <TabsContent value="events" className="mt-0 min-h-0 flex-1 flex flex-col overflow-hidden">
          <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3 text-[11px] text-muted-foreground tabular-nums">
            <span className="truncate font-mono">
              {selectedRun ? `${selectedRun.id} · ${events.length} 条缓冲` : "未选择任务"}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              {leaseText ? (
                <span
                  data-testid="lease-countdown"
                  className="rounded-[4px] border border-[var(--status-running)]/35 bg-[var(--status-running)]/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--status-running)] tabular-nums"
                >
                  租约 {leaseText}
                </span>
              ) : null}
              {selectedRun && runIsActive ? (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => onCancelRun(selectedRun.id, false)}
                  className="h-6 px-2 text-[11px]"
                >
                  取消任务
                </Button>
              ) : null}
            </div>
          </div>

          <div
            data-testid="events-feed"
            data-event-count={events.length}
            className="relative min-h-0 flex-1 overflow-y-auto divide-y divide-border font-mono text-[11px]"
          >
            {events.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs font-sans text-muted-foreground">
                暂无过程事件
              </div>
            ) : (
              events.map((ev) => {
                const evKey = `${selectedRun?.id ?? "none"}:${ev.seq}`;
                const expanded = Boolean(expandedEvents[evKey]);
                const info = summarizeRunEvent(ev);

                return (
                  <div key={ev.seq} data-testid="event-row">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() =>
                        setExpandedEvents((prev) => ({ ...prev, [evKey]: !expanded }))
                      }
                      className="w-full px-3 py-1.5 text-left hover:bg-accent/35 transition-colors duration-150 cursor-pointer"
                    >
                      <div className="flex items-center justify-between gap-2 tabular-nums">
                        <div className="flex min-w-0 items-center gap-1.5">
                          {expanded ? (
                            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                          )}
                          <span className="shrink-0 text-[10px] text-muted-foreground">#{ev.seq}</span>
                          <span
                            className={cn(
                              "shrink-0 rounded-[4px] border px-1.5 py-px font-sans text-[10px] font-medium leading-tight",
                              toneBadgeClass(info.tone)
                            )}
                          >
                            {info.badge}
                          </span>
                        </div>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {formatShortTime(ev.ts ?? ev.created_at)}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate pl-4 text-foreground/90">
                        {info.summary}
                      </div>
                    </button>

                    {expanded ? (
                      <pre className="mx-3 mb-2 overflow-x-auto rounded-[5px] border border-border bg-background/70 p-2 text-[10px] leading-relaxed text-foreground/90 whitespace-pre-wrap break-all">
                        {JSON.stringify(ev.payload, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </TabsContent>

        {/* 2. Queued Priority Reorder */}
        <TabsContent value="queue" className="relative mt-0 min-h-0 flex-1 overflow-y-auto">
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
        <TabsContent value="lineage" className="relative mt-0 min-h-0 flex-1 overflow-y-auto divide-y divide-border">
          {lineageRuns.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              选择任务查看跨机委派拓扑树
            </div>
          ) : (
            lineageRuns.map((r) => (
              <div
                key={r.id}
                style={{ paddingLeft: `${12 + r.depth * 18}px` }}
                className={cn(
                  "flex items-center justify-between gap-2 pr-3 py-2 hover:bg-accent/40 transition-colors duration-150",
                  selectedRun?.id === r.id && "bg-accent/60"
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelectRun(r.id)}
                  className="min-w-0 flex-1 text-left cursor-pointer"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
                      D{r.depth}
                    </span>
                    <span className="truncate text-xs font-mono text-foreground">{r.id}</span>
                  </div>
                  <div className="truncate text-[11px] font-mono text-muted-foreground">
                    {r.node_id}:{r.workdir.split("/").pop()} ({r.agent})
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-1.5">
                  <RunStatusBadge status={r.status} />
                  {r.depth === 0 && lineageRuns.length > 1 ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onCancelRun(r.id, true)}
                      title="级联取消整棵树"
                      className="h-7 px-2 text-[10px]"
                    >
                      <XCircle className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                      级联取消整棵树
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </TabsContent>

        {/* 4. Node Control */}
        <TabsContent value="control" className="relative mt-0 min-h-0 flex-1 overflow-y-auto p-3">
          {!selectedNode ? (
            <div className="py-6 text-center text-xs text-muted-foreground">请从左侧选择节点</div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2 border-b border-border pb-2.5">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-foreground">
                    {selectedNode.display_name || selectedNode.id}
                  </div>
                  <div className="mt-0.5 text-[11px] font-mono text-muted-foreground tabular-nums">
                    {selectedNode.display_name && selectedNode.display_name !== selectedNode.id
                      ? `${selectedNode.id} · `
                      : ""}
                    {selectedNode.os}/{selectedNode.arch} · {selectedNode.version || "dev"} · 心跳{" "}
                    {formatShortTime(selectedNode.last_seen_at)}
                  </div>
                </div>
                <NodeStatusDot status={selectedNode.status} />
              </div>

              <div className="flex items-center justify-between border-b border-border pb-2.5 text-xs">
                <span className="text-muted-foreground">当前并发负载</span>
                <span className="font-mono text-xs font-medium text-foreground tabular-nums">
                  {selectedNode.active_runs_count} / {selectedNode.max_concurrency}
                </span>
              </div>

              {agentCapabilities.length > 0 ? (
                <div className="flex items-center justify-between gap-2 border-b border-border pb-2.5 text-xs">
                  <span className="shrink-0 text-muted-foreground">可用 Agent</span>
                  <div className="flex flex-wrap justify-end gap-1">
                    {agentCapabilities.map(([agentName, cfg]) => (
                      <Badge
                        key={agentName}
                        variant="outline"
                        className="font-mono text-[10px]"
                        title={cfg.default_model ? `默认模型: ${cfg.default_model}` : undefined}
                      >
                        {agentName}
                        {cfg.default_model ? ` (${cfg.default_model})` : ""}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}

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
                      <PlayCircle className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      恢复派发
                    </>
                  ) : (
                    <>
                      <PauseCircle className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
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

              {onUpdateNodeDefaultNotify ? (
                <div className="space-y-1.5 border-b border-border pb-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor="node-default-notify" className="text-muted-foreground">
                      默认 Bot 通知通道
                    </label>
                    {selectedNode.default_notify_key_id && selectedNode.default_notify_valid === false ? (
                      <Badge variant="failed" data-testid="node-notify-invalid-badge" className="text-[10px]">
                        通道失效/已吊销
                      </Badge>
                    ) : selectedNode.default_notify_key_id ? (
                      <Badge variant="done" data-testid="node-notify-valid-badge" className="font-mono text-[10px]">
                        {selectedNode.default_notify_webhook_host || "已绑定"}
                      </Badge>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">未绑定</span>
                    )}
                  </div>
                  {eligibleBotKeys.length > 0 || selectedNode.default_notify_key_id ? (
                    <Select
                      value={selectedNode.default_notify_key_id ?? UNBOUND_NOTIFY_VALUE}
                      onValueChange={(v) =>
                        onUpdateNodeDefaultNotify(
                          selectedNode.id,
                          v === UNBOUND_NOTIFY_VALUE ? null : v
                        )
                      }
                    >
                      <SelectTrigger
                        id="node-default-notify"
                        aria-label="默认 Bot 通知通道"
                        data-testid="node-default-notify-select"
                      >
                        <SelectValue placeholder="未绑定（不通知）" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={UNBOUND_NOTIFY_VALUE} data-testid="node-notify-option-unbound">
                          未绑定（不通知）
                        </SelectItem>
                        {eligibleBotKeys.map((k) => (
                          <SelectItem key={k.id} value={k.id} data-testid={`node-notify-option-${k.id}`}>
                            {k.name} ({k.notify_webhook_host || "webhook"})
                          </SelectItem>
                        ))}
                        {selectedNode.default_notify_key_id &&
                        !eligibleBotKeys.some((k) => k.id === selectedNode.default_notify_key_id) ? (
                          <SelectItem value={selectedNode.default_notify_key_id}>
                            {selectedNode.default_notify_key_name || selectedNode.default_notify_key_id}
                            {selectedNode.default_notify_valid === false ? "（已失效）" : ""}
                          </SelectItem>
                        ) : null}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="text-[11px] text-muted-foreground">
                      可在「API Keys」为 client 凭证配置 Bot Webhook 后在此绑定
                    </div>
                  )}
                </div>
              ) : null}

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-muted-foreground tabular-nums">
                    已上报工作区 ({selectedNode.workspaces.length})
                  </span>
                </div>

                {selectedNode.workspaces.length > 5 ? (
                  <div className="relative flex items-center">
                    <Search
                      className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground"
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                    <Input
                      aria-label="筛选已上报工作区"
                      value={wsQuery}
                      onChange={(e) => setWsQuery(e.target.value)}
                      placeholder="筛选工作区名称或完整路径..."
                      className="h-8 pl-8 text-xs font-mono"
                    />
                  </div>
                ) : null}

                {filteredWorkspaces.length === 0 ? (
                  <div className="rounded-[6px] border border-border bg-background/40 px-3 py-4 text-center text-xs text-muted-foreground">
                    未找到匹配的工作区目录
                  </div>
                ) : (
                  <div
                    data-testid="control-workspaces-list"
                    className="divide-y divide-border rounded-[6px] border border-border bg-background/50"
                  >
                    {filteredWorkspaces.map((ws) => (
                      <div
                        key={ws.path}
                        data-testid={`control-ws-row-${ws.key}`}
                        className="px-2.5 py-2 transition-colors duration-150 hover:bg-accent/35"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-mono text-xs font-medium text-foreground">
                              {ws.key}
                            </span>
                            {ws.default_branch ? (
                              <Badge variant="outline" className="font-mono text-[10px]">
                                {ws.default_branch}
                              </Badge>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <CopyButton
                              text={ws.path}
                              label="复制路径"
                              copiedLabel="已复制"
                              variant="outline"
                            />
                            <button
                              type="button"
                              onClick={() => onPickWorkspace(selectedNode.id, ws.path)}
                              data-testid={`control-pick-ws-${ws.key}`}
                              className="inline-flex min-h-6 items-center gap-1 rounded-[5px] border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-foreground transition-[color,background-color,transform] duration-150 active:scale-[0.97] hover:bg-accent cursor-pointer"
                            >
                              <Send className="h-3 w-3 text-[var(--status-running)]" strokeWidth={1.75} aria-hidden="true" />
                              派发
                            </button>
                          </div>
                        </div>
                        <div
                          className="mt-1 font-mono text-[11px] leading-snug text-muted-foreground break-all select-all"
                          data-testid={`control-ws-path-${ws.key}`}
                        >
                          {ws.path}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </aside>
  );
}
