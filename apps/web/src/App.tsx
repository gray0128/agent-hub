import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  AlertCircle,
  KeyRound,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  Sun,
  X
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ConversationPane } from "@/components/workbench/ConversationPane";
import { FleetThreadsPane } from "@/components/workbench/FleetThreadsPane";
import { InspectorPane } from "@/components/workbench/InspectorPane";
import {
  KeysDialog,
  OnboardingDialog
} from "@/components/workbench/OnboardingKeysDialogs";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { HubStreamClient } from "@/lib/ws-client";
import { useFleetStore } from "@/stores/fleet-store";
import { useTaskStore } from "@/stores/task-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { NodeRecord, ThreadRecord } from "@/types";

declare global {
  interface Window {
    __AHUB_EVAL__?: {
      getState: () => {
        nodes: ReturnType<typeof useFleetStore.getState>["nodes"];
        threads: ReturnType<typeof useTaskStore.getState>["threads"];
        runs: ReturnType<typeof useTaskStore.getState>["runs"];
        eventsByRunId: ReturnType<typeof useTaskStore.getState>["eventsByRunId"];
        selectedThreadId: string | null;
        selectedRunId: string | null;
        theme: string;
        streamStatus: string;
      };
    };
  }
}

export function App() {
  const nodes = useFleetStore((s) => s.nodes);
  const selectedNodeId = useFleetStore((s) => s.selectedNodeId);
  const setNodes = useFleetStore((s) => s.setNodes);
  const upsertNode = useFleetStore((s) => s.upsertNode);
  const selectNode = useFleetStore((s) => s.selectNode);

  const threads = useTaskStore((s) => s.threads);
  const runs = useTaskStore((s) => s.runs);
  const eventsByRunId = useTaskStore((s) => s.eventsByRunId);
  const fullOutputByRunId = useTaskStore((s) => s.fullOutputByRunId);
  const selectedThreadId = useTaskStore((s) => s.selectedThreadId);
  const selectedRunId = useTaskStore((s) => s.selectedRunId);
  const setThreads = useTaskStore((s) => s.setThreads);
  const upsertThread = useTaskStore((s) => s.upsertThread);
  const setRuns = useTaskStore((s) => s.setRuns);
  const upsertRun = useTaskStore((s) => s.upsertRun);
  const appendEvents = useTaskStore((s) => s.appendEvents);
  const setFullOutput = useTaskStore((s) => s.setFullOutput);
  const selectThread = useTaskStore((s) => s.selectThread);
  const selectRun = useTaskStore((s) => s.selectRun);

  const theme = useWorkbenchStore((s) => s.theme);
  const token = useWorkbenchStore((s) => s.token);
  const streamStatus = useWorkbenchStore((s) => s.streamStatus);
  const activeTab = useWorkbenchStore((s) => s.activeTab);
  const threadQuery = useWorkbenchStore((s) => s.threadQuery);
  const onboardingOpen = useWorkbenchStore((s) => s.onboardingOpen);
  const keysDialogOpen = useWorkbenchStore((s) => s.keysDialogOpen);
  const mobileLeftOpen = useWorkbenchStore((s) => s.mobileLeftOpen);
  const mobileRightOpen = useWorkbenchStore((s) => s.mobileRightOpen);
  const errorBanner = useWorkbenchStore((s) => s.errorBanner);
  const composer = useWorkbenchStore((s) => s.composer);

  const toggleTheme = useWorkbenchStore((s) => s.toggleTheme);
  const setToken = useWorkbenchStore((s) => s.setToken);
  const setStreamStatus = useWorkbenchStore((s) => s.setStreamStatus);
  const setActiveTab = useWorkbenchStore((s) => s.setActiveTab);
  const setThreadQuery = useWorkbenchStore((s) => s.setThreadQuery);
  const setOnboardingOpen = useWorkbenchStore((s) => s.setOnboardingOpen);
  const setKeysDialogOpen = useWorkbenchStore((s) => s.setKeysDialogOpen);
  const setMobileLeftOpen = useWorkbenchStore((s) => s.setMobileLeftOpen);
  const setMobileRightOpen = useWorkbenchStore((s) => s.setMobileRightOpen);
  const setErrorBanner = useWorkbenchStore((s) => s.setErrorBanner);
  const patchComposer = useWorkbenchStore((s) => s.patchComposer);

  const [submitting, setSubmitting] = useState(false);
  const wsClientRef = useRef<HubStreamClient | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Expose read-only runtime state for L2 browser parity verification
  useEffect(() => {
    window.__AHUB_EVAL__ = {
      getState: () => {
        const fleet = useFleetStore.getState();
        const task = useTaskStore.getState();
        const wb = useWorkbenchStore.getState();
        return {
          nodes: fleet.nodes,
          threads: task.threads,
          runs: task.runs,
          eventsByRunId: task.eventsByRunId,
          selectedThreadId: task.selectedThreadId,
          selectedRunId: task.selectedRunId,
          theme: wb.theme,
          streamStatus: wb.streamStatus
        };
      }
    };
    return () => {
      delete window.__AHUB_EVAL__;
    };
  }, []);

  const syncDefaultSelection = useCallback(() => {
    const curNodes = useFleetStore.getState().nodes;
    const curThreads = useTaskStore.getState().threads;
    const curRuns = useTaskStore.getState().runs;
    const curComposer = useWorkbenchStore.getState().composer;

    if (!useFleetStore.getState().selectedNodeId && curNodes.length > 0) {
      selectNode(curNodes[0].id);
    }

    if (!curComposer.nodeId && curNodes.length > 0) {
      const online = curNodes.find((n) => n.status === "online") ?? curNodes[0];
      patchComposer({
        nodeId: online.id,
        workdir: online.workspaces?.[0]?.path ?? ""
      });
    }

    if (!useTaskStore.getState().selectedThreadId && curThreads.length > 0) {
      const first = curThreads[0];
      selectThread(first.id);
      patchComposer({
        mode: "reply",
        nodeId: first.node_id,
        workdir: first.workdir,
        agent: first.agent
      });
      const firstRun = curRuns.find((r) => r.thread_id === first.id);
      if (firstRun) selectRun(firstRun.id);
    } else if (!useTaskStore.getState().selectedRunId && curRuns.length > 0) {
      selectRun(curRuns[0].id);
    }
  }, [patchComposer, selectNode, selectRun, selectThread]);

  // Initial REST hydrate + live WebSocket subscription
  useEffect(() => {
    if (!token) {
      setStreamStatus("disconnected");
      return;
    }

    let cancelled = false;
    async function hydrateInitial() {
      try {
        const [nodesRes, threadsRes, runsRes] = await Promise.all([
          apiClient.fetchNodes(token),
          apiClient.fetchThreads(token),
          apiClient.fetchRuns(token, { limit: 200 })
        ]);
        if (cancelled) return;
        setNodes(nodesRes.nodes);
        setThreads(threadsRes.threads);
        setRuns(runsRes.runs);
        syncDefaultSelection();
        setErrorBanner(null);
      } catch (err) {
        if (cancelled) return;
        setErrorBanner(
          err instanceof ApiClientError ? err.message : "无法连接到 Hub API，请检查 Token。"
        );
      }
    }

    void hydrateInitial();

    const client = new HubStreamClient(token, {
      onStatusChange: (status) => {
        if (!cancelled) setStreamStatus(status);
      },
      onFrame: (frame) => {
        if (cancelled) return;
        switch (frame.type) {
          case "snapshot":
            setNodes(frame.nodes ?? []);
            if (frame.threads) setThreads(frame.threads);
            setRuns(frame.runs ?? []);
            syncDefaultSelection();
            break;
          case "node.status":
            upsertNode(frame.node);
            break;
          case "run.updated":
            upsertRun(frame.run);
            if (!useTaskStore.getState().threads.some((t) => t.id === frame.run.thread_id)) {
              void apiClient
                .fetchThreads(token)
                .then((res) => {
                  if (!cancelled) setThreads(res.threads);
                })
                .catch(() => {});
            }
            break;
          case "run.event":
            appendEvents(frame.run_id, [
              {
                seq: frame.seq,
                kind: frame.kind,
                payload: frame.payload,
                ts: frame.ts
              }
            ]);
            break;
          case "run.events":
            appendEvents(frame.run_id, frame.events);
            break;
        }
      }
    });
    wsClientRef.current = client;
    client.start();

    return () => {
      cancelled = true;
      client.stop();
      wsClientRef.current = null;
    };
  }, [
    token,
    appendEvents,
    setErrorBanner,
    setNodes,
    setRuns,
    setStreamStatus,
    setThreads,
    syncDefaultSelection,
    upsertNode,
    upsertRun
  ]);

  // Fetch events and summary preview for selected run when switched
  useEffect(() => {
    if (!token || !selectedRunId) return;
    let cancelled = false;
    void apiClient
      .fetchRunEvents(token, selectedRunId, 0, 200)
      .then((res) => {
        if (!cancelled && res.events.length > 0) {
          appendEvents(selectedRunId, res.events);
        }
      })
      .catch(() => {
        // non-fatal background sync
      });

    const curRun = useTaskStore.getState().runs.find((r) => r.id === selectedRunId);
    if (curRun && !curRun.output_preview && !curRun.output_md) {
      void apiClient
        .fetchRunDetail(token, selectedRunId, "summary")
        .then((res) => {
          if (!cancelled) upsertRun(res.run);
        })
        .catch(() => {
          // non-fatal background sync
        });
    }
    return () => {
      cancelled = true;
    };
  }, [appendEvents, selectedRunId, token, upsertRun]);

  const selectedThread = useMemo(
    () => threads.find((t) => t.id === selectedThreadId) ?? null,
    [selectedThreadId, threads]
  );

  const threadRuns = useMemo(() => {
    if (!selectedThreadId) return [];
    return runs
      .filter((r) => r.thread_id === selectedThreadId)
      .slice()
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  }, [runs, selectedThreadId]);

  const selectedRun = useMemo(() => {
    if (selectedRunId) {
      const found = runs.find((r) => r.id === selectedRunId);
      if (found) return found;
    }
    return threadRuns[threadRuns.length - 1] ?? null;
  }, [runs, selectedRunId, threadRuns]);

  const selectedNodeForInspector = useMemo(() => {
    const id = selectedRun?.node_id ?? composer.nodeId ?? selectedNodeId;
    return nodes.find((n) => n.id === id) ?? nodes[0] ?? null;
  }, [composer.nodeId, nodes, selectedNodeId, selectedRun?.node_id]);

  const selectedRunEvents = useMemo(
    () => (selectedRun ? eventsByRunId[selectedRun.id] ?? [] : []),
    [eventsByRunId, selectedRun]
  );

  function handleSelectThreadById(threadId: string) {
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) return;
    selectThread(thread.id);
    selectNode(thread.node_id);
    patchComposer({
      mode: "reply",
      nodeId: thread.node_id,
      workdir: thread.workdir,
      agent: thread.agent
    });
    const latest = runs.find((r) => r.thread_id === thread.id);
    if (latest) selectRun(latest.id);
    setMobileLeftOpen(false);
  }

  function handlePickWorkspace(nodeId: string, workdir: string) {
    selectNode(nodeId);
    patchComposer({ mode: "new", nodeId, workdir });
    setMobileLeftOpen(false);
  }

  function handleNewThread() {
    selectThread(null);
    const targetNode =
      nodes.find((n) => n.id === (composer.nodeId || selectedNodeId)) ?? nodes[0];
    patchComposer({
      mode: "new",
      nodeId: targetNode?.id ?? "",
      workdir: composer.workdir || targetNode?.workspaces?.[0]?.path || ""
    });
    setMobileLeftOpen(false);
  }

  async function handleTogglePinThread(thread: ThreadRecord) {
    if (!token) return;
    try {
      const res = await apiClient.patchThread(token, thread.id, {
        pinned: !thread.pinned
      });
      upsertThread(res.thread);
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : "置顶线程失败");
    }
  }

  async function handleForkThread(thread: ThreadRecord) {
    if (!token) return;
    try {
      const res = await apiClient.forkThread(token, thread.id, {
        node_id: thread.node_id,
        workdir: thread.workdir,
        agent: thread.agent,
        title: `${thread.title} (分支)`
      });
      upsertThread(res.thread);
      upsertRun(res.run);
      selectThread(res.thread.id);
      selectRun(res.run.id);
      patchComposer({
        mode: "reply",
        nodeId: res.thread.node_id,
        workdir: res.thread.workdir,
        agent: res.thread.agent
      });
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : "分叉线程失败");
    }
  }

  async function handleLoadFullOutput(runId: string) {
    if (!token) return;
    try {
      const res = await apiClient.fetchRunDetail(token, runId, "full");
      upsertRun(res.run);
      if (res.run.output_md) {
        setFullOutput(runId, res.run.output_md);
      }
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : "加载完整输出失败");
    }
  }

  async function handleCancelRun(runId: string, cascade: boolean) {
    if (!token) return;
    try {
      const res = await apiClient.cancelRun(token, runId, cascade);
      res.cancelled_runs.forEach(upsertRun);
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : "终止运行失败");
    }
  }

  async function handleToggleNodeDrain(node: NodeRecord) {
    if (!token) return;
    try {
      const nextStatus = node.status === "draining" ? "online" : "draining";
      const res = await apiClient.patchNode(token, node.id, { status: nextStatus });
      upsertNode(res.node);
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : "更新节点状态失败");
    }
  }

  async function handleUpdateNodeConcurrency(nodeId: string, maxConcurrency: number) {
    if (!token) return;
    try {
      const res = await apiClient.patchNode(token, nodeId, {
        max_concurrency: maxConcurrency
      });
      upsertNode(res.node);
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : "更新并发上限失败");
    }
  }

  async function handleSubmitPrompt() {
    if (!token) {
      setOnboardingOpen(true);
      return;
    }
    const promptText = composer.prompt.trim();
    if (!promptText) return;

    setSubmitting(true);
    setErrorBanner(null);
    try {
      const useThread = composer.mode === "reply" && selectedThread;
      const res = await apiClient.createRun(token, {
        ...(useThread
          ? { thread_id: useThread.id }
          : { node_id: composer.nodeId || undefined, workdir: composer.workdir || undefined }),
        agent: composer.agent,
        model: composer.model,
        effort: composer.effort,
        sandbox: composer.sandbox,
        notify: { target: composer.notifyTarget },
        prompt: promptText
      });

      if (res.run) {
        upsertRun(res.run);
        selectThread(res.run.thread_id);
        selectRun(res.run.id);
        const threadsRes = await apiClient.fetchThreads(token);
        setThreads(threadsRes.threads);
      }
      patchComposer({ mode: "reply", prompt: "" });
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : "创建运行失败");
    } finally {
      setSubmitting(false);
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const activeData = active.data.current as
      | { type?: string; nodeId?: string; workdir?: string; threadId?: string; runId?: string }
      | undefined;

    if (activeData?.type === "workspace" && over.id === "composer-workdir-dropzone") {
      if (activeData.nodeId && activeData.workdir) {
        handlePickWorkspace(activeData.nodeId, activeData.workdir);
      }
      return;
    }

    if (activeData?.type === "queued") {
      const overData = over.data.current as
        | { type?: string; runId?: string; nodeId?: string }
        | undefined;
      if (
        overData?.type !== "queued" ||
        !activeData.runId ||
        !overData.runId ||
        activeData.runId === overData.runId ||
        !activeData.nodeId ||
        activeData.nodeId !== overData.nodeId
      ) {
        return;
      }

      const nodeQueued = runs
        .filter((r) => r.node_id === activeData.nodeId && r.status === "queued")
        .sort((a, b) => a.priority_order - b.priority_order);
      const oldIdx = nodeQueued.findIndex((r) => r.id === activeData.runId);
      const newIdx = nodeQueued.findIndex((r) => r.id === overData.runId);
      if (oldIdx < 0 || newIdx < 0) return;

      const moved = arrayMove(nodeQueued, oldIdx, newIdx);
      const movedIds = moved.map((r) => r.id);
      if (token) {
        void apiClient
          .reorderQueuedRuns(token, activeData.nodeId, movedIds)
          .then((res) => res.runs.forEach(upsertRun))
          .catch((err) => {
            setErrorBanner(err instanceof ApiClientError ? err.message : "队列重排失败");
          });
      }
    }
  }

  const fleetProps = {
    nodes,
    selectedNodeId,
    threads,
    selectedThreadId,
    activeWorkdir: composer.workdir,
    activeTargetNodeId: composer.nodeId,
    threadQuery,
    onThreadQueryChange: setThreadQuery,
    onSelectNode: selectNode,
    onPickWorkspace: handlePickWorkspace,
    onSelectThread: handleSelectThreadById,
    onNewThread: handleNewThread,
    onTogglePinThread: handleTogglePinThread,
    onForkThread: handleForkThread
  };

  const inspectorProps = {
    activeTab,
    onTabChange: setActiveTab,
    selectedRun,
    allRuns: runs,
    selectedNode: selectedNodeForInspector,
    events: selectedRunEvents,
    onSelectRun: selectRun,
    onCancelRun: handleCancelRun,
    onToggleNodeDrain: handleToggleNodeDrain,
    onUpdateNodeConcurrency: handleUpdateNodeConcurrency
  };

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="flex h-dvh w-screen flex-col overflow-hidden bg-background text-foreground">
        {/* Global slim header bar */}
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2 sm:px-3">
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setMobileLeftOpen(true)}
              className="h-11 w-11 md:hidden"
              aria-label="打开节点与会话列表"
              data-testid="mobile-left-trigger"
            >
              <PanelLeft className="h-4 w-4" strokeWidth={1.75} />
            </Button>

            <div className="flex items-center gap-2 px-1">
              <span className="h-2 w-2 rounded-full bg-[var(--status-running)]" />
              <span className="truncate font-mono text-sm font-semibold tracking-tight">
                agent-hub
              </span>
            </div>

            <span
              data-testid="stream-status-pill"
              className="hidden items-center gap-1.5 rounded-[5px] border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground sm:inline-flex"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  streamStatus === "connected" && "bg-[var(--status-done)]",
                  streamStatus === "connecting" && "bg-[var(--status-running)]",
                  streamStatus === "disconnected" && "bg-[var(--status-failed)]"
                )}
              />
              {streamStatus === "connected"
                ? "实时已连接"
                : streamStatus === "connecting"
                  ? "连接中"
                  : "已断开"}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOnboardingOpen(true)}
              className="min-h-11 min-w-11 px-2.5 md:min-h-8 md:h-8 md:px-2.5"
              data-testid="open-onboarding-btn"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span className="hidden sm:inline">接入节点</span>
            </Button>

            <Button
              type="button"
              variant="outline"
              onClick={() => setKeysDialogOpen(true)}
              className="min-h-11 min-w-11 px-2.5 md:min-h-8 md:h-8 md:px-2.5"
              aria-label="API Keys"
              data-testid="open-keys-btn"
            >
              <KeyRound className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span className="hidden sm:inline">API Keys</span>
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              className="h-11 w-11 md:h-8 md:w-8"
              aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"}
              data-testid="theme-toggle-btn"
            >
              {theme === "dark" ? (
                <Sun className="h-4 w-4" strokeWidth={1.75} />
              ) : (
                <Moon className="h-4 w-4" strokeWidth={1.75} />
              )}
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setMobileRightOpen(true)}
              className="h-11 w-11 md:hidden"
              aria-label="打开检视面板"
              data-testid="mobile-right-trigger"
            >
              <PanelRight className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </div>
        </header>

        {errorBanner && (
          <div
            role="alert"
            className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--status-failed)]/40 bg-[var(--status-failed)]/10 px-3 py-1.5 text-xs text-[var(--status-failed)]"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
              <span className="truncate">{errorBanner}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              aria-label="关闭错误提示"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] hover:bg-black/10"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Desktop 3-pane resizable layout */}
        <main className="hidden min-h-0 flex-1 md:block">
          <Group orientation="horizontal" className="h-full w-full">
            <Panel id="fleet" defaultSize="22%" minSize="16%" maxSize="34%" className="h-full overflow-hidden">
              <FleetThreadsPane {...fleetProps} />
            </Panel>
            <Separator className="w-px bg-border transition-colors duration-150 hover:bg-[var(--status-running)]" />
            <Panel id="stream" defaultSize="48%" minSize="32%" className="h-full overflow-hidden">
              <ConversationPane
                nodes={nodes}
                selectedThread={selectedThread}
                threadRuns={threadRuns}
                selectedRunId={selectedRun?.id ?? null}
                fullOutputByRunId={fullOutputByRunId}
                eventsByRunId={eventsByRunId}
                composer={composer}
                submitting={submitting}
                onPatchComposer={patchComposer}
                onSelectRun={selectRun}
                onLoadFullOutput={handleLoadFullOutput}
                onCancelRun={handleCancelRun}
                onForkThread={handleForkThread}
                onSubmitPrompt={handleSubmitPrompt}
              />
            </Panel>
            <Separator className="w-px bg-border transition-colors duration-150 hover:bg-[var(--status-running)]" />
            <Panel id="inspector" defaultSize="30%" minSize="22%" maxSize="44%" className="h-full overflow-hidden">
              <InspectorPane {...inspectorProps} />
            </Panel>
          </Group>
        </main>

        {/* Mobile single-column stream + drawer sheets */}
        <main className="min-h-0 flex-1 md:hidden">
          <ConversationPane
            nodes={nodes}
            selectedThread={selectedThread}
            threadRuns={threadRuns}
            selectedRunId={selectedRun?.id ?? null}
            fullOutputByRunId={fullOutputByRunId}
            eventsByRunId={eventsByRunId}
            composer={composer}
            submitting={submitting}
            onPatchComposer={patchComposer}
            onSelectRun={selectRun}
            onLoadFullOutput={handleLoadFullOutput}
            onCancelRun={handleCancelRun}
            onForkThread={handleForkThread}
            onSubmitPrompt={handleSubmitPrompt}
          />
        </main>

        <Sheet open={mobileLeftOpen} onOpenChange={setMobileLeftOpen}>
          <SheetContent side="left">
            <FleetThreadsPane {...fleetProps} />
          </SheetContent>
        </Sheet>

        <Sheet open={mobileRightOpen} onOpenChange={setMobileRightOpen}>
          <SheetContent side="right">
            <InspectorPane {...inspectorProps} />
          </SheetContent>
        </Sheet>

        <OnboardingDialog
          open={onboardingOpen}
          onOpenChange={setOnboardingOpen}
          token={token}
          onApplyToken={(next) => {
            setToken(next);
            wsClientRef.current?.updateToken(next);
          }}
        />

        <KeysDialog open={keysDialogOpen} onOpenChange={setKeysDialogOpen} token={token} />
      </div>
    </DndContext>
  );
}

export default App;
