import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  AlertCircle,
  Bell,
  Ellipsis,
  KeyRound,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  Sun,
  X
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { BrowserNotifyDialog } from "@/components/workbench/BrowserNotifyDialog";
import { BrandMark } from "@/components/workbench/BrandMark";
import { ConversationPane } from "@/components/workbench/ConversationPane";
import { FleetThreadsPane } from "@/components/workbench/FleetThreadsPane";
import { InspectorPane } from "@/components/workbench/InspectorPane";
import { NativeActivityPane } from "@/components/workbench/NativeActivityPane";
import {
  KeysDialog,
  OnboardingDialog
} from "@/components/workbench/OnboardingKeysDialogs";
import { apiClient, ApiClientError } from "@/lib/api-client";
import {
  getCurrentDevicePushInfo,
  initBrowserNotifyCoordinator,
  mapNativeKindToFilterKey,
  mapRunStatusToFilterKey,
  notifyInPageWithDedup,
  readInPageFallbackPref,
  writeInPageFallbackPref
} from "@/lib/browser-notify";
import { getAvailableAgents, resolveInitialComposerModelAndEffort } from "@/lib/capabilities";
import { AUTO_FULL_OUTPUT_MAX_BYTES, cn } from "@/lib/utils";
import { HubStreamClient } from "@/lib/ws-client";
import { useFleetStore } from "@/stores/fleet-store";
import {
  getDeliverySourceKey,
  getNativeSessionKey,
  useNativeActivityStore
} from "@/stores/native-activity-store";
import { useTaskStore } from "@/stores/task-store";
import {
  type CenterPaneMode,
  type InspectorTab,
  type LeftRailTab,
  useWorkbenchStore
} from "@/stores/workbench-store";
import type {
  DeliverySourceKind,
  NativeEventView,
  NodeRecord,
  PushEventFilterKey,
  ThreadRecord
} from "@/types";

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
        authScope: string | null;
        leftTab: LeftRailTab;
        centerMode: CenterPaneMode;
        activeTab: InspectorTab;
        nativeEvents: ReturnType<typeof useNativeActivityStore.getState>["events"];
        openInteractionCount: number;
        selectedNativeSessionKey: string | null;
        selectedNativeEventId: string | null;
        deliveriesBySourceKey: ReturnType<
          typeof useNativeActivityStore.getState
        >["deliveriesBySourceKey"];
        pushConfig: ReturnType<typeof useNativeActivityStore.getState>["pushConfig"];
        pushSubscriptions: ReturnType<typeof useNativeActivityStore.getState>["subscriptions"];
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
  const authScope = useWorkbenchStore((s) => s.authScope);
  const streamStatus = useWorkbenchStore((s) => s.streamStatus);
  const leftTab = useWorkbenchStore((s) => s.leftTab);
  const centerMode = useWorkbenchStore((s) => s.centerMode);
  const activeTab = useWorkbenchStore((s) => s.activeTab);
  const threadQuery = useWorkbenchStore((s) => s.threadQuery);
  const onboardingOpen = useWorkbenchStore((s) => s.onboardingOpen);
  const keysDialogOpen = useWorkbenchStore((s) => s.keysDialogOpen);
  const browserNotifyOpen = useWorkbenchStore((s) => s.browserNotifyOpen);
  const mobileLeftOpen = useWorkbenchStore((s) => s.mobileLeftOpen);
  const mobileRightOpen = useWorkbenchStore((s) => s.mobileRightOpen);
  const errorBanner = useWorkbenchStore((s) => s.errorBanner);
  const composerNotice = useWorkbenchStore((s) => s.composerNotice);
  const composer = useWorkbenchStore((s) => s.composer);

  const toggleTheme = useWorkbenchStore((s) => s.toggleTheme);
  const setToken = useWorkbenchStore((s) => s.setToken);
  const setAuthState = useWorkbenchStore((s) => s.setAuthState);
  const setStreamStatus = useWorkbenchStore((s) => s.setStreamStatus);
  const setLeftTab = useWorkbenchStore((s) => s.setLeftTab);
  const setCenterMode = useWorkbenchStore((s) => s.setCenterMode);
  const setActiveTab = useWorkbenchStore((s) => s.setActiveTab);
  const setThreadQuery = useWorkbenchStore((s) => s.setThreadQuery);
  const setOnboardingOpen = useWorkbenchStore((s) => s.setOnboardingOpen);
  const setKeysDialogOpen = useWorkbenchStore((s) => s.setKeysDialogOpen);
  const setBrowserNotifyOpen = useWorkbenchStore((s) => s.setBrowserNotifyOpen);
  const setMobileLeftOpen = useWorkbenchStore((s) => s.setMobileLeftOpen);
  const setMobileRightOpen = useWorkbenchStore((s) => s.setMobileRightOpen);
  const setErrorBanner = useWorkbenchStore((s) => s.setErrorBanner);
  const setComposerNotice = useWorkbenchStore((s) => s.setComposerNotice);
  const patchComposer = useWorkbenchStore((s) => s.patchComposer);

  const nativeEvents = useNativeActivityStore((s) => s.events);
  const openInteractionCount = useNativeActivityStore((s) => s.openInteractionCount);
  const selectedNativeSessionKey = useNativeActivityStore((s) => s.selectedSessionKey);
  const selectedNativeEventId = useNativeActivityStore((s) => s.selectedEventId);
  const nativeViewMode = useNativeActivityStore((s) => s.viewMode);
  const nativeFilterMode = useNativeActivityStore((s) => s.filterMode);
  const nativeOnlySelectedNode = useNativeActivityStore((s) => s.onlySelectedNode);
  const nativeSearchQuery = useNativeActivityStore((s) => s.searchQuery);
  const deliveriesBySourceKey = useNativeActivityStore((s) => s.deliveriesBySourceKey);
  const pushConfig = useNativeActivityStore((s) => s.pushConfig);
  const pushSubscriptions = useNativeActivityStore((s) => s.subscriptions);

  const hydrateNativeEvents = useNativeActivityStore((s) => s.hydrateNativeEvents);
  const upsertNativeEvent = useNativeActivityStore((s) => s.upsertNativeEvent);
  const applySessionAck = useNativeActivityStore((s) => s.applySessionAck);
  const setDeliveries = useNativeActivityStore((s) => s.setDeliveries);
  const upsertDelivery = useNativeActivityStore((s) => s.upsertDelivery);
  const setPushConfig = useNativeActivityStore((s) => s.setPushConfig);
  const setPushSubscriptions = useNativeActivityStore((s) => s.setSubscriptions);
  const selectNativeSession = useNativeActivityStore((s) => s.selectSession);
  const selectNativeEvent = useNativeActivityStore((s) => s.selectEvent);
  const setNativeViewMode = useNativeActivityStore((s) => s.setViewMode);
  const setNativeFilterMode = useNativeActivityStore((s) => s.setFilterMode);
  const setNativeOnlySelectedNode = useNativeActivityStore((s) => s.setOnlySelectedNode);
  const setNativeSearchQuery = useNativeActivityStore((s) => s.setSearchQuery);
  const resetNativeActivity = useNativeActivityStore((s) => s.reset);

  const [submitting, setSubmitting] = useState(false);
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const [botKeys, setBotKeys] = useState<import("@/types").ApiKeyRecord[]>([]);
  const [localEndpointShaPrefix, setLocalEndpointShaPrefix] = useState<string | null>(null);
  const [inPageFallbackEnabled, setInPageFallbackEnabled] = useState<boolean>(() =>
    readInPageFallbackPref()
  );
  const [acknowledgingIds, setAcknowledgingIds] = useState<Record<string, boolean>>({});
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [redeliveringIds, setRedeliveringIds] = useState<Record<string, boolean>>({});
  const wsClientRef = useRef<HubStreamClient | null>(null);
  const hydrationGenRef = useRef<number>(0);
  const inFlightHydrationRef = useRef<Set<string>>(new Set());
  const completedHydrationRef = useRef<Set<string>>(new Set());
  const localEndpointShaRef = useRef<string | null>(null);
  const inPageFallbackRef = useRef<boolean>(inPageFallbackEnabled);
  const hasSession = authStatus === "authenticated" || Boolean(token);

  useEffect(() => {
    localEndpointShaRef.current = localEndpointShaPrefix;
  }, [localEndpointShaPrefix]);

  useEffect(() => {
    inPageFallbackRef.current = inPageFallbackEnabled;
  }, [inPageFallbackEnabled]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Expose read-only runtime state for L2 browser parity verification
  useEffect(() => {
    window.__AHUB_EVAL__ = {
      getState: () => {
        const fleet = useFleetStore.getState();
        const task = useTaskStore.getState();
        const wb = useWorkbenchStore.getState();
        const native = useNativeActivityStore.getState();
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
          authKind: wb.authKind,
          authScope: wb.authScope,
          leftTab: wb.leftTab,
          centerMode: wb.centerMode,
          activeTab: wb.activeTab,
          nativeEvents: native.events,
          openInteractionCount: native.openInteractionCount,
          selectedNativeSessionKey: native.selectedSessionKey,
          selectedNativeEventId: native.selectedEventId,
          deliveriesBySourceKey: native.deliveriesBySourceKey,
          pushConfig: native.pushConfig,
          pushSubscriptions: native.subscriptions
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

  const applyTargetUrlNavigation = useCallback(
    (targetUrl: string) => {
      try {
        const url = new URL(targetUrl, window.location.origin);
        const pane = url.searchParams.get("pane");
        const session = url.searchParams.get("session");
        const eventId = url.searchParams.get("event");
        const runId = url.searchParams.get("run");
        const threadId = url.searchParams.get("thread");
        const scope = useWorkbenchStore.getState().authScope;

        if (pane === "native" && scope === "admin") {
          setLeftTab("native");
          setCenterMode("native");
          if (session) selectNativeSession(session);
          if (eventId) {
            selectNativeEvent(eventId);
            const matchedEvent = useNativeActivityStore
              .getState()
              .events.find((ev) => ev.id === eventId);
            if (matchedEvent) {
              if (!session) {
                selectNativeSession(getNativeSessionKey(matchedEvent));
              }
            } else {
              void apiClient
                .fetchNativeEventDetail(token, eventId)
                .then((res) => {
                  upsertNativeEvent(res.event);
                  selectNativeSession(session || getNativeSessionKey(res.event));
                  setDeliveries(
                    getDeliverySourceKey("native_event", res.event.id),
                    res.deliveries
                  );
                })
                .catch(() => {});
            }
          }
          setMobileLeftOpen(false);
          return;
        }

        if (runId || threadId) {
          setLeftTab("threads");
          setCenterMode("controlled");
          const curRuns = useTaskStore.getState().runs;
          const targetRun = runId ? curRuns.find((r) => r.id === runId) : undefined;
          const targetThreadId = threadId || targetRun?.thread_id;
          if (targetThreadId) {
            selectThread(targetThreadId);
          }
          if (runId) {
            selectRun(runId);
          }
          setMobileLeftOpen(false);
        }
      } catch {
        // ignore malformed target URLs
      }
    },
    [
      selectNativeEvent,
      selectNativeSession,
      selectRun,
      selectThread,
      setCenterMode,
      setDeliveries,
      setLeftTab,
      setMobileLeftOpen,
      token,
      upsertNativeEvent
    ]
  );

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    const onSwMessage = (evt: MessageEvent) => {
      const data = evt.data as { type?: string; target_url?: string } | null;
      if (data?.type === "ahub:navigate" && typeof data.target_url === "string") {
        applyTargetUrlNavigation(data.target_url);
      }
    };
    navigator.serviceWorker.addEventListener("message", onSwMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onSwMessage);
    };
  }, [applyTargetUrlNavigation]);

  // Initial REST hydrate (supports Cloudflare Access same-origin cookie or Bearer token) + live WebSocket subscription
  useEffect(() => {
    let cancelled = false;
    let client: HubStreamClient | null = null;
    hydrationGenRef.current += 1;
    inFlightHydrationRef.current.clear();
    completedHydrationRef.current.clear();
    setAuthState("checking", null, null);
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
        setAuthState("authenticated", meRes.principal.kind, meRes.principal.scope);
        setNodes(nodesRes.nodes);
        setThreads(threadsRes.threads);
        setRuns(runsRes.runs);
        syncDefaultSelection();
        setErrorBanner(null);

        if (meRes.principal.scope === "admin") {
          initBrowserNotifyCoordinator();
          void getCurrentDevicePushInfo().then((info) => {
            if (!cancelled) {
              setLocalEndpointShaPrefix(info?.endpointSha256Prefix ?? null);
            }
          });
          void Promise.allSettled([
            apiClient.fetchNativeEvents(token, { limit: 100 }),
            apiClient.fetchPushConfig(token),
            apiClient.fetchPushSubscriptions(token, false)
          ]).then(([nativeRes, cfgRes, subsRes]) => {
            if (cancelled) return;
            if (nativeRes.status === "fulfilled") {
              hydrateNativeEvents(nativeRes.value.events, nativeRes.value.open_interaction_count);
            }
            if (cfgRes.status === "fulfilled") {
              setPushConfig({
                enabled: cfgRes.value.enabled,
                vapid_public_key: cfgRes.value.vapid_public_key,
                ...(cfgRes.value.reason ? { reason: cfgRes.value.reason } : {})
              });
            }
            if (subsRes.status === "fulfilled") {
              setPushSubscriptions(subsRes.value.subscriptions);
            }
            if (window.location.search) {
              applyTargetUrlNavigation(window.location.href);
            }
          });

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
                  hydrateNativeEvents(frame.native_events ?? [], frame.open_interaction_count);
                  syncDefaultSelection();
                  break;
                case "node.status":
                  upsertNode(frame.node);
                  break;
                case "run.updated": {
                  const prevRun = useTaskStore.getState().runs.find((r) => r.id === frame.run.id);
                  upsertRun(frame.run);
                  const filterKey = mapRunStatusToFilterKey(frame.run.status);
                  if (
                    filterKey &&
                    prevRun?.status !== frame.run.status &&
                    (frame.run.status === "needs_approval" || frame.run.status === "failed")
                  ) {
                    const nativeState = useNativeActivityStore.getState();
                    void notifyInPageWithDedup({
                      eventKey: `ahub-run-${frame.run.id}-${frame.run.status}`,
                      title: `[${frame.run.node_id} · ${frame.run.agent}] ${
                        frame.run.status === "needs_approval" ? "等待人工审批" : "任务执行失败"
                      }`,
                      body: frame.run.summary || frame.run.error_message || frame.run.id,
                      targetUrl: `/?run=${encodeURIComponent(frame.run.id)}`,
                      nodeId: frame.run.node_id,
                      filterKey,
                      pushConfig: nativeState.pushConfig,
                      subscriptions: nativeState.subscriptions,
                      localEndpointSha256Prefix: localEndpointShaRef.current,
                      inPageEnabled: inPageFallbackRef.current,
                      onNavigate: applyTargetUrlNavigation
                    });
                  }
                  if (!useTaskStore.getState().threads.some((t) => t.id === frame.run.thread_id)) {
                    void apiClient
                      .fetchThreads(token)
                      .then((res) => {
                        if (!cancelled) setThreads(res.threads);
                      })
                      .catch(() => {});
                  }
                  break;
                }
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
                case "native_event.upserted": {
                  const prevEv = useNativeActivityStore
                    .getState()
                    .events.find((e) => e.id === frame.event.id);
                  upsertNativeEvent(frame.event, frame.open_interaction_count);
                  const isNewEvent = !prevEv;
                  if (isNewEvent && frame.event.event_kind === "interaction_needed") {
                    const nativeState = useNativeActivityStore.getState();
                    const sKey = getNativeSessionKey(frame.event);
                    void notifyInPageWithDedup({
                      eventKey: `ahub-native-${frame.event.id}`,
                      title: `[${frame.event.node_id} · ${frame.event.agent}] ${
                        frame.event.title || "需要终端互动确认"
                      }`,
                      body: frame.event.summary || frame.event.workdir,
                      targetUrl: `/?pane=native&session=${encodeURIComponent(sKey)}&event=${encodeURIComponent(frame.event.id)}`,
                      nodeId: frame.event.node_id,
                      filterKey: mapNativeKindToFilterKey(frame.event.event_kind),
                      pushConfig: nativeState.pushConfig,
                      subscriptions: nativeState.subscriptions,
                      localEndpointSha256Prefix: localEndpointShaRef.current,
                      inPageEnabled: inPageFallbackRef.current,
                      onNavigate: applyTargetUrlNavigation
                    });
                  }
                  break;
                }
                case "delivery.updated":
                  upsertDelivery(frame.delivery);
                  break;
              }
            }
          });
          wsClientRef.current = client;
          client.start();
        } else {
          resetNativeActivity();
          setLeftTab("threads");
          setCenterMode("controlled");
          if (useWorkbenchStore.getState().activeTab === "deliveries") {
            setActiveTab("events");
          }
          setStreamStatus("disconnected");
        }
      } catch (err) {
        if (cancelled) return;
        setStreamStatus("disconnected");
        if (err instanceof ApiClientError && err.status === 401) {
          setAuthState("unauthenticated", null, null);
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
      hydrationGenRef.current += 1;
      inFlightHydrationRef.current.clear();
      completedHydrationRef.current.clear();
      if (client) {
        client.stop();
      }
      wsClientRef.current = null;
    };
  }, [
    token,
    appendEvents,
    applyTargetUrlNavigation,
    hydrateNativeEvents,
    resetNativeActivity,
    setActiveTab,
    setAuthState,
    setCenterMode,
    setErrorBanner,
    setLeftTab,
    setNodes,
    setPushConfig,
    setPushSubscriptions,
    setRuns,
    setStreamStatus,
    setThreads,
    syncDefaultSelection,
    upsertDelivery,
    upsertNativeEvent,
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

  // Hydrate outputs for runs in active thread (auto full up to 128 KB, summary preview above 128 KB)
  useEffect(() => {
    if (!hasSession || threadRuns.length === 0) return;
    const gen = hydrationGenRef.current;

    for (const run of [...threadRuns].reverse()) {
      const canHaveOutput =
        run.status === "done" ||
        run.status === "failed" ||
        run.status === "cancelled" ||
        run.status === "needs_approval";
      if (!canHaveOutput || run.output_bytes <= 0) {
        continue;
      }

      const targetView: "full" | "summary" =
        run.output_bytes <= AUTO_FULL_OUTPUT_MAX_BYTES ? "full" : "summary";

      const alreadyHydrated =
        targetView === "full"
          ? fullOutputByRunId[run.id] !== undefined ||
            run.output_md !== undefined ||
            (run.output_preview !== undefined && run.truncated === false)
          : fullOutputByRunId[run.id] !== undefined ||
            run.output_md !== undefined ||
            run.output_preview !== undefined;

      if (alreadyHydrated) {
        continue;
      }

      const key = `${run.id}:${run.status}:${run.output_bytes}:${targetView}`;
      if (inFlightHydrationRef.current.has(key) || completedHydrationRef.current.has(key)) {
        continue;
      }

      inFlightHydrationRef.current.add(key);
      void apiClient
        .fetchRunDetail(token, run.id, targetView)
        .then((res) => {
          if (hydrationGenRef.current !== gen) return;
          completedHydrationRef.current.add(key);
          upsertRun(res.run);
          if (res.run.output_md !== undefined) {
            setFullOutput(run.id, res.run.output_md);
          }
        })
        .catch(() => {
          // non-fatal background sync; keeping key out of completedHydrationRef allows retry
        })
        .finally(() => {
          inFlightHydrationRef.current.delete(key);
        });
    }
  }, [fullOutputByRunId, hasSession, setFullOutput, threadRuns, token, upsertRun]);

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

  const selectedNativeSessionEvents = useMemo(() => {
    if (nativeViewMode === "timeline") {
      if (selectedNativeEventId) {
        const target = nativeEvents.find((e) => e.id === selectedNativeEventId);
        if (target) {
          const sKey = getNativeSessionKey(target);
          return nativeEvents.filter((e) => getNativeSessionKey(e) === sKey);
        }
      }
      return nativeEvents;
    }
    if (!selectedNativeSessionKey) {
      return [];
    }
    return nativeEvents.filter((e) => getNativeSessionKey(e) === selectedNativeSessionKey);
  }, [nativeEvents, nativeViewMode, selectedNativeEventId, selectedNativeSessionKey]);

  const activeNativeEvent = useMemo(() => {
    if (selectedNativeEventId) {
      const found = nativeEvents.find((e) => e.id === selectedNativeEventId);
      if (found) return found;
    }
    return selectedNativeSessionEvents[0] ?? null;
  }, [nativeEvents, selectedNativeEventId, selectedNativeSessionEvents]);

  const deliveryTarget = useMemo(() => {
    if (authScope !== "admin") return null;
    if (centerMode === "native" && activeNativeEvent) {
      return { kind: "native_event" as const, event: activeNativeEvent };
    }
    if (selectedRun) {
      return { kind: "run" as const, run: selectedRun };
    }
    return null;
  }, [activeNativeEvent, authScope, centerMode, selectedRun]);

  const activeDeliveries = useMemo(() => {
    if (!deliveryTarget) return [];
    const key =
      deliveryTarget.kind === "native_event"
        ? getDeliverySourceKey("native_event", deliveryTarget.event.id)
        : getDeliverySourceKey("run", deliveryTarget.run.id);
    return deliveriesBySourceKey[key] ?? [];
  }, [deliveriesBySourceKey, deliveryTarget]);

  const deliveryTargetKind: DeliverySourceKind | null = deliveryTarget?.kind ?? null;
  const deliveryTargetId: string | null =
    deliveryTarget?.kind === "native_event"
      ? deliveryTarget.event.id
      : deliveryTarget?.kind === "run"
        ? deliveryTarget.run.id
        : null;

  useEffect(() => {
    if (
      !hasSession ||
      authStatus !== "authenticated" ||
      authScope !== "admin" ||
      activeTab !== "deliveries" ||
      !deliveryTargetKind ||
      !deliveryTargetId
    ) {
      return;
    }
    let cancelled = false;
    setDeliveriesLoading(true);
    if (deliveryTargetKind === "native_event") {
      const evId = deliveryTargetId;
      void apiClient
        .fetchNativeEventDetail(token, evId)
        .then((res) => {
          if (cancelled) return;
          upsertNativeEvent(res.event);
          setDeliveries(getDeliverySourceKey("native_event", evId), res.deliveries);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setDeliveriesLoading(false);
        });
    } else {
      const runId = deliveryTargetId;
      void apiClient
        .fetchRunDeliveries(token, runId)
        .then((res) => {
          if (cancelled) return;
          setDeliveries(getDeliverySourceKey("run", runId), res.deliveries);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setDeliveriesLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    authScope,
    authStatus,
    deliveryTargetId,
    deliveryTargetKind,
    hasSession,
    setDeliveries,
    token,
    upsertNativeEvent
  ]);

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

  const localPushActive = useMemo(
    () =>
      Boolean(
        localEndpointShaPrefix &&
          pushSubscriptions.some(
            (s) =>
              s.endpoint_sha256_prefix === localEndpointShaPrefix && s.enabled && !s.revoked_at
          )
      ),
    [localEndpointShaPrefix, pushSubscriptions]
  );

  function handleSelectThreadById(threadId: string) {
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) return;
    selectThread(thread.id);
    selectNode(thread.node_id);
    setCenterMode("controlled");
    setComposerNotice(null);
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
    setCenterMode("controlled");
    setComposerNotice(null);
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
    setLeftTab("threads");
    setCenterMode("controlled");
    setComposerNotice(null);
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

  function handleLeftTabChange(nextTab: LeftRailTab) {
    setLeftTab(nextTab);
    if (nextTab === "native" && authScope === "admin") {
      setCenterMode("native");
    } else if (nextTab === "threads") {
      setCenterMode("controlled");
    }
  }

  function handleSelectNativeSession(sessionKey: string) {
    selectNativeSession(sessionKey);
    const match = nativeEvents.find((ev) => getNativeSessionKey(ev) === sessionKey);
    if (match) {
      selectNativeEvent(match.id);
      selectNode(match.node_id);
    }
    setLeftTab("native");
    setCenterMode("native");
    setMobileLeftOpen(false);
  }

  function handleSelectNativeEvent(eventId: string) {
    selectNativeEvent(eventId);
    const match = nativeEvents.find((ev) => ev.id === eventId);
    if (match) {
      selectNativeSession(getNativeSessionKey(match));
      selectNode(match.node_id);
    }
    setLeftTab("native");
    setCenterMode("native");
    setMobileLeftOpen(false);
  }

  async function handleAckNativeEvent(eventId: string, scope: "single" | "session") {
    if (!hasSession || authScope !== "admin") return;
    setAcknowledgingIds((prev) => ({ ...prev, [eventId]: true }));
    try {
      const res = await apiClient.ackNativeEvent(token, eventId, scope);
      applySessionAck(res.event, scope, res.open_interaction_count);
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : "确认原生活动失败");
    } finally {
      setAcknowledgingIds((prev) => {
        const next = { ...prev };
        delete next[eventId];
        return next;
      });
    }
  }

  function handleOpenNativeDeliveries(eventId: string) {
    selectNativeEvent(eventId);
    setCenterMode("native");
    setActiveTab("deliveries");
    if (!isDesktop) {
      setMobileRightOpen(true);
    }
  }

  function handleSelectRunFromInspector(runId: string) {
    const targetRun = runs.find((r) => r.id === runId);
    if (targetRun) {
      selectThread(targetRun.thread_id);
    }
    selectRun(runId);
    setCenterMode("controlled");
    if (!isDesktop) {
      setMobileRightOpen(false);
    }
  }

  function handleOpenRunEvents(runId: string) {
    const targetRun = runs.find((r) => r.id === runId);
    if (targetRun) {
      selectThread(targetRun.thread_id);
    }
    selectRun(runId);
    setActiveTab("events");
    if (!isDesktop) {
      setMobileRightOpen(true);
    }
  }

  function handleOpenRunDeliveries(runId: string) {
    if (authScope !== "admin") return;
    const targetRun = runs.find((r) => r.id === runId);
    if (targetRun) {
      selectThread(targetRun.thread_id);
    }
    selectRun(runId);
    setActiveTab("deliveries");
    if (!isDesktop) {
      setMobileRightOpen(true);
    }
  }

  async function handleRedeliverChannel(
    sourceKind: DeliverySourceKind,
    sourceId: string,
    deliveryId?: string
  ) {
    if (!hasSession || authScope !== "admin") return;
    const busyKey = deliveryId || sourceId;
    setRedeliveringIds((prev) => ({ ...prev, [busyKey]: true }));
    try {
      if (sourceKind === "native_event") {
        const res = await apiClient.redeliverNativeEvent(token, sourceId, deliveryId);
        upsertNativeEvent(res.event);
        setDeliveries(getDeliverySourceKey("native_event", sourceId), res.deliveries);
      } else {
        const res = await apiClient.redeliverRun(token, sourceId, deliveryId);
        upsertRun(res.run);
        setDeliveries(getDeliverySourceKey("run", sourceId), res.deliveries);
      }
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : "重推通知失败");
    } finally {
      setRedeliveringIds((prev) => {
        const next = { ...prev };
        delete next[busyKey];
        return next;
      });
    }
  }

  function handleCreateControlledRunFromNative(
    anchorEvent: NativeEventView,
    sessionEvents: NativeEventView[]
  ) {
    const targetNode = nodes.find((n) => n.id === anchorEvent.node_id) ?? null;
    const available = getAvailableAgents(targetNode);
    const isGrok = anchorEvent.agent === "grok";
    const nextAgent: import("@/types").AgentName =
      anchorEvent.agent !== "grok" && available.includes(anchorEvent.agent)
        ? anchorEvent.agent
        : (available[0] ?? "agy");
    const { model, effort } = resolveInitialComposerModelAndEffort(targetNode, nextAgent);
    const latestWithSummary =
      [...sessionEvents].reverse().find((ev) => ev.summary.trim() || ev.title.trim()) ??
      anchorEvent;
    const summaryBlock = [latestWithSummary.title, latestWithSummary.summary]
      .filter((s) => Boolean(s && s.trim()))
      .join("\n\n")
      .slice(0, 1200);
    const prefilledPrompt = [
      `请基于以下本机原生会话摘要继续处理（来源：${anchorEvent.node_id} · ${anchorEvent.agent}${anchorEvent.workdir ? ` · ${anchorEvent.workdir}` : ""}）：`,
      "",
      summaryBlock
    ]
      .join("\n")
      .trim();

    selectThread(null);
    selectNode(anchorEvent.node_id);
    setLeftTab("threads");
    setCenterMode("controlled");
    patchComposer({
      mode: "new",
      nodeId: anchorEvent.node_id,
      workdir: anchorEvent.workdir || targetNode?.workspaces?.[0]?.path || "",
      agent: nextAgent,
      model,
      effort,
      prompt: prefilledPrompt
    });
    setComposerNotice(
      isGrok ? "`grok` 暂不支持无头受控执行，已自动切换为该节点可用的受控 Agent。" : null
    );
    setMobileLeftOpen(false);
    setMobileRightOpen(false);
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
      setCenterMode("controlled");
      patchComposer({
        mode: "reply",
        nodeId: res.thread.node_id,
        workdir: res.thread.workdir,
        agent: res.thread.agent,
        model: "",
        effort: ""
      });
      setMobileLeftOpen(false);
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : "分叉线程失败");
    }
  }

  async function handleLoadFullOutput(runId: string) {
    if (!hasSession) return;
    try {
      const res = await apiClient.fetchRunDetail(token, runId, "full");
      upsertRun(res.run);
      if (res.run.output_md !== undefined) {
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

  useEffect(() => {
    if (!hasSession || authStatus !== "authenticated" || authScope !== "admin") {
      setBotKeys([]);
      return;
    }
    if (keysDialogOpen) {
      return;
    }
    let cancelled = false;
    void apiClient
      .fetchKeys(token)
      .then((res) => {
        if (!cancelled) {
          setBotKeys(res.keys);
        }
      })
      .catch(() => {
        if (!cancelled) setBotKeys([]);
      });
    return () => {
      cancelled = true;
    };
  }, [authScope, authStatus, hasSession, keysDialogOpen, token]);

  async function handleUpdateNodeDefaultNotify(nodeId: string, keyId: string | null) {
    if (!hasSession) return;
    try {
      const res = await apiClient.patchNode(token, nodeId, {
        default_notify_key_id: keyId
      });
      upsertNode(res.node);
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : "更新默认通知通道失败");
    }
  }

  async function handleUpdateNodeDefaultNotifyEvents(
    nodeId: string,
    events: PushEventFilterKey[]
  ) {
    if (!hasSession) return;
    try {
      const res = await apiClient.patchNode(token, nodeId, {
        default_notify_events: events
      });
      upsertNode(res.node);
    } catch (err) {
      setErrorBanner(err instanceof ApiClientError ? err.message : "更新默认推送事件失败");
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
    canViewNative: authScope === "admin",
    leftTab,
    onLeftTabChange: handleLeftTabChange,
    nativeEvents,
    openInteractionCount,
    selectedNativeSessionKey,
    selectedNativeEventId,
    nativeViewMode,
    nativeFilterMode,
    nativeOnlySelectedNode,
    nativeSearchQuery,
    onSelectNativeSession: handleSelectNativeSession,
    onSelectNativeEvent: handleSelectNativeEvent,
    onNativeViewModeChange: setNativeViewMode,
    onNativeFilterModeChange: setNativeFilterMode,
    onNativeOnlySelectedNodeChange: setNativeOnlySelectedNode,
    onNativeSearchQueryChange: setNativeSearchQuery,
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
    botKeys,
    events: selectedRunEvents,
    canViewDeliveries: authScope === "admin",
    deliveryTarget,
    deliveries: activeDeliveries,
    deliveriesLoading,
    redeliveringIds,
    onRedeliverChannel: authScope === "admin" ? handleRedeliverChannel : undefined,
    onSelectRun: handleSelectRunFromInspector,
    onCancelRun: handleCancelRun,
    onToggleNodeDrain: handleToggleNodeDrain,
    onUpdateNodeConcurrency: handleUpdateNodeConcurrency,
    onUpdateNodeDefaultNotify: authScope === "admin" ? handleUpdateNodeDefaultNotify : undefined,
    onUpdateNodeDefaultNotifyEvents:
      authScope === "admin" ? handleUpdateNodeDefaultNotifyEvents : undefined,
    onPickWorkspace: handlePickWorkspace
  };

  const conversationElement =
    authScope === "admin" && centerMode === "native" ? (
      <NativeActivityPane
        events={selectedNativeSessionEvents}
        selectedEventId={activeNativeEvent?.id ?? null}
        hasActiveFilter={Boolean(
          nativeSearchQuery.trim() || nativeFilterMode !== "all" || nativeOnlySelectedNode
        )}
        acknowledgingIds={acknowledgingIds}
        onSelectEvent={selectNativeEvent}
        onAckEvent={handleAckNativeEvent}
        onOpenDeliveries={handleOpenNativeDeliveries}
        onCreateControlledRun={handleCreateControlledRunFromNative}
      />
    ) : (
      <ConversationPane
        nodes={nodes}
        selectedThread={selectedThread}
        threadRuns={threadRuns}
        selectedRunId={selectedRun?.id ?? null}
        hasLineage={hasLineage}
        fullOutputByRunId={fullOutputByRunId}
        eventsByRunId={eventsByRunId}
        composer={composer}
        composerNotice={composerNotice}
        submitting={submitting}
        onPatchComposer={patchComposer}
        onDismissComposerNotice={() => setComposerNotice(null)}
        onSelectRun={selectRun}
        onLoadFullOutput={handleLoadFullOutput}
        onCancelRun={handleCancelRun}
        onResolveRun={handleResolveRun}
        onForkThread={handleForkThread}
        onOpenLineage={() => {
          setActiveTab("lineage");
          if (!isDesktop) setMobileRightOpen(true);
        }}
        onOpenRunEvents={handleOpenRunEvents}
        onOpenRunDeliveries={authScope === "admin" ? handleOpenRunDeliveries : undefined}
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
      <div className="relative flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
        {/* Global slim header bar */}
        <header className="shrink-0 border-b border-border bg-card pt-[var(--safe-top)] pl-[max(0.375rem,var(--safe-left))] pr-[max(0.375rem,var(--safe-right))] sm:pl-[max(0.75rem,var(--safe-left))] sm:pr-[max(0.75rem,var(--safe-right))]">
          <div className="flex h-12 w-full items-center justify-between gap-1 sm:gap-2">
            <div className="flex min-w-0 items-center gap-1 sm:gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setMobileLeftOpen(true)}
                className="relative h-11 w-11 shrink-0 md:hidden"
                aria-label="打开节点与会话列表"
                data-testid="mobile-left-trigger"
              >
                <PanelLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                {authScope === "admin" && openInteractionCount > 0 ? (
                  <span
                    aria-hidden="true"
                    className="absolute right-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--status-approval)] px-1 text-[10px] font-semibold text-black tabular-nums"
                  >
                    {openInteractionCount}
                  </span>
                ) : null}
              </Button>

              <div className="flex min-w-0 items-center gap-1.5 px-0.5 sm:px-1">
                <BrandMark
                  streamStatus={streamStatus}
                  className="h-[18px] w-[18px] shrink-0 text-foreground"
                />
                <h1 className="truncate font-mono text-xs sm:text-sm font-semibold tracking-tight">
                  agent-hub
                </h1>
                <span className="shrink-0 rounded-[4px] border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums sm:hidden">
                  在线 {fleetTelemetry.online}/{fleetTelemetry.total}
                </span>
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

            <div className="flex shrink-0 items-center gap-0.5 sm:gap-1.5">
              {authScope === "admin" ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setLeftTab("native");
                      setNativeFilterMode("unacked");
                      setCenterMode("native");
                    }}
                    data-testid="open-interactions-pill"
                    className={cn(
                      "hidden sm:inline-flex min-h-11 min-w-11 px-2.5 md:min-h-8 md:h-8 md:px-2.5 font-mono text-[11px] tabular-nums",
                      openInteractionCount > 0 &&
                        "border-[var(--status-approval)]/60 bg-[var(--status-approval)]/12 text-[var(--status-approval)] hover:bg-[var(--status-approval)]/20"
                    )}
                  >
                    互动 {openInteractionCount}
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setBrowserNotifyOpen(true)}
                    className="relative h-11 w-11 p-0 sm:w-auto sm:min-h-11 sm:min-w-11 sm:px-2.5 md:min-h-8 md:h-8 md:px-2.5"
                    aria-label="通知渠道"
                    data-testid="open-browser-notify-btn"
                  >
                    <Bell className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                    <span className="hidden md:inline">通知渠道</span>
                    {localPushActive ? (
                      <span
                        aria-hidden="true"
                        className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[var(--status-done)] sm:static"
                      />
                    ) : null}
                  </Button>
                </>
              ) : null}

              <Button
                type="button"
                variant="outline"
                onClick={() => setOnboardingOpen(true)}
                className="hidden sm:inline-flex sm:min-h-11 sm:min-w-11 sm:px-2.5 md:min-h-8 md:h-8 md:px-2.5"
                aria-label="接入节点"
                data-testid="open-onboarding-btn"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                <span>接入节点</span>
              </Button>

              <Button
                type="button"
                variant="outline"
                onClick={() => setKeysDialogOpen(true)}
                className="hidden sm:inline-flex sm:min-h-11 sm:min-w-11 sm:px-2.5 md:min-h-8 md:h-8 md:px-2.5"
                aria-label="API Keys"
                data-testid="open-keys-btn"
              >
                <KeyRound className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                <span>API Keys</span>
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={toggleTheme}
                className="hidden sm:inline-flex sm:h-11 sm:w-11 shrink-0 md:h-8 md:w-8"
                aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"}
                data-testid="theme-toggle-btn"
              >
                {theme === "dark" ? (
                  <Sun className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <Moon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                )}
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 shrink-0 sm:hidden"
                    aria-label="更多管理与外观选项"
                    data-testid="mobile-more-menu-btn"
                  >
                    <Ellipsis className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    data-testid="mobile-menu-onboarding"
                    onSelect={() => setOnboardingOpen(true)}
                  >
                    <Plus className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
                    <span>接入节点与 Token</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid="mobile-menu-keys"
                    onSelect={() => setKeysDialogOpen(true)}
                  >
                    <KeyRound className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
                    <span>API Keys 凭证管理</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid="mobile-menu-theme"
                    onSelect={toggleTheme}
                  >
                    {theme === "dark" ? (
                      <Sun className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
                    ) : (
                      <Moon className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
                    )}
                    <span>{theme === "dark" ? "切换浅色主题" : "切换深色主题"}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setMobileRightOpen(true)}
                className="relative h-11 w-11 shrink-0 md:hidden"
                aria-label="打开检视面板"
                data-testid="mobile-right-trigger"
              >
                <PanelRight className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                {fleetTelemetry.approval > 0 ? (
                  <span
                    data-testid="mobile-right-badge"
                    aria-hidden="true"
                    className="absolute right-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--status-approval)] px-1 text-[10px] font-semibold text-black tabular-nums"
                  >
                    {fleetTelemetry.approval}
                  </span>
                ) : fleetTelemetry.running + fleetTelemetry.queued > 0 ? (
                  <span
                    data-testid="mobile-right-badge"
                    aria-hidden="true"
                    className="absolute right-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--status-running)] px-1 text-[10px] font-semibold text-white tabular-nums"
                  >
                    {fleetTelemetry.running + fleetTelemetry.queued}
                  </span>
                ) : null}
              </Button>
            </div>
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
        <main className="relative min-h-0 flex-1 overflow-hidden">
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
            <InspectorPane {...inspectorProps} inDrawer />
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
          onOpenChange={(open) => {
            setKeysDialogOpen(open);
            if (!open && hasSession && authScope === "admin") {
              void apiClient
                .fetchNodes(token)
                .then((res) => setNodes(res.nodes))
                .catch(() => undefined);
            }
          }}
          token={token}
          authenticated={authStatus === "authenticated"}
          authKind={authKind}
        />

        {authScope === "admin" ? (
          <BrowserNotifyDialog
            open={browserNotifyOpen}
            onOpenChange={setBrowserNotifyOpen}
            token={token}
            nodes={nodes}
            pushConfig={pushConfig}
            subscriptions={pushSubscriptions}
            localEndpointSha256Prefix={localEndpointShaPrefix}
            inPageFallbackEnabled={inPageFallbackEnabled}
            onToggleInPageFallback={(enabled) => {
              writeInPageFallbackPref(enabled);
              setInPageFallbackEnabled(enabled);
            }}
            onSubscriptionsChange={setPushSubscriptions}
            onLocalEndpointChange={(prefix) => {
              localEndpointShaRef.current = prefix;
              setLocalEndpointShaPrefix(prefix);
            }}
          />
        ) : null}
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
