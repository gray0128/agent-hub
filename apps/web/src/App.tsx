import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
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
        composer: ReturnType<typeof useWorkbenchStore.getState>["composer"];
        theme: string;
        streamStatus: string;
        authStatus: string;
        authKind: string | null;
      };
    };
  }
}

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 768 : true
  );

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      mq.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return isDesktop;
}

export function App() {
  const isDesktop = useIsDesktop();

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
  const authStatus = useWorkbenchStore((s) => s.authStatus);
  const authKind = useWorkbenchStore((s) => s.authKind);
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
  const setAuthState = useWorkbenchStore((s) => s.setAuthState);
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
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const wsClientRef = useRef<HubStreamClient | null>(null);
  const fetchedDetailIdsRef = useRef<Set<string>>(new Set());
  const hasSession = authStatus === "authenticated" || Boolean(token);

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
          composer: wb.composer,
          theme: wb.theme,
          streamStatus: wb.streamStatus,
          authStatus: wb.authStatus,
          authKind: wb.authKind
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
        agent: first.agent,
        model: "",
        effort: ""
      });
      const firstRun = curRuns.find((r) => r.thread_id === first.id);
      if (firstRun) selectRun(firstRun.id);
    } else if (!useTaskStore.getState().selectedRunId && curRuns.length > 0) {
      selectRun(curRuns[0].id);
    }
  }, [patchComposer, selectNode, selectRun, selectThread]);

  // Initial REST hydrate (supports Cloudflare Access same-origin cookie or Bearer token) + live WebSocket subscription
  useEffect(() => {
    let cancelled = false;
    let client: HubStreamClient | null = null;
    fetchedDetailIdsRef.current.clear();
    setAuthState("checking", null);
    setStreamStatus("connecting");

    async function hydrateAndConnect() {
      try {
        const [meRes, nodesRes, threadsRes, runsRes] = await Promise.all([
          apiClient.fetchMe(token),
          apiClient.fetchNodes(token),
          apiClient.fetchThreads(token),
          apiClient.fetchRuns(token, { limit: 200 })
        ]);
        if (cancelled) return;
        setAuthState("authenticated", meRes.principal.kind);
        setNodes(nodesRes.nodes);
        setThreads(threadsRes.threads);
        setRuns(runsRes.runs);
        syncDefaultSelection();
        setErrorBanner(null);

        client = new HubStreamClient(token, {
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
      } catch (err) {
        if (cancelled) return;
        setStreamStatus("disconnected");
        if (err instanceof ApiClientError && err.status === 401) {
          setAuthState("unauthenticated", null);
          setErrorBanner(
            token
              ? "访问 Token 无效或已吊销，请重新输入。"
              : "未检测到 Cloudflare Access 登录态，请在「接入节点 -> Token 登录」配置访问 Token。"
          );
          return;
        }
        setErrorBanner(
          err instanceof ApiClientError ? err.message : "无法连接到 Hub API，请检查网络或配置。"
        );
      }
    }

    void hydrateAndConnect();

    return () => {
      cancelled = true;
      if (client) {
        client.stop();
      }
      wsClientRef.current = null;
    };
  }, [
    token,
    appendEvents,
    setAuthState,
    setErrorBanner,
    setNodes,
    setRuns,
    setStreamStatus,
    setThreads,
    syncDefaultSelection,
    upsertNode,
    upsertRun
  ]);

  // Fetch events for selected run when switched
  useEffect(() => {
    if (!hasSession || !selectedRunId) return;
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
    return () => {
      cancelled = true;
    };
  }, [appendEvents, hasSession, selectedRunId, token]);

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

  // Hydrate markdown summary previews for terminal runs in active thread when loaded from list view
  useEffect(() => {
    if (!hasSession || threadRuns.length === 0) return;
    let cancelled = false;
    const missing = threadRuns
      .slice(-8)
      .filter(
        (r) =>
          (r.status === "done" || r.status === "failed" || r.status === "cancelled") &&
          !r.output_preview &&
          !r.output_md &&
          !fetchedDetailIdsRef.current.has(r.id)
      );
    for (const run of missing) {
      fetchedDetailIdsRef.current.add(run.id);
      void apiClient
        .fetchRunDetail(token, run.id, "summary")
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
  }, [hasSession, threadRuns, token, upsertRun]);

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

  const hasLineage = useMemo(() => {
    if (!selectedRun) return false;
    if (selectedRun.depth > 0) return true;
    return runs.some((r) => r.root_run_id === selectedRun.root_run_id && r.id !== selectedRun.id);
  }, [runs, selectedRun]);

  const fleetTelemetry = useMemo(() => {
    const online = nodes.filter((n) => n.status === "online").length;
    let running = 0;
    let approval = 0;
    let queued = 0;
    for (const r of runs) {
      if (r.status === "running" || r.status === "claimed") running += 1;
      else if (r.status === "needs_approval") approval += 1;
      else if (r.status === "queued") queued += 1;
    }
    return { online, total: nodes.length, running, approval, queued };
  }, [nodes, runs]);

  function handleSelectThreadById(threadId: string) {
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) return;
    selectThread(thread.id);
    selectNode(thread.node_id);
    const sameBinding =
      thread.node_id === composer.nodeId && thread.agent === composer.agent;
    patchComposer({
      mode: "reply",
      nodeId: thread.node_id,
      workdir: thread.workdir,
      agent: thread.agent,
      ...(sameBinding ? {} : { model: "", effort: "" })
    });
    const latest = runs.find((r) => r.thread_id === thread.id);
    if (latest) selectRun(latest.id);
    setMobileLeftOpen(false);
  }

  function handlePickWorkspace(nodeId: string, workdir: string) {
    selectNode(nodeId);
    const sameNode = nodeId === composer.nodeId;
    patchComposer({
      mode: "new",
      nodeId,
      workdir,
      ...(sameNode ? {} : { model: "", effort: "" })
    });
    setMobileLeftOpen(false);
    setMobileRightOpen(false);
    window.requestAnimationFrame(() => {
      document.getElementById("prompt-input")?.focus();
    });
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
    window.requestAnimationFrame(() => {
      document.getElementById("prompt-input")?.focus();
    });
  }

  async function handleTogglePinThread(thread: ThreadRecord) {
    if (!hasSession) return;
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
    if (!hasSession) return;
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
        agent: res.thread.agent,
        model: "",
        effort: ""
      });
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : "分叉线程失败");
    }
  }

  async function handleLoadFullOutput(runId: string) {
    if (!hasSession) return;
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
    if (!hasSession) return;
    try {
      const res = await apiClient.cancelRun(token, runId, cascade);
      res.cancelled_runs.forEach(upsertRun);
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : "终止运行失败");
    }
  }

  async function handleResolveRun(runId: string) {
    if (!hasSession) return;
    try {
      const res = await apiClient.resolveRun(token, runId, "Resolved from web console");
      upsertRun(res.run);
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : "放行确认失败");
    }
  }

  async function handleToggleNodeDrain(node: NodeRecord) {
    if (!hasSession) return;
    try {
      const nextStatus = node.status === "draining" ? "online" : "draining";
      const res = await apiClient.patchNode(token, node.id, { status: nextStatus });
      upsertNode(res.node);
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : "更新节点状态失败");
    }
  }

  async function handleUpdateNodeConcurrency(nodeId: string, maxConcurrency: number) {
    if (!hasSession) return;
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
    if (!hasSession) {
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
        model: composer.model.trim() || undefined,
        effort: composer.effort || undefined,
        sandbox: composer.sandbox,
        notify: { target: composer.notifyTarget },
        prompt: promptText
      });

      if (res.run) {
        upsertRun({
          ...res.run,
          prompt: res.run.prompt ?? promptText
        });
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

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as
      | { type?: string; nodeId?: string; workdir?: string; threadId?: string; runId?: string }
      | undefined;
    if (data?.type === "workspace" && data.workdir) {
      const key = data.workdir.split("/").pop() || data.workdir;
      setDragLabel(`${data.nodeId ?? "node"}:${key}`);
    } else if (data?.type === "queued" && data.runId) {
      setDragLabel(`队列 ${data.runId}`);
    } else if (data?.type === "thread" && data.threadId) {
      const t = threads.find((item) => item.id === data.threadId);
      setDragLabel(t?.title || t?.project_key || data.threadId);
    } else {
      setDragLabel(null);
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setDragLabel(null);
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

    if (activeData?.type === "thread" && activeData.threadId) {
      const overData = over.data.current as { type?: string; threadId?: string } | undefined;
      if (overData?.type !== "thread" || !overData.threadId || activeData.threadId === overData.threadId) {
        return;
      }
      const activeThread = threads.find((t) => t.id === activeData.threadId);
      const overThread = threads.find((t) => t.id === overData.threadId);
      if (!activeThread || !overThread || activeThread.pinned !== overThread.pinned) {
        return;
      }

      const group = threads.filter((t) => t.pinned === activeThread.pinned);
      const oldIdx = group.findIndex((t) => t.id === activeThread.id);
      const newIdx = group.findIndex((t) => t.id === overThread.id);
      if (oldIdx < 0 || newIdx < 0) return;

      const movedGroup = arrayMove(group, oldIdx, newIdx).map((t, idx) => ({
        ...t,
        sort_order: (idx + 1) * 100
      }));
      const byId = new Map(movedGroup.map((t) => [t.id, t]));
      setThreads(threads.map((t) => byId.get(t.id) ?? t));

      if (hasSession) {
        const changed = movedGroup.filter((next) => {
          const prev = group.find((g) => g.id === next.id);
          return prev && prev.sort_order !== next.sort_order;
        });
        void Promise.all(
          changed.map((t) =>
            apiClient.patchThread(token, t.id, { sort_order: t.sort_order })
          )
        ).catch((err) => {
          setErrorBanner(err instanceof ApiClientError ? err.message : "会话排序保存失败");
        });
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
      if (hasSession) {
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
    runs,
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
    onUpdateNodeConcurrency: handleUpdateNodeConcurrency,
    onPickWorkspace: handlePickWorkspace
  };

  const conversationElement = (
    <ConversationPane
      nodes={nodes}
      selectedThread={selectedThread}
      threadRuns={threadRuns}
      selectedRunId={selectedRun?.id ?? null}
      hasLineage={hasLineage}
      fullOutputByRunId={fullOutputByRunId}
      eventsByRunId={eventsByRunId}
      composer={composer}
      submitting={submitting}
      onPatchComposer={patchComposer}
      onSelectRun={selectRun}
      onLoadFullOutput={handleLoadFullOutput}
      onCancelRun={handleCancelRun}
      onResolveRun={handleResolveRun}
      onForkThread={handleForkThread}
      onOpenLineage={() => {
        setActiveTab("lineage");
        if (!isDesktop) setMobileRightOpen(true);
      }}
      onSubmitPrompt={handleSubmitPrompt}
    />
  );

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragCancel={() => setDragLabel(null)}
      onDragEnd={handleDragEnd}
    >
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
              <PanelLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            </Button>

            <div className="flex items-center gap-2 px-1">
              <span className="h-2 w-2 rounded-full bg-[var(--status-running)]" aria-hidden="true" />
              <h1 className="truncate font-mono text-sm font-semibold tracking-tight">
                agent-hub
              </h1>
            </div>

            <span
              data-testid="stream-status-pill"
              className="hidden items-center gap-1.5 rounded-[5px] border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground sm:inline-flex"
            >
              <span
                aria-hidden="true"
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

            <div className="hidden items-center gap-1.5 font-mono text-[11px] text-muted-foreground tabular-nums lg:inline-flex">
              <button
                type="button"
                onClick={() => setActiveTab("control")}
                className="inline-flex items-center gap-1 rounded-[5px] border border-border bg-background/60 px-2 py-0.5 hover:text-foreground cursor-pointer"
              >
                在线 {fleetTelemetry.online}/{fleetTelemetry.total}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("queue")}
                className="inline-flex items-center gap-2 rounded-[5px] border border-border bg-background/60 px-2 py-0.5 hover:text-foreground cursor-pointer"
              >
                <span>运行 {fleetTelemetry.running}</span>
                <span>排队 {fleetTelemetry.queued}</span>
                <span
                  className={cn(
                    fleetTelemetry.approval > 0 && "text-[var(--status-approval)] font-medium"
                  )}
                >
                  审批 {fleetTelemetry.approval}
                </span>
              </button>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOnboardingOpen(true)}
              className="min-h-11 min-w-11 px-2.5 md:min-h-8 md:h-8 md:px-2.5"
              aria-label="接入节点"
              data-testid="open-onboarding-btn"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
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
              <KeyRound className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
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
                <Sun className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Moon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
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
              <PanelRight className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </div>
        </header>

        {errorBanner && (
          <div
            role="alert"
            className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--status-failed)]/40 bg-[var(--status-failed)]/10 px-3 py-1.5 text-xs text-[var(--status-failed)]"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
              <span className="truncate">{errorBanner}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              aria-label="关闭错误提示"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] hover:bg-black/10 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Single <main> landmark: 3-pane resizable on desktop, focused timeline on mobile */}
        <main className="min-h-0 flex-1 overflow-hidden">
          {isDesktop ? (
            <Group orientation="horizontal" className="h-full w-full">
              <Panel id="fleet" defaultSize="22%" minSize="16%" maxSize="34%" className="h-full overflow-hidden">
                <FleetThreadsPane {...fleetProps} />
              </Panel>
              <Separator className="w-px bg-border transition-colors duration-150 hover:bg-[var(--status-running)]" />
              <Panel id="stream" defaultSize="48%" minSize="32%" className="h-full overflow-hidden">
                {conversationElement}
              </Panel>
              <Separator className="w-px bg-border transition-colors duration-150 hover:bg-[var(--status-running)]" />
              <Panel id="inspector" defaultSize="30%" minSize="22%" maxSize="44%" className="h-full overflow-hidden">
                <InspectorPane {...inspectorProps} />
              </Panel>
            </Group>
          ) : (
            conversationElement
          )}
        </main>

        <Sheet open={mobileLeftOpen} onOpenChange={setMobileLeftOpen}>
          <SheetContent side="left" title="节点与会话">
            <FleetThreadsPane {...fleetProps} inDrawer />
          </SheetContent>
        </Sheet>

        <Sheet open={mobileRightOpen} onOpenChange={setMobileRightOpen}>
          <SheetContent side="right" title="实时检视与节点控制">
            <InspectorPane {...inspectorProps} />
          </SheetContent>
        </Sheet>

        <OnboardingDialog
          open={onboardingOpen}
          onOpenChange={setOnboardingOpen}
          token={token}
          authenticated={authStatus === "authenticated"}
          authKind={authKind}
          onApplyToken={(next) => {
            setToken(next);
            wsClientRef.current?.updateToken(next);
          }}
        />

        <KeysDialog
          open={keysDialogOpen}
          onOpenChange={setKeysDialogOpen}
          token={token}
          authenticated={authStatus === "authenticated"}
          authKind={authKind}
        />
      </div>

      <DragOverlay dropAnimation={null}>
        {dragLabel ? (
          <div className="rounded-[6px] border border-[var(--status-running)] bg-popover px-2.5 py-1 font-mono text-xs text-popover-foreground shadow-lg">
            {dragLabel}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

export default App;
