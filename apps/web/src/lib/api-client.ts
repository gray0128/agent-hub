import type {
  AnswerBoardQuestionPayload,
  ApiKeyRecord,
  AuthPrincipal,
  BoardChannelSummary,
  BoardEvent,
  BoardMessage,
  BoardTopic,
  BoardTopicStatus,
  CreateBoardMessagePayload,
  CreateBoardTopicPayload,
  CreateRunPayload,
  NativeEventAgentName,
  NativeEventKind,
  NativeEventNotifyStatus,
  NativeEventView,
  NodeRecord,
  NodeStatus,
  NotificationDeliveryRecord,
  PatchBoardTopicPayload,
  PushConfigRecord,
  PushEventFilterKey,
  PushSubscriptionTestResponse,
  ReorderBoardTopicsPayload,
  RunEventItem,
  RunRecord,
  ThreadRecord,
  ThreadStatus,
  WebPushSubscriptionRecord
} from "@/types";

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly next?: string[];

  constructor(status: number, code: string, message: string, next?: string[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.next = next;
  }
}

function authHeaders(token: string, extra?: Record<string, string>): HeadersInit {
  const headers: Record<string, string> = { ...extra };
  if (token.trim()) {
    headers["Authorization"] = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function requestJson<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: authHeaders(
      token,
      init.body ? { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) } : (init.headers as Record<string, string> | undefined)
    )
  });

  const data = (await res.json().catch(() => null)) as
    | ({ ok?: boolean; error?: { code?: string; message?: string; next?: string[] } } & T)
    | null;

  if (!res.ok) {
    const next = Array.isArray(data?.error?.next)
      ? data.error.next.filter((item): item is string => typeof item === "string")
      : undefined;
    throw new ApiClientError(
      res.status,
      data?.error?.code ?? "HTTP_ERROR",
      data?.error?.message ?? `请求失败 (${res.status})`,
      next
    );
  }
  return (data ?? {}) as T;
}

export const apiClient = {
  fetchMe(token: string) {
    return requestJson<{ ok: true; principal: AuthPrincipal }>(
      "/api/v1/auth/me",
      token
    );
  },

  fetchNodes(token: string) {
    return requestJson<{ ok: true; nodes: NodeRecord[] }>("/api/v1/nodes", token);
  },

  patchNode(
    token: string,
    nodeId: string,
    patch: {
      display_name?: string;
      status?: NodeStatus;
      max_concurrency?: number;
      default_notify_key_id?: string | null;
      default_notify_events?: PushEventFilterKey[];
    }
  ) {
    return requestJson<{ ok: true; node: NodeRecord }>(`/api/v1/nodes/${encodeURIComponent(nodeId)}`, token, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
  },

  fetchThreads(token: string, params: { node_id?: string; status?: ThreadStatus; q?: string } = {}) {
    const sp = new URLSearchParams({ limit: "100" });
    if (params.node_id) sp.set("node_id", params.node_id);
    if (params.status) sp.set("status", params.status);
    if (params.q) sp.set("q", params.q);
    return requestJson<{ ok: true; threads: ThreadRecord[] }>(`/api/v1/threads?${sp.toString()}`, token);
  },

  patchThread(
    token: string,
    threadId: string,
    patch: { title?: string; status?: ThreadStatus; pinned?: boolean; sort_order?: number }
  ) {
    return requestJson<{ ok: true; thread: ThreadRecord }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}`,
      token,
      {
        method: "PATCH",
        body: JSON.stringify(patch)
      }
    );
  },

  forkThread(
    token: string,
    threadId: string,
    body: { node_id: string; workdir: string; agent?: string; title?: string }
  ) {
    return requestJson<{ ok: true; thread: ThreadRecord; run: RunRecord }>(
      `/api/v1/threads/${encodeURIComponent(threadId)}/fork`,
      token,
      {
        method: "POST",
        body: JSON.stringify(body)
      }
    );
  },

  fetchRuns(token: string, params: { limit?: number; root_run_id?: string } = {}) {
    const sp = new URLSearchParams({ limit: String(params.limit ?? 100) });
    if (params.root_run_id) sp.set("root_run_id", params.root_run_id);
    return requestJson<{ ok: true; runs: RunRecord[] }>(`/api/v1/runs?${sp.toString()}`, token);
  },

  fetchRunDetail(token: string, runId: string, view: "summary" | "full" = "summary") {
    return requestJson<{ ok: true; run: RunRecord }>(
      `/api/v1/runs/${encodeURIComponent(runId)}?view=${view}`,
      token
    );
  },

  fetchRunEvents(token: string, runId: string, afterSeq = 0, limit = 200) {
    return requestJson<{ ok: true; events: RunEventItem[]; next_seq: number }>(
      `/api/v1/runs/${encodeURIComponent(runId)}/events?after_seq=${afterSeq}&limit=${limit}`,
      token
    );
  },

  createRun(token: string, payload: CreateRunPayload) {
    return requestJson<{ ok: true; run: RunRecord }>("/api/v1/runs?wait_ms=0", token, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },

  reorderQueuedRuns(token: string, nodeId: string, orderedRunIds: string[]) {
    return requestJson<{ ok: true; runs: RunRecord[] }>("/api/v1/runs/reorder", token, {
      method: "POST",
      body: JSON.stringify({ node_id: nodeId, ordered_run_ids: orderedRunIds })
    });
  },

  cancelRun(token: string, runId: string, cascade = false) {
    return requestJson<{ ok: true; cancelled_runs: RunRecord[] }>(
      `/api/v1/runs/${encodeURIComponent(runId)}/cancel`,
      token,
      {
        method: "POST",
        body: JSON.stringify({ cascade, reason: "Cancelled from web console" })
      }
    );
  },

  resolveRun(token: string, runId: string, summary?: string) {
    return requestJson<{ ok: true; run: RunRecord }>(
      `/api/v1/runs/${encodeURIComponent(runId)}/resolve`,
      token,
      {
        method: "POST",
        body: JSON.stringify(summary ? { summary } : {})
      }
    );
  },

  fetchKeys(token: string) {
    return requestJson<{ ok: true; keys: ApiKeyRecord[] }>("/api/v1/keys", token);
  },

  createKey(
    token: string,
    body: {
      name: string;
      scope: "admin" | "client" | "node";
      bound_node_id?: string;
      allowed_nodes?: string[];
      allowed_board_prefixes?: string[];
      allow_unsandboxed?: boolean;
      max_depth_limit?: number;
      webhook_url?: string;
      webhook_key?: string;
    }
  ) {
    return requestJson<{ ok: true; key: ApiKeyRecord; token: string }>("/api/v1/keys", token, {
      method: "POST",
      body: JSON.stringify(body)
    });
  },

  patchKey(
    token: string,
    keyId: string,
    body: {
      bound_node_id?: string | null;
      allowed_nodes?: string[];
      allowed_board_prefixes?: string[];
      allow_unsandboxed?: boolean;
      max_depth_limit?: number;
      webhook_url?: string;
      webhook_key?: string;
      clear_webhook?: boolean;
    }
  ) {
    return requestJson<{ ok: true; key: ApiKeyRecord }>(
      `/api/v1/keys/${encodeURIComponent(keyId)}`,
      token,
      {
        method: "PATCH",
        body: JSON.stringify(body)
      }
    );
  },

  revokeKey(token: string, keyId: string) {
    return requestJson<{ ok: true; revoked_at: string }>(
      `/api/v1/keys/${encodeURIComponent(keyId)}`,
      token,
      { method: "DELETE" }
    );
  },

  fetchNativeEvents(
    token: string,
    params: {
      node_id?: string;
      agent?: NativeEventAgentName;
      event_kind?: NativeEventKind;
      notify_status?: NativeEventNotifyStatus;
      unacked_only?: boolean;
      q?: string;
      limit?: number;
      before_ts?: string;
      before_id?: string;
    } = {}
  ) {
    const sp = new URLSearchParams();
    if (params.node_id) sp.set("node_id", params.node_id);
    if (params.agent) sp.set("agent", params.agent);
    if (params.event_kind) sp.set("event_kind", params.event_kind);
    if (params.notify_status) sp.set("notify_status", params.notify_status);
    if (params.unacked_only !== undefined) {
      sp.set("unacked_only", params.unacked_only ? "true" : "false");
    }
    if (params.q) sp.set("q", params.q);
    if (params.limit !== undefined) sp.set("limit", String(params.limit));
    if (params.before_ts) sp.set("before_ts", params.before_ts);
    if (params.before_id) sp.set("before_id", params.before_id);
    const qs = sp.toString();
    return requestJson<{
      ok: true;
      events: NativeEventView[];
      open_interaction_count: number;
      next_cursor: { before_ts: string; before_id: string } | null;
    }>(`/api/v1/native-events${qs ? `?${qs}` : ""}`, token);
  },

  fetchNativeEventDetail(token: string, eventId: string) {
    return requestJson<{
      ok: true;
      event: NativeEventView;
      deliveries: NotificationDeliveryRecord[];
    }>(`/api/v1/native-events/${encodeURIComponent(eventId)}`, token);
  },

  ackNativeEvent(token: string, eventId: string, scope: "single" | "session" = "single") {
    return requestJson<{
      ok: true;
      event: NativeEventView;
      acked_count: number;
      open_interaction_count: number;
    }>(`/api/v1/native-events/${encodeURIComponent(eventId)}/ack`, token, {
      method: "POST",
      body: JSON.stringify({ scope })
    });
  },

  redeliverNativeEvent(token: string, eventId: string, deliveryId?: string) {
    return requestJson<{
      ok: true;
      event: NativeEventView;
      deliveries: NotificationDeliveryRecord[];
      requeued_count: number;
    }>(`/api/v1/native-events/${encodeURIComponent(eventId)}/redeliver`, token, {
      method: "POST",
      body: JSON.stringify(deliveryId ? { delivery_id: deliveryId } : {})
    });
  },

  fetchRunDeliveries(token: string, runId: string) {
    return requestJson<{ ok: true; deliveries: NotificationDeliveryRecord[] }>(
      `/api/v1/runs/${encodeURIComponent(runId)}/deliveries`,
      token
    );
  },

  redeliverRun(token: string, runId: string, deliveryId?: string) {
    return requestJson<{
      ok: true;
      run: RunRecord;
      deliveries: NotificationDeliveryRecord[];
      requeued_count: number;
    }>(`/api/v1/runs/${encodeURIComponent(runId)}/redeliver`, token, {
      method: "POST",
      body: JSON.stringify(deliveryId ? { delivery_id: deliveryId } : {})
    });
  },

  fetchPushConfig(token: string) {
    return requestJson<{ ok: true } & PushConfigRecord>("/api/v1/push/config", token);
  },

  fetchPushSubscriptions(token: string, includeRevoked = false) {
    return requestJson<{ ok: true; subscriptions: WebPushSubscriptionRecord[] }>(
      `/api/v1/push-subscriptions?include_revoked=${includeRevoked ? "true" : "false"}`,
      token
    );
  },

  createPushSubscription(
    token: string,
    body: {
      label: string;
      subscription: {
        endpoint: string;
        keys: {
          p256dh: string;
          auth: string;
        };
      };
      node_filter?: string[];
      event_filter?: PushEventFilterKey[];
    }
  ) {
    const cleanPayload = {
      label: body.label,
      subscription: {
        endpoint: body.subscription.endpoint,
        keys: {
          p256dh: body.subscription.keys.p256dh,
          auth: body.subscription.keys.auth
        }
      },
      ...(body.node_filter !== undefined ? { node_filter: body.node_filter } : {}),
      ...(body.event_filter !== undefined ? { event_filter: body.event_filter } : {})
    };
    return requestJson<{ ok: true; subscription: WebPushSubscriptionRecord }>(
      "/api/v1/push-subscriptions",
      token,
      {
        method: "POST",
        body: JSON.stringify(cleanPayload)
      }
    );
  },

  patchPushSubscription(
    token: string,
    subscriptionId: string,
    patch: {
      label?: string;
      enabled?: boolean;
      node_filter?: string[];
      event_filter?: PushEventFilterKey[];
    }
  ) {
    return requestJson<{ ok: true; subscription: WebPushSubscriptionRecord }>(
      `/api/v1/push-subscriptions/${encodeURIComponent(subscriptionId)}`,
      token,
      {
        method: "PATCH",
        body: JSON.stringify(patch)
      }
    );
  },

  revokePushSubscription(token: string, subscriptionId: string) {
    return requestJson<{ ok: true; revoked_at: string }>(
      `/api/v1/push-subscriptions/${encodeURIComponent(subscriptionId)}`,
      token,
      { method: "DELETE" }
    );
  },

  testPushSubscription(token: string, subscriptionId: string) {
    return requestJson<PushSubscriptionTestResponse>(
      `/api/v1/push-subscriptions/${encodeURIComponent(subscriptionId)}/test`,
      token,
      {
        method: "POST",
        body: JSON.stringify({})
      }
    );
  },

  fetchBoardChannels(token: string) {
    return requestJson<{ ok: true; channels: BoardChannelSummary[] }>(
      "/api/v1/board/channels",
      token
    );
  },

  fetchBoardTopics(
    token: string,
    params: {
      channel?: string;
      external_ref?: string;
      status?: BoardTopicStatus;
      has_open_question?: boolean;
      q?: string;
      sort?: "recent" | "order";
      limit?: number;
    } = {}
  ) {
    const sp = new URLSearchParams();
    if (params.channel) sp.set("channel", params.channel);
    if (params.external_ref) sp.set("external_ref", params.external_ref);
    if (params.status) sp.set("status", params.status);
    if (params.has_open_question !== undefined) {
      sp.set("has_open_question", params.has_open_question ? "true" : "false");
    }
    if (params.q) sp.set("q", params.q);
    if (params.sort) sp.set("sort", params.sort);
    if (params.limit !== undefined) sp.set("limit", String(params.limit));
    const qs = sp.toString();
    return requestJson<{ ok: true; topics: BoardTopic[] }>(
      `/api/v1/board/topics${qs ? `?${qs}` : ""}`,
      token
    );
  },

  createBoardTopic(token: string, body: CreateBoardTopicPayload) {
    return requestJson<{ ok: true; topic: BoardTopic; created?: boolean }>(
      "/api/v1/board/topics",
      token,
      {
        method: "POST",
        body: JSON.stringify(body)
      }
    );
  },

  patchBoardTopic(token: string, topicId: string, patch: PatchBoardTopicPayload) {
    return requestJson<{ ok: true; topic: BoardTopic }>(
      `/api/v1/board/topics/${encodeURIComponent(topicId)}`,
      token,
      {
        method: "PATCH",
        body: JSON.stringify(patch)
      }
    );
  },

  reorderBoardTopics(token: string, body: ReorderBoardTopicsPayload) {
    return requestJson<{ ok: true; topics: BoardTopic[] }>(
      "/api/v1/board/topics/reorder",
      token,
      {
        method: "POST",
        body: JSON.stringify(body)
      }
    );
  },

  fetchBoardTopicMessages(
    token: string,
    topicId: string,
    params: { after_seq?: number; limit?: number } = {}
  ) {
    const sp = new URLSearchParams();
    if (params.after_seq !== undefined) sp.set("after_seq", String(params.after_seq));
    if (params.limit !== undefined) sp.set("limit", String(params.limit));
    const qs = sp.toString();
    return requestJson<{
      ok: true;
      topic: BoardTopic;
      messages: BoardMessage[];
      cursor: number;
    }>(`/api/v1/board/topics/${encodeURIComponent(topicId)}/messages${qs ? `?${qs}` : ""}`, token);
  },

  postBoardMessage(token: string, topicId: string, body: CreateBoardMessagePayload) {
    return requestJson<{
      ok: true;
      topic: BoardTopic;
      message: BoardMessage;
      cursor: number;
      deduplicated?: boolean;
    }>(`/api/v1/board/topics/${encodeURIComponent(topicId)}/messages`, token, {
      method: "POST",
      body: JSON.stringify(body)
    });
  },

  answerBoardQuestion(token: string, messageId: string, body: AnswerBoardQuestionPayload) {
    return requestJson<{
      ok: true;
      topic: BoardTopic;
      question: BoardMessage;
      answer: BoardMessage;
      cursor: number;
    }>(`/api/v1/board/messages/${encodeURIComponent(messageId)}/answer`, token, {
      method: "POST",
      body: JSON.stringify(body)
    });
  },

  fetchBoardEvents(
    token: string,
    params: {
      channel?: string;
      topic_id?: string;
      after_cursor?: number;
      limit?: number;
    } = {}
  ) {
    const sp = new URLSearchParams();
    if (params.channel) sp.set("channel", params.channel);
    if (params.topic_id) sp.set("topic_id", params.topic_id);
    if (params.after_cursor !== undefined) sp.set("after_cursor", String(params.after_cursor));
    if (params.limit !== undefined) sp.set("limit", String(params.limit));
    const qs = sp.toString();
    return requestJson<{
      ok: true;
      events: BoardEvent[];
      next_cursor: number;
    }>(`/api/v1/board/events${qs ? `?${qs}` : ""}`, token);
  }
};
