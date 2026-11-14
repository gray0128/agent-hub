import type {
  ApiKeyRecord,
  CreateRunPayload,
  NodeRecord,
  NodeStatus,
  RunEventItem,
  RunRecord,
  ThreadRecord,
  ThreadStatus
} from "@/types";

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
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
    | ({ ok?: boolean; error?: { code?: string; message?: string } } & T)
    | null;

  if (!res.ok) {
    throw new ApiClientError(
      res.status,
      data?.error?.code ?? "HTTP_ERROR",
      data?.error?.message ?? `请求失败 (${res.status})`
    );
  }
  return (data ?? {}) as T;
}

export const apiClient = {
  fetchMe(token: string) {
    return requestJson<{ ok: true; principal: { kind: string; scope: "admin" | "client" | "node" } }>(
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
    patch: { display_name?: string; status?: NodeStatus; max_concurrency?: number }
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
  }
};
