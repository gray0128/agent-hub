import { DurableObject } from "cloudflare:workers";
import {
  countOpenBoardQuestions,
  getBoardTopicById,
  listMissedTopicStreamFrames
} from "./board";
import {
  appendRunEvents,
  applyRunStateFrame,
  countOpenNativeInteractions,
  enqueueRunNotificationIfNeeded,
  getDeliveriesSummaryMap,
  getNodeById,
  listNativeEvents,
  listNodes,
  listRuns,
  listThreads,
  mapRunRow,
  renewNodePingLeases,
  type RunRow,
  sanitizeNodeForScope,
  setNodeOffline,
  upsertNodeHello
} from "./db";
import {
  type ApiScope,
  type AuthPrincipal,
  type BoardMessage,
  type BoardTopic,
  type Env,
  HubError,
  type NativeEventRecord,
  type NodeRecord,
  type NotificationDeliveryRecord,
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
  topicId: string | null;
  scope: ApiScope;
  keyId: string | null;
  boundNodeId: string | null;
  allowedNodes: string[];
  allowedBoardPrefixes?: string[];
}

type WsAttachment = NodeWsAttachment | StreamWsAttachment;

interface Waiter {
  resolve: (run: RunRecord | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const TERMINAL_OR_PAUSE = new Set(["done", "failed", "cancelled", "needs_approval"]);

export async function buildStreamSnapshotPayload(
  db: D1Database,
  principal: AuthPrincipal,
  runId: string | null,
  topicId: string | null = null
): Promise<Record<string, unknown>> {
  if (topicId) {
    const topic = await getBoardTopicById(db, principal, topicId);
    return {
      type: "snapshot",
      nodes: [],
      topic,
      ts: nowIso()
    };
  }

  const isGlobalAdminStream = principal.scope === "admin" && !runId;
  const [nodes, threads, runs, nativeSnapshot, openBoardQuestionCount] = await Promise.all([
    listNodes(db, principal),
    runId ? Promise.resolve([]) : listThreads(db, principal, { limit: 100 }),
    listRuns(db, principal, { limit: 100 }),
    isGlobalAdminStream ? listNativeEvents(db, { limit: 100 }) : Promise.resolve(null),
    isGlobalAdminStream ? countOpenBoardQuestions(db) : Promise.resolve(null)
  ]);
  const filteredRuns = runId ? runs.filter((r) => r.id === runId) : runs;

  return {
    type: "snapshot",
    nodes,
    threads,
    runs: filteredRuns,
    ...(nativeSnapshot
      ? {
          native_events: nativeSnapshot.events,
          open_interaction_count: nativeSnapshot.openInteractionCount
        }
      : {}),
    ...(openBoardQuestionCount !== null
      ? { open_board_question_count: openBoardQuestionCount }
      : {}),
    ts: nowIso()
  };
}

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

  private canStreamReceiveNode(att: StreamWsAttachment, nodeId?: string): boolean {
    if (!nodeId || att.scope !== "client") {
      return true;
    }
    if (att.boundNodeId && att.boundNodeId !== nodeId) {
      return false;
    }
    if (att.allowedNodes.length > 0 && !att.allowedNodes.includes(nodeId)) {
      return false;
    }
    return true;
  }

  private broadcastToStream(
    payload: { type: string; node?: NodeRecord } & Record<string, unknown>,
    filter?: { runId?: string; nodeId?: string; topicId?: string }
  ): void {
    const adminEncoded = JSON.stringify(payload);
    const adminGlobalOnly =
      payload.type === "native_event.upserted" || payload.type === "delivery.updated";
    const isBoardFrame = payload.type.startsWith("board.");
    let clientEncoded: string | null = null;
    let topicBoardEncoded: string | null = null;

    for (const ws of this.ctx.getWebSockets("stream")) {
      const att = ws.deserializeAttachment() as StreamWsAttachment | null;
      if (!att) continue;
      if (adminGlobalOnly && (att.scope !== "admin" || Boolean(att.runId) || Boolean(att.topicId))) {
        continue;
      }

      if (isBoardFrame) {
        if (att.runId) {
          continue;
        }
        if (att.topicId) {
          if (!filter?.topicId || att.topicId !== filter.topicId) {
            continue;
          }
          if (topicBoardEncoded === null) {
            if ("open_board_question_count" in payload) {
              const { open_board_question_count: _ignored, ...rest } = payload;
              topicBoardEncoded = JSON.stringify(rest);
            } else {
              topicBoardEncoded = adminEncoded;
            }
          }
          try {
            ws.send(topicBoardEncoded);
          } catch {
            // ignore broken socket
          }
          continue;
        }
        if (att.scope !== "admin") {
          continue;
        }
        try {
          ws.send(adminEncoded);
        } catch {
          // ignore broken socket
        }
        continue;
      }

      // Non-board frames must never be sent to single-topic subscribers
      if (att.topicId) {
        continue;
      }
      if (att.runId && filter?.runId && att.runId !== filter.runId) {
        continue;
      }
      if (att.runId && !filter?.runId) {
        // Single-run subscribers do not receive unrelated global node status frames
        continue;
      }
      if (!this.canStreamReceiveNode(att, filter?.nodeId)) {
        continue;
      }
      let encoded = adminEncoded;
      if (att.scope !== "admin" && payload.type === "node.status" && payload.node) {
        clientEncoded ??= JSON.stringify({
          type: "node.status",
          node: sanitizeNodeForScope(payload.node, att.scope)
        });
        encoded = clientEncoded;
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
      const topicId = url.searchParams.get("topic_id") || null;
      const afterCursorRaw = url.searchParams.get("after_cursor");
      const afterCursor =
        afterCursorRaw !== null && /^\d+$/.test(afterCursorRaw)
          ? Number.parseInt(afterCursorRaw, 10)
          : null;
      const scope = (request.headers.get("x-ahub-scope") || "admin") as ApiScope;
      const keyId = request.headers.get("x-ahub-key-id") || null;
      const boundNodeId = request.headers.get("x-ahub-bound-node-id") || null;
      const allowedNodesRaw = request.headers.get("x-ahub-allowed-nodes") || "[]";
      let allowedNodes: string[] = [];
      try {
        const parsed = JSON.parse(allowedNodesRaw);
        if (Array.isArray(parsed)) allowedNodes = parsed;
      } catch {
        allowedNodes = [];
      }
      const allowedBoardPrefixesRaw = request.headers.get("x-ahub-allowed-board-prefixes") || "[]";
      let allowedBoardPrefixes: string[] = [];
      try {
        const parsed = JSON.parse(allowedBoardPrefixesRaw);
        if (Array.isArray(parsed)) {
          allowedBoardPrefixes = parsed.filter((x): x is string => typeof x === "string");
        }
      } catch {
        allowedBoardPrefixes = [];
      }

      const principal: AuthPrincipal = {
        kind: "api_key",
        keyId,
        scope,
        boundNodeId,
        allowedNodes,
        allowedBoardPrefixes,
        allowUnsandboxed: true,
        maxDepthLimit: 3
      };

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      const tags = ["stream"];
      if (keyId) tags.push(`key:${keyId}`);
      if (runId) tags.push(`run:${runId}`);
      if (topicId) tags.push(`topic:${topicId}`);
      this.ctx.acceptWebSocket(server, tags);
      const attachment: StreamWsAttachment = {
        role: "stream",
        runId,
        topicId,
        scope,
        keyId,
        boundNodeId,
        allowedNodes,
        allowedBoardPrefixes
      };
      server.serializeAttachment(attachment);

      const snapshot = await buildStreamSnapshotPayload(this.env.DB, principal, runId, topicId);
      this.sendJson(server, snapshot);

      if (topicId && afterCursor !== null && Number.isSafeInteger(afterCursor)) {
        const missedFrames = await listMissedTopicStreamFrames(this.env.DB, topicId, afterCursor);
        for (const frame of missedFrames) {
          this.sendJson(server, frame);
        }
      }

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

    if (request.method === "POST" && url.pathname === "/internal/broadcast-native-event") {
      const body = (await request.json()) as {
        event: NativeEventRecord;
        open_interaction_count?: number;
      };
      const openInteractionCount =
        typeof body.open_interaction_count === "number"
          ? body.open_interaction_count
          : await countOpenNativeInteractions(this.env.DB);
      this.broadcastToStream({
        type: "native_event.upserted",
        event: body.event,
        open_interaction_count: openInteractionCount
      });
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/internal/broadcast-delivery") {
      const body = (await request.json()) as { delivery: NotificationDeliveryRecord };
      this.broadcastToStream({
        type: "delivery.updated",
        delivery: body.delivery
      });
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/internal/broadcast-board-topic") {
      const body = (await request.json()) as {
        topic: BoardTopic;
        cursor?: number;
        open_board_question_count?: number;
      };
      const openBoardQuestionCount =
        typeof body.open_board_question_count === "number"
          ? body.open_board_question_count
          : await countOpenBoardQuestions(this.env.DB);
      this.broadcastToStream(
        {
          type: "board.topic_updated",
          topic: body.topic,
          ...(typeof body.cursor === "number" && body.cursor >= 1 ? { cursor: body.cursor } : {}),
          open_board_question_count: openBoardQuestionCount
        },
        { topicId: body.topic.id }
      );
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/internal/broadcast-board-message") {
      const body = (await request.json()) as {
        message: BoardMessage;
        topic?: BoardTopic;
        cursor: number;
        open_board_question_count?: number;
      };
      const openBoardQuestionCount =
        typeof body.open_board_question_count === "number"
          ? body.open_board_question_count
          : await countOpenBoardQuestions(this.env.DB);
      this.broadcastToStream(
        {
          type: "board.message_created",
          message: body.message,
          ...(body.topic ? { topic: body.topic } : {}),
          cursor: body.cursor,
          open_board_question_count: openBoardQuestionCount
        },
        { topicId: body.message.topic_id }
      );
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/internal/broadcast-board-answer") {
      const body = (await request.json()) as {
        question: BoardMessage;
        answer: BoardMessage;
        topic?: BoardTopic;
        cursor: number;
        open_board_question_count?: number;
      };
      const openBoardQuestionCount =
        typeof body.open_board_question_count === "number"
          ? body.open_board_question_count
          : await countOpenBoardQuestions(this.env.DB);
      this.broadcastToStream(
        {
          type: "board.question_answered",
          question: body.question,
          answer: body.answer,
          ...(body.topic ? { topic: body.topic } : {}),
          cursor: body.cursor,
          open_board_question_count: openBoardQuestionCount
        },
        { topicId: body.question.topic_id }
      );
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
          let runRowForBroadcast: RunRow = updated;
          let deliveriesSummary;
          if (frame.status === "needs_approval") {
            await enqueueRunNotificationIfNeeded(this.env.DB, this.env, updated, "needs_approval");
            runRowForBroadcast =
              (await this.env.DB.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(updated.id).first<RunRow>()) ??
              updated;
            deliveriesSummary = (
              await getDeliveriesSummaryMap(this.env.DB, "run", [runRowForBroadcast.id])
            ).get(runRowForBroadcast.id);
          }
          const runRecord = mapRunRow(runRowForBroadcast, {
            view: "summary",
            tailBytes: 16384,
            promptMode: "preview",
            deliveriesSummary
          });
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
