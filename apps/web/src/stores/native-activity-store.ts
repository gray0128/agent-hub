import { create } from "zustand";
import type {
  AttentionState,
  DeliverySourceKind,
  NativeEventView,
  NotificationDeliveryRecord,
  PushConfigRecord,
  WebPushSubscriptionRecord
} from "@/types";

export const INTERACTION_STALE_MS = 86_400_000;

export function getNativeSessionKey(
  ev: Pick<NativeEventView, "node_id" | "agent" | "native_session_id" | "workdir">
): string {
  const sid = ev.native_session_id.trim();
  return sid ? `${ev.node_id}:${ev.agent}:${sid}` : `${ev.node_id}:${ev.agent}:${ev.workdir}`;
}

export function getDeliverySourceKey(sourceKind: DeliverySourceKind, sourceId: string): string {
  return `${sourceKind}:${sourceId}`;
}

export function deriveNativeAttentionState(
  event: NativeEventView,
  allEvents: NativeEventView[],
  nowMs = Date.now()
): AttentionState | null {
  if (event.event_kind !== "interaction_needed") {
    return null;
  }
  if (event.ack_at !== null) {
    return "acked";
  }
  if (event.native_session_id !== "") {
    const hasLaterEvent = allEvents.some(
      (other) =>
        other.id !== event.id &&
        other.node_id === event.node_id &&
        other.agent === event.agent &&
        other.native_session_id === event.native_session_id &&
        (other.created_at > event.created_at ||
          (other.created_at === event.created_at && other.id > event.id))
    );
    if (hasLaterEvent || event.attention_state === "superseded") {
      return "superseded";
    }
  }
  const createdMs = Date.parse(event.created_at);
  if (Number.isFinite(createdMs) && nowMs - createdMs > INTERACTION_STALE_MS) {
    return "stale";
  }
  return "open";
}

function compareEventsDesc(a: NativeEventView, b: NativeEventView): number {
  if (a.created_at !== b.created_at) {
    return b.created_at.localeCompare(a.created_at);
  }
  return b.id.localeCompare(a.id);
}

function compareDeliveriesAsc(a: NotificationDeliveryRecord, b: NotificationDeliveryRecord): number {
  if (a.created_at !== b.created_at) {
    return a.created_at.localeCompare(b.created_at);
  }
  return a.id.localeCompare(b.id);
}

function recomputeEvents(events: NativeEventView[]): NativeEventView[] {
  const dedup = new Map<string, NativeEventView>();
  for (const ev of events) {
    dedup.set(ev.id, ev);
  }
  const sorted = Array.from(dedup.values()).sort(compareEventsDesc);
  const nowMs = Date.now();
  return sorted.map((ev) => ({
    ...ev,
    attention_state: deriveNativeAttentionState(ev, sorted, nowMs)
  }));
}

export interface NativeSessionGroup {
  sessionKey: string;
  nodeId: string;
  agent: NativeEventView["agent"];
  nativeSessionId: string;
  workdir: string;
  latestEvent: NativeEventView;
  events: NativeEventView[];
  openInteractionCount: number;
  failedDeliveryCount: number;
}

export function groupNativeSessions(events: NativeEventView[]): NativeSessionGroup[] {
  const byKey = new Map<string, NativeEventView[]>();
  for (const ev of events) {
    const key = getNativeSessionKey(ev);
    const list = byKey.get(key);
    if (list) {
      list.push(ev);
    } else {
      byKey.set(key, [ev]);
    }
  }

  const groups: NativeSessionGroup[] = [];
  for (const [sessionKey, list] of byKey.entries()) {
    const sortedDesc = [...list].sort(compareEventsDesc);
    const latestEvent = sortedDesc[0];
    const openCount = sortedDesc.filter((ev) => ev.attention_state === "open").length;
    const failedCount = sortedDesc.filter(
      (ev) => ev.notify_status === "failed" || ev.notify_status === "partial"
    ).length;
    groups.push({
      sessionKey,
      nodeId: latestEvent.node_id,
      agent: latestEvent.agent,
      nativeSessionId: latestEvent.native_session_id,
      workdir: latestEvent.workdir,
      latestEvent,
      events: [...sortedDesc].reverse(),
      openInteractionCount: openCount,
      failedDeliveryCount: failedCount
    });
  }

  return groups.sort((a, b) => compareEventsDesc(a.latestEvent, b.latestEvent));
}

export interface NativeActivityState {
  events: NativeEventView[];
  openInteractionCount: number;
  selectedSessionKey: string | null;
  selectedEventId: string | null;
  viewMode: "sessions" | "timeline";
  filterMode: "all" | "unacked" | "failed";
  onlySelectedNode: boolean;
  searchQuery: string;
  deliveriesBySourceKey: Record<string, NotificationDeliveryRecord[]>;
  pushConfig: PushConfigRecord | null;
  subscriptions: WebPushSubscriptionRecord[];
  hydrateNativeEvents: (events: NativeEventView[], openCount?: number) => void;
  upsertNativeEvent: (event: NativeEventView, openCount?: number) => void;
  applySessionAck: (event: NativeEventView, scope: "single" | "session", openCount?: number) => void;
  setDeliveries: (sourceKey: string, deliveries: NotificationDeliveryRecord[]) => void;
  upsertDelivery: (delivery: NotificationDeliveryRecord) => void;
  setPushConfig: (config: PushConfigRecord | null) => void;
  setSubscriptions: (subscriptions: WebPushSubscriptionRecord[]) => void;
  selectSession: (sessionKey: string | null) => void;
  selectEvent: (eventId: string | null) => void;
  setViewMode: (mode: NativeActivityState["viewMode"]) => void;
  setFilterMode: (mode: NativeActivityState["filterMode"]) => void;
  setOnlySelectedNode: (only: boolean) => void;
  setSearchQuery: (q: string) => void;
  reset: () => void;
}

export const useNativeActivityStore = create<NativeActivityState>((set) => ({
  events: [],
  openInteractionCount: 0,
  selectedSessionKey: null,
  selectedEventId: null,
  viewMode: "sessions",
  filterMode: "all",
  onlySelectedNode: false,
  searchQuery: "",
  deliveriesBySourceKey: {},
  pushConfig: null,
  subscriptions: [],

  hydrateNativeEvents: (incoming, openCount) =>
    set((state) => {
      const nextEvents = recomputeEvents(incoming);
      const nextOpenCount =
        openCount !== undefined
          ? openCount
          : nextEvents.filter((ev) => ev.attention_state === "open").length;

      let nextSessionKey = state.selectedSessionKey;
      if (
        nextSessionKey &&
        !nextEvents.some((ev) => getNativeSessionKey(ev) === nextSessionKey)
      ) {
        nextSessionKey = null;
      }
      if (!nextSessionKey && nextEvents.length > 0) {
        nextSessionKey = getNativeSessionKey(nextEvents[0]);
      }

      let nextEventId = state.selectedEventId;
      if (nextEventId && !nextEvents.some((ev) => ev.id === nextEventId)) {
        nextEventId = null;
      }
      if (!nextEventId && nextEvents.length > 0) {
        const matchInSession = nextSessionKey
          ? nextEvents.find((ev) => getNativeSessionKey(ev) === nextSessionKey)
          : undefined;
        nextEventId = (matchInSession ?? nextEvents[0]).id;
      }

      return {
        events: nextEvents,
        openInteractionCount: nextOpenCount,
        selectedSessionKey: nextSessionKey,
        selectedEventId: nextEventId
      };
    }),

  upsertNativeEvent: (incoming, openCount) =>
    set((state) => {
      const prevLocalOpenCount = state.events.filter((ev) => ev.attention_state === "open").length;
      const existing = state.events.find((ev) => ev.id === incoming.id);
      const mergedEvent: NativeEventView = existing
        ? {
            ...existing,
            ...incoming,
            deliveries_summary: incoming.deliveries_summary ?? existing.deliveries_summary
          }
        : incoming;

      const idx = state.events.findIndex((ev) => ev.id === incoming.id);
      const baseList =
        idx >= 0
          ? state.events.map((ev, i) => (i === idx ? mergedEvent : ev))
          : [mergedEvent, ...state.events];
      const nextEvents = recomputeEvents(baseList);
      const nextLocalOpenCount = nextEvents.filter((ev) => ev.attention_state === "open").length;
      const nextOpenCount =
        openCount !== undefined
          ? openCount
          : Math.max(0, state.openInteractionCount + (nextLocalOpenCount - prevLocalOpenCount));

      return {
        events: nextEvents,
        openInteractionCount: nextOpenCount,
        selectedSessionKey: state.selectedSessionKey ?? getNativeSessionKey(mergedEvent),
        selectedEventId: state.selectedEventId ?? mergedEvent.id
      };
    }),

  applySessionAck: (ackedEvent, scope, openCount) =>
    set((state) => {
      const canBatchSessionAck =
        scope === "session" && ackedEvent.native_session_id.trim() !== "";
      const ackTs = ackedEvent.ack_at ?? new Date().toISOString();
      const updated = state.events.map((ev) => {
        if (ev.id === ackedEvent.id) {
          return {
            ...ev,
            ...ackedEvent,
            deliveries_summary: ackedEvent.deliveries_summary ?? ev.deliveries_summary
          };
        }
        if (
          canBatchSessionAck &&
          ev.event_kind === "interaction_needed" &&
          ev.ack_at === null &&
          ev.node_id === ackedEvent.node_id &&
          ev.agent === ackedEvent.agent &&
          ev.native_session_id === ackedEvent.native_session_id
        ) {
          return { ...ev, ack_at: ackTs };
        }
        return ev;
      });
      if (!updated.some((ev) => ev.id === ackedEvent.id)) {
        updated.unshift(ackedEvent);
      }
      const nextEvents = recomputeEvents(updated);
      const nextOpenCount =
        openCount !== undefined
          ? openCount
          : nextEvents.filter((ev) => ev.attention_state === "open").length;

      return {
        events: nextEvents,
        openInteractionCount: nextOpenCount
      };
    }),

  setDeliveries: (sourceKey, deliveries) =>
    set((state) => ({
      deliveriesBySourceKey: {
        ...state.deliveriesBySourceKey,
        [sourceKey]: [...deliveries].sort(compareDeliveriesAsc)
      }
    })),

  upsertDelivery: (delivery) =>
    set((state) => {
      const sourceKey = getDeliverySourceKey(delivery.source_kind, delivery.source_id);
      const current = state.deliveriesBySourceKey[sourceKey] ?? [];
      const idx = current.findIndex((d) => d.id === delivery.id);
      const nextList =
        idx >= 0
          ? current.map((d, i) => (i === idx ? delivery : d))
          : [...current, delivery];
      return {
        deliveriesBySourceKey: {
          ...state.deliveriesBySourceKey,
          [sourceKey]: nextList.sort(compareDeliveriesAsc)
        }
      };
    }),

  setPushConfig: (pushConfig) => set({ pushConfig }),
  setSubscriptions: (subscriptions) => set({ subscriptions }),
  selectSession: (selectedSessionKey) => set({ selectedSessionKey }),
  selectEvent: (selectedEventId) => set({ selectedEventId }),
  setViewMode: (viewMode) => set({ viewMode }),
  setFilterMode: (filterMode) => set({ filterMode }),
  setOnlySelectedNode: (onlySelectedNode) => set({ onlySelectedNode }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  reset: () =>
    set({
      events: [],
      openInteractionCount: 0,
      selectedSessionKey: null,
      selectedEventId: null,
      deliveriesBySourceKey: {},
      pushConfig: null,
      subscriptions: []
    })
}));
