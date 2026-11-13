import { DurableObject } from "cloudflare:workers";
import {
  appendRunEvents,
  applyRunStateFrame,
  enqueueRunNotificationIfNeeded,
  getNodeById,
  listNodes,
  listRuns,
  listThreads,
  renewNodePingLeases,
  setNodeOffline,
  upsertNodeHello
} from "./db";
import {
  type ApiScope,
  type AuthPrincipal,
  type Env,
  HubError,
  type NodeRecord,
  type RunRecord
} from "./types";
import { nowIso } from "./ulid";
import { parseNodeWsFrame } from "./validation";

interface NodeWsAttachment {
  role: "node";
  nodeId: string;
  keyId: string | null;
  connNonce: string;
}

interface StreamWsAttachment {
  role: "stream";
  runId: string | null;
  scope: ApiScope;
  keyId: string | null;
  allowedNodes: string[];
}

type WsAttachment = NodeWsAttachment | StreamWsAttachment;

interface Waiter {
  resolve: (run: RunRecord | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const TERMINAL_OR_PAUSE = new Set(["done", "failed", "cancelled", "needs_approval"]);

export class NodeHub extends DurableObject<Env> {
  private waiters = new Map<string, Set<Waiter>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private resolveWaiters(run: RunRecord): void {
    if (!TERMINAL_OR_PAUSE.has(run.status)) return;
    const set = this.waiters.get(run.id);
    if (!set) return;
    for (const w of set) {
      clearTimeout(w.timer);
      w.resolve(run);
    }
    this.waiters.delete(run.id);
  }

  private getLeaseTtl(): number {
    const parsed = Number.parseInt(this.env.LEASE_TTL_SECONDS || "90", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 90;
  }

  private sendJson(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Closed socket cleanup handled by close handler
    }
  }

  private broadcastToStream(
    payload: unknown,
    filter?: { runId?: string; nodeId?: string }
  ): void {
    const encoded = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets("stream")) {
      const att = ws.deserializeAttachment() as StreamWsAttachment | null;
      if (!att) continue;
      if (att.runId && filter?.runId && att.runId !== filter.runId) {
        continue;
      }
      if (att.runId && !filter?.runId) {
        // Single-run subscribers do not receive unrelated global node status frames
        continue;
      }
      if (
        filter?.nodeId &&
        att.scope === "client" &&
        att.allowedNodes.length > 0 &&
        !att.allowedNodes.includes(filter.nodeId)
      ) {
        continue;
      }
      try {
        ws.send(encoded);
      } catch {
        // ignore broken socket
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/internal/ws/node") {
      const nodeId = request.headers.get("x-ahub-node-id");
      const keyId = request.headers.get("x-ahub-key-id");
      if (!nodeId) {
        return new Response("Missing node id", { status: 400 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      const tags = [`node:${nodeId}`];
      if (keyId) tags.push(`key:${keyId}`);
      this.ctx.acceptWebSocket(server, tags);
      const attachment: NodeWsAttachment = {
        role: "node",
        nodeId,
        keyId: keyId || null,
        connNonce: ""
      };
      server.serializeAttachment(attachment);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/internal/ws/stream") {
      const runId = url.searchParams.get("run_id") || null;
      const scope = (request.headers.get("x-ahub-scope") || "admin") as ApiScope;
      const keyId = request.headers.get("x-ahub-key-id") || null;
      const allowedNodesRaw = request.headers.get("x-ahub-allowed-nodes") || "[]";
      let allowedNodes: string[] = [];
      try {
        const parsed = JSON.parse(allowedNodesRaw);
        if (Array.isArray(parsed)) allowedNodes = parsed;
      } catch {
        allowedNodes = [];
      }

      const principal: AuthPrincipal = {
        kind: "api_key",
        keyId,
        scope,
        boundNodeId: null,
        allowedNodes,
        allowUnsandboxed: true,
        maxDepthLimit: 3
      };

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      const tags = ["stream"];
      if (keyId) tags.push(`key:${keyId}`);
      if (runId) tags.push(`run:${runId}`);
      this.ctx.acceptWebSocket(server, tags);
      const attachment: StreamWsAttachment = {
        role: "stream",
        runId,
        scope,
        keyId,
        allowedNodes
      };
      server.serializeAttachment(attachment);

      const [nodes, threads, runs] = await Promise.all([
        listNodes(this.env.DB, principal),
        runId ? Promise.resolve([]) : listThreads(this.env.DB, principal, { limit: 100 }),
        listRuns(this.env.DB, principal, { limit: 100 })
      ]);
      const filteredRuns = runId ? runs.filter((r) => r.id === runId) : runs;

      this.sendJson(server, {
        type: "snapshot",
        nodes,
        threads,
        runs: filteredRuns,
        ts: nowIso()
      });

      const responseHeaders = new Headers();
      const proto = request.headers.get("Sec-WebSocket-Protocol");
      if (proto) {
        const offered = proto.split(",").map((s) => s.trim());
        if (offered.includes("bearer")) {
          responseHeaders.set("Sec-WebSocket-Protocol", "bearer");
        }
      }
      return new Response(null, { status: 101, webSocket: client, headers: responseHeaders });
    }

    if (request.method === "POST" && url.pathname === "/internal/wake") {
      const body = (await request.json()) as {
        node_id: string;
        reason: "run_queued" | "reconcile";
        run_id?: string;
      };
      let delivered = 0;
      for (const ws of this.ctx.getWebSockets(`node:${body.node_id}`)) {
        this.sendJson(ws, {
          type: "hub.wake",
          reason: body.reason,
          ...(body.run_id ? { run_id: body.run_id } : {})
        });
        delivered++;
      }
      return Response.json({ ok: true, delivered });
    }

    if (request.method === "POST" && url.pathname === "/internal/abort") {
      const body = (await request.json()) as {
        targets: Array<{ nodeId: string; runId: string }>;
        reason: string;
      };
      let delivered = 0;
      for (const target of body.targets) {
        for (const ws of this.ctx.getWebSockets(`node:${target.nodeId}`)) {
          this.sendJson(ws, {
            type: "hub.abort",
            run_id: target.runId,
            reason: body.reason
          });
          delivered++;
        }
      }
      return Response.json({ ok: true, delivered });
    }

    if (request.method === "POST" && url.pathname === "/internal/broadcast-run") {
      const body = (await request.json()) as { run: RunRecord };
      this.broadcastToStream({ type: "run.updated", run: body.run }, { runId: body.run.id, nodeId: body.run.node_id });
      this.resolveWaiters(body.run);
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/internal/broadcast-node") {
      const body = (await request.json()) as { node: NodeRecord };
      this.broadcastToStream({ type: "node.status", node: body.node }, { nodeId: body.node.id });
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/internal/revoke-key") {
      const body = (await request.json()) as { key_id: string; bound_node_id: string | null };
      const sockets = this.ctx.getWebSockets(`key:${body.key_id}`);
      for (const ws of sockets) {
        try {
          ws.close(4001, "API key revoked");
        } catch {
          // ignore
        }
      }
      if (body.bound_node_id) {
        const remaining = this.ctx
          .getWebSockets(`node:${body.bound_node_id}`)
          .filter((ws) => (ws.deserializeAttachment() as NodeWsAttachment | null)?.keyId !== body.key_id);
        if (remaining.length === 0) {
          const updatedNode = await setNodeOffline(this.env.DB, body.bound_node_id);
          if (updatedNode) {
            this.broadcastToStream({ type: "node.status", node: updatedNode }, { nodeId: updatedNode.id });
          }
        }
      }
      return Response.json({ ok: true, closed: sockets.length });
    }

    if (request.method === "GET" && url.pathname === "/internal/wait-run") {
      const runId = url.searchParams.get("run_id");
      const timeoutMs = Math.min(Math.max(Number(url.searchParams.get("timeout_ms") || "0"), 0), 45000);
      if (!runId) {
        return new Response("Missing run_id", { status: 400 });
      }
      if (timeoutMs <= 0) {
        return Response.json({ run: null });
      }
      const run = await new Promise<RunRecord | null>((resolve) => {
        let set = this.waiters.get(runId);
        if (!set) {
          set = new Set<Waiter>();
          this.waiters.set(runId, set);
        }
        const timer = setTimeout(() => {
          const s = this.waiters.get(runId);
          if (s) {
            s.delete(waiter);
            if (s.size === 0) this.waiters.delete(runId);
          }
          resolve(null);
        }, timeoutMs);
        const waiter: Waiter = { resolve, timer };
        set.add(waiter);
      });
      return Response.json({ run });
    }

    return new Response("Not Found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att || att.role !== "node") {
      return;
    }

    const rawText = typeof message === "string" ? message : new TextDecoder().decode(message);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      this.sendJson(ws, { type: "error", code: "BAD_REQUEST", message: "Invalid JSON frame." });
      return;
    }

    let frame;
    try {
      frame = parseNodeWsFrame(parsedJson);
    } catch (err) {
      const msg = err instanceof HubError ? err.message : "Invalid WebSocket frame.";
      const code = err instanceof HubError ? err.code : "BAD_REQUEST";
      this.sendJson(ws, { type: "error", code, message: msg });
      return;
    }

    switch (frame.type) {
      case "node.hello": {
        const nextAtt: NodeWsAttachment = {
          role: "node",
          nodeId: att.nodeId,
          keyId: att.keyId,
          connNonce: frame.conn_nonce
        };
        ws.serializeAttachment(nextAtt);
        const updatedNode = await upsertNodeHello(this.env.DB, att.nodeId, frame);
        const pendingRow = await this.env.DB.prepare(
          `SELECT 1 AS has_one FROM runs WHERE node_id = ?1 AND status = 'queued' LIMIT 1`
        )
          .bind(att.nodeId)
          .first<{ has_one: number }>();

        this.sendJson(ws, {
          type: "hub.welcome",
          node_id: att.nodeId,
          heartbeat_interval_ms: 25000,
          has_pending_runs: Boolean(pendingRow)
        });
        this.broadcastToStream({ type: "node.status", node: updatedNode }, { nodeId: updatedNode.id });
        break;
      }

      case "node.ping": {
        await renewNodePingLeases(this.env.DB, att.nodeId, frame.active_run_ids, this.getLeaseTtl());
        break;
      }

      case "run.event": {
        const ok = await appendRunEvents(this.env.DB, att.nodeId, frame.run_id, [
          { seq: frame.seq, kind: frame.kind, payload: frame.payload, ts: frame.ts }
        ]);
        if (ok) {
          this.broadcastToStream(
            {
              type: "run.event",
              run_id: frame.run_id,
              seq: frame.seq,
              kind: frame.kind,
              payload: frame.payload,
              ts: frame.ts
            },
            { runId: frame.run_id, nodeId: att.nodeId }
          );
        }
        break;
      }

      case "run.events": {
        const ok = await appendRunEvents(this.env.DB, att.nodeId, frame.run_id, frame.events);
        if (ok) {
          this.broadcastToStream(
            {
              type: "run.events",
              run_id: frame.run_id,
              events: frame.events
            },
            { runId: frame.run_id, nodeId: att.nodeId }
          );
        }
        break;
      }

      case "run.state": {
        const updated = await applyRunStateFrame(
          this.env.DB,
          att.nodeId,
          frame.run_id,
          frame.lease_owner,
          frame.status,
          {
            remoteControlUrl: frame.remote_control_url,
            resolvedModel: frame.resolved_model,
            resolvedEffort: frame.resolved_effort,
            leaseTtlSeconds: this.getLeaseTtl()
          }
        );
        if (updated) {
          if (frame.status === "needs_approval") {
            await enqueueRunNotificationIfNeeded(this.env.DB, this.env, updated, "needs_approval");
          }
          const runRecord: RunRecord = {
            id: updated.id,
            thread_id: updated.thread_id,
            root_run_id: updated.root_run_id,
            parent_run_id: updated.parent_run_id,
            depth: updated.depth,
            max_depth: updated.max_depth,
            node_id: updated.node_id,
            workdir: updated.workdir,
            agent: updated.agent,
            model: updated.model,
            effort: updated.effort,
            sandbox: updated.sandbox === 1,
            timeout_sec: updated.timeout_sec,
            status: updated.status,
            priority_order: updated.priority_order,
            resolved_model: updated.resolved_model,
            resolved_effort: updated.resolved_effort,
            native_session_id: updated.native_session_id,
            remote_control_url: updated.remote_control_url,
            summary: updated.summary,
            output_bytes: updated.output_bytes,
            error_code: updated.error_code,
            error_message: updated.error_message,
            notify_status: updated.notify_status,
            lease_expires_at: updated.lease_expires_at,
            started_at: updated.started_at,
            finished_at: updated.finished_at,
            duration_ms: updated.duration_ms,
            created_at: updated.created_at,
            updated_at: updated.updated_at
          };
          this.broadcastToStream(
            { type: "run.updated", run: runRecord },
            { runId: runRecord.id, nodeId: runRecord.node_id }
          );
          this.resolveWaiters(runRecord);
        }
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleNodeDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleNodeDisconnect(ws);
  }

  private async handleNodeDisconnect(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att || att.role !== "node") return;
    const activeOthers = this.ctx
      .getWebSockets(`node:${att.nodeId}`)
      .filter((other) => other !== ws && other.readyState === WebSocket.OPEN);
    if (activeOthers.length === 0) {
      const node = await getNodeById(this.env.DB, att.nodeId);
      if (node && node.status !== "offline") {
        const offlineNode = await setNodeOffline(this.env.DB, att.nodeId);
        if (offlineNode) {
          this.broadcastToStream({ type: "node.status", node: offlineNode }, { nodeId: offlineNode.id });
        }
      }
    }
  }
}
