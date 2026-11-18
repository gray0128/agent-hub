import { authenticateRequest, ensureNodeAllowedForClient, requireScope } from "./auth";
import {
  ackNativeEvent,
  cancelRun,
  checkpointRunApproval,
  claimRunsForNode,
  completeRun,
  createApiKey,
  createNativeEvent,
  createRun,
  forkThread,
  getApiKeyRawById,
  getNativeEventById,
  getPushSubscriptionByIdWithSecret,
  getRunById,
  heartbeatRun,
  listApiKeys,
  listDeliveriesForRun,
  listDeliveriesForSource,
  listNativeEvents,
  listNodes,
  listNodesBoundToNotifyKey,
  listPushSubscriptions,
  listRunEvents,
  listRuns,
  listThreads,
  mapRunRow,
  patchApiKey,
  patchNode,
  patchPushSubscription,
  patchQueuedRun,
  patchThread,
  pruneExpiredNativeActivity,
  reapExpiredLeases,
  recordPushSubscriptionTestResult,
  redeliverSourceDeliveries,
  reorderQueuedRuns,
  resolveRunApproval,
  revokeApiKey,
  revokePushSubscription,
  upsertPushSubscription
} from "./db";
import {
  handleBinaryDownload,
  handleBootstrapMd,
  handleClientBootstrapMd,
  handleInstallSh,
  handleSkillMd,
  handleVersionJson
} from "./downloads";
import { NodeHub } from "./node-hub";
import { processNotifyBatch } from "./notify-queue";
import {
  type ApiScope,
  type Env,
  HubError,
  type NativeEventRecord,
  type NodeRecord,
  type NotificationDeliveryRecord,
  type NotifyQueueMessage,
  type RunRecord,
  type RunStatus,
  type ThreadStatus,
  type WebPushSubscriptionSecret
} from "./types";
import { randomToken, sha256Hex } from "./ulid";
import {
  parseAckNativeEventRequest,
  parseApprovalCheckpointRequest,
  parseCancelRunRequest,
  parseClaimRequest,
  parseCompleteRequest,
  parseCreateKeyRequest,
  parseCreatePushSubscriptionRequest,
  parseCreateRunRequest,
  parseForkThreadRequest,
  parseHeartbeatRequest,
  parseIncludeRevokedQuery,
  parseListNativeEventsQuery,
  parseNativeEventCreateRequest,
  parsePatchKeyRequest,
  parsePatchNodeRequest,
  parsePatchPushSubscriptionRequest,
  parsePatchRunRequest,
  parsePatchThreadRequest,
  parseRedeliverRequest,
  parseReorderRunsRequest,
  parseResolveRunRequest,
  readJsonBody
} from "./validation";
import { getVapidConfig, isLoopbackPushAllowed, sendWebPushNotification } from "./web-push";
import { decryptJsonSecret, decryptWebhookConfig, encryptJsonSecret, encryptWebhookConfig } from "./webhook-crypto";

export { NodeHub };

function getNodeHubStub(env: Env): DurableObjectStub {
  const id = env.NODE_HUB.idFromName("global");
  return env.NODE_HUB.get(id);
}

function getLeaseTtl(env: Env): number {
  const parsed = Number.parseInt(env.LEASE_TTL_SECONDS || "90", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90;
}

function requireWebhookEncryptionKey(env: Env): string {
  const encSecret = env.WEBHOOK_ENCRYPTION_KEY?.trim();
  if (!encSecret) {
    throw new HubError(500, "INTERNAL_ERROR", "WEBHOOK_ENCRYPTION_KEY is not configured.");
  }
  return encSecret;
}

function jsonError(err: unknown): Response {
  if (err instanceof HubError) {
    return Response.json(
      {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {})
        }
      },
      { status: err.status }
    );
  }
  const msg = err instanceof Error ? err.message : "Internal server error";
  return Response.json(
    {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: msg
      }
    },
    { status: 500 }
  );
}

async function readOptionalJsonBody(request: Request, label: string): Promise<unknown> {
  const contentLen = request.headers.get("Content-Length");
  if (contentLen === "0") {
    return undefined;
  }
  const text = await request.text();
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HubError(400, "BAD_REQUEST", `${label} request body must be valid JSON.`);
  }
}

async function doPost(env: Env, path: string, body: unknown): Promise<void> {
  const stub = getNodeHubStub(env);
  await stub.fetch(`https://node-hub${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function broadcastRun(env: Env, run: RunRecord): Promise<void> {
  await doPost(env, "/internal/broadcast-run", { run }).catch(() => undefined);
}

async function broadcastNode(env: Env, node: NodeRecord): Promise<void> {
  await doPost(env, "/internal/broadcast-node", { node }).catch(() => undefined);
}

async function broadcastNativeEvent(
  env: Env,
  event: NativeEventRecord,
  openInteractionCount?: number
): Promise<void> {
  await doPost(env, "/internal/broadcast-native-event", {
    event,
    ...(openInteractionCount !== undefined ? { open_interaction_count: openInteractionCount } : {})
  }).catch(() => undefined);
}

async function broadcastDelivery(env: Env, delivery: NotificationDeliveryRecord): Promise<void> {
  await doPost(env, "/internal/broadcast-delivery", { delivery }).catch(() => undefined);
}

function getNativeEventsRetentionDays(env: Env): number {
  const raw = env.NATIVE_EVENTS_RETENTION_DAYS?.trim() ?? "";
  if (!/^\d+$/.test(raw)) {
    return 30;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return 30;
  }
  return Math.min(parsed, 3650);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // Public bootstrap & skill distribution endpoints
      if (request.method === "GET" && pathname === "/skill/SKILL.md") {
        return handleSkillMd();
      }
      if (request.method === "GET" && pathname === "/dl/bootstrap.md") {
        return handleBootstrapMd(request, env);
      }
      if (request.method === "GET" && pathname === "/dl/client-bootstrap.md") {
        return handleClientBootstrapMd(request, env);
      }
      if (request.method === "GET" && pathname === "/dl/install.sh") {
        return handleInstallSh(request, env);
      }
      if (request.method === "GET" && pathname === "/dl/version.json") {
        return handleVersionJson(request, env);
      }
      if (request.method === "GET" && pathname.startsWith("/dl/")) {
        const assetName = pathname.slice("/dl/".length);
        return await handleBinaryDownload(assetName, env);
      }

      // WebSocket endpoints
      if (pathname === "/ws/node") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          throw new HubError(426, "BAD_REQUEST", "Expected WebSocket upgrade.");
        }
        const principal = await authenticateRequest(request, env, ctx, false);
        requireScope(principal, ["node"]);
        if (!principal.boundNodeId) {
          throw new HubError(403, "FORBIDDEN_SCOPE", "Node key has no bound_node_id.");
        }
        const stub = getNodeHubStub(env);
        const headers = new Headers(request.headers);
        headers.set("x-ahub-node-id", principal.boundNodeId);
        if (principal.keyId) headers.set("x-ahub-key-id", principal.keyId);
        return stub.fetch("https://node-hub/internal/ws/node", {
          headers,
          method: request.method
        });
      }

      if (pathname === "/ws/stream") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          throw new HubError(426, "BAD_REQUEST", "Expected WebSocket upgrade.");
        }
        const principal = await authenticateRequest(request, env, ctx, true);
        requireScope(principal, ["admin", "client"]);
        const runIdParam = url.searchParams.get("run_id");
        if (principal.scope === "client" && !runIdParam) {
          throw new HubError(
            403,
            "FORBIDDEN_SCOPE",
            "Client key must pass ?run_id=<id> when subscribing to /ws/stream."
          );
        }
        if (runIdParam) {
          // Verify permission to read target run before opening socket
          await getRunById(env.DB, principal, runIdParam, "summary", 1024);
        }

        const stub = getNodeHubStub(env);
        const headers = new Headers(request.headers);
        headers.set("x-ahub-scope", principal.scope);
        if (principal.keyId) headers.set("x-ahub-key-id", principal.keyId);
        if (principal.boundNodeId) headers.set("x-ahub-bound-node-id", principal.boundNodeId);
        headers.set("x-ahub-allowed-nodes", JSON.stringify(principal.allowedNodes));
        const forwardUrl = new URL("https://node-hub/internal/ws/stream");
        if (runIdParam) forwardUrl.searchParams.set("run_id", runIdParam);
        return stub.fetch(forwardUrl.toString(), {
          headers,
          method: request.method
        });
      }

      // Authenticated REST API
      if (pathname.startsWith("/api/v1/")) {
        const principal = await authenticateRequest(request, env, ctx, false);

        if (request.method === "GET" && pathname === "/api/v1/auth/me") {
          return Response.json({
            ok: true,
            principal: {
              kind: principal.kind,
              scope: principal.scope,
              bound_node_id: principal.boundNodeId,
              allowed_nodes: principal.allowedNodes,
              allow_unsandboxed: principal.allowUnsandboxed,
              max_depth_limit: principal.maxDepthLimit
            }
          });
        }

        // 2.1 Nodes & Workspaces
        if (request.method === "GET" && pathname === "/api/v1/nodes") {
          requireScope(principal, ["admin", "client"]);
          const nodes = await listNodes(env.DB, principal);
          return Response.json({ ok: true, nodes });
        }

        const patchNodeMatch = /^\/api\/v1\/nodes\/([^/]+)$/.exec(pathname);
        if (request.method === "PATCH" && patchNodeMatch) {
          requireScope(principal, ["admin"]);
          const nodeId = decodeURIComponent(patchNodeMatch[1]!);
          const body = parsePatchNodeRequest(await readJsonBody(request));
          const node = await patchNode(env.DB, nodeId, body);
          ctx.waitUntil(broadcastNode(env, node));
          return Response.json({ ok: true, node });
        }

        const nativeEventsMatch = /^\/api\/v1\/nodes\/([^/]+)\/native-events$/.exec(pathname);
        if (request.method === "POST" && nativeEventsMatch) {
          requireScope(principal, ["node"]);
          const nodeId = decodeURIComponent(nativeEventsMatch[1]!);
          if (principal.boundNodeId !== nodeId) {
            throw new HubError(403, "FORBIDDEN_SCOPE", "Node key cannot emit native events for another node.");
          }
          const body = parseNativeEventCreateRequest(await readJsonBody(request));
          const result = await createNativeEvent(env.DB, env, nodeId, body);
          if (!result.deduplicated) {
            if (result.event.deliveries_summary && result.event.deliveries_summary.total > 0) {
              const deliveries = await listDeliveriesForSource(env.DB, "native_event", result.event.id);
              for (const d of deliveries) {
                ctx.waitUntil(broadcastDelivery(env, d));
              }
            }
            ctx.waitUntil(broadcastNativeEvent(env, result.event));
          }
          const status = result.deduplicated ? 200 : result.event.notify_status === "queued" ? 202 : 200;
          return Response.json({ ok: true, ...result }, { status });
        }

        const claimMatch = /^\/api\/v1\/nodes\/([^/]+)\/claim$/.exec(pathname);
        if (request.method === "POST" && claimMatch) {
          requireScope(principal, ["node"]);
          const nodeId = decodeURIComponent(claimMatch[1]!);
          if (principal.boundNodeId !== nodeId) {
            throw new HubError(403, "FORBIDDEN_SCOPE", "Node key cannot claim runs for another node.");
          }
          const body = parseClaimRequest(await readJsonBody(request));
          const claimedRows = await claimRunsForNode(
            env.DB,
            nodeId,
            body.connNonce,
            body.busyWorkdirs,
            getLeaseTtl(env)
          );
          const claimedRuns = claimedRows.map((r) => mapRunRow(r, { view: "list", promptMode: "raw" }));
          for (const row of claimedRows) {
            ctx.waitUntil(broadcastRun(env, mapRunRow(row, { view: "list", promptMode: "preview" })));
          }
          return Response.json({ ok: true, claimed_runs: claimedRuns });
        }

        const heartbeatMatch = /^\/api\/v1\/runs\/([^/]+)\/heartbeat$/.exec(pathname);
        if (request.method === "POST" && heartbeatMatch) {
          requireScope(principal, ["node"]);
          if (!principal.boundNodeId) {
            throw new HubError(403, "FORBIDDEN_SCOPE", "Missing bound_node_id on node key.");
          }
          const runId = decodeURIComponent(heartbeatMatch[1]!);
          const body = parseHeartbeatRequest(await readJsonBody(request));
          const res = await heartbeatRun(
            env.DB,
            runId,
            principal.boundNodeId,
            body.leaseOwner,
            getLeaseTtl(env)
          );
          return Response.json({
            ok: true,
            status: res.status,
            should_abort: res.shouldAbort,
            lease_expires_at: res.leaseExpiresAt
          });
        }

        const approvalMatch = /^\/api\/v1\/runs\/([^/]+)\/approval$/.exec(pathname);
        if (request.method === "POST" && approvalMatch) {
          requireScope(principal, ["node"]);
          if (!principal.boundNodeId) {
            throw new HubError(403, "FORBIDDEN_SCOPE", "Missing bound_node_id on node key.");
          }
          const runId = decodeURIComponent(approvalMatch[1]!);
          const body = parseApprovalCheckpointRequest(await readJsonBody(request));
          const updatedRow = await checkpointRunApproval(
            env.DB,
            env,
            principal,
            runId,
            getLeaseTtl(env),
            body
          );
          const runRecord = mapRunRow(updatedRow, { view: "summary", tailBytes: 16384 });
          await broadcastRun(env, runRecord);
          return Response.json({ ok: true, run: runRecord });
        }

        const completeMatch = /^\/api\/v1\/runs\/([^/]+)\/complete$/.exec(pathname);
        if (request.method === "POST" && completeMatch) {
          requireScope(principal, ["node"]);
          if (!principal.boundNodeId) {
            throw new HubError(403, "FORBIDDEN_SCOPE", "Missing bound_node_id on node key.");
          }
          const runId = decodeURIComponent(completeMatch[1]!);
          const body = parseCompleteRequest(await readJsonBody(request));
          const updatedRow = await completeRun(env.DB, env, runId, principal.boundNodeId, body);
          const runRecord = mapRunRow(updatedRow, { view: "summary", tailBytes: 16384 });
          await broadcastRun(env, runRecord);
          return Response.json({ ok: true, run: runRecord });
        }

        // 2.2 Threads
        if (request.method === "GET" && pathname === "/api/v1/threads") {
          requireScope(principal, ["admin", "client"]);
          const nodeId = url.searchParams.get("node_id") || undefined;
          const statusRaw = url.searchParams.get("status") || undefined;
          const status = statusRaw === "active" || statusRaw === "archived" ? (statusRaw as ThreadStatus) : undefined;
          const q = url.searchParams.get("q") || undefined;
          const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || "50"), 1), 200);
          const threads = await listThreads(env.DB, principal, { nodeId, status, q, limit });
          return Response.json({ ok: true, threads });
        }

        const patchThreadMatch = /^\/api\/v1\/threads\/([^/]+)$/.exec(pathname);
        if (request.method === "PATCH" && patchThreadMatch) {
          requireScope(principal, ["admin", "client"]);
          const threadId = decodeURIComponent(patchThreadMatch[1]!);
          const body = parsePatchThreadRequest(await readJsonBody(request));
          const thread = await patchThread(env.DB, principal, threadId, body);
          return Response.json({ ok: true, thread });
        }

        const forkThreadMatch = /^\/api\/v1\/threads\/([^/]+)\/fork$/.exec(pathname);
        if (request.method === "POST" && forkThreadMatch) {
          requireScope(principal, ["admin", "client"]);
          const threadId = decodeURIComponent(forkThreadMatch[1]!);
          const body = parseForkThreadRequest(await readJsonBody(request));
          ensureNodeAllowedForClient(principal, body.nodeId);
          const { thread, seedRun } = await forkThread(env.DB, env, principal, threadId, body);
          const runRecord = mapRunRow(seedRun, { view: "summary" });
          await doPost(env, "/internal/wake", {
            node_id: seedRun.node_id,
            reason: "run_queued",
            run_id: seedRun.id
          });
          ctx.waitUntil(broadcastRun(env, runRecord));
          return Response.json({ ok: true, thread, run: runRecord }, { status: 202 });
        }

        // 2.3 Runs
        if (request.method === "POST" && pathname === "/api/v1/runs") {
          requireScope(principal, ["admin", "client"]);
          const body = parseCreateRunRequest(await readJsonBody(request));
          const headerIdem = request.headers.get("Idempotency-Key") || undefined;
          const { run } = await createRun(env.DB, env, principal, body, headerIdem);

          // Wake target node and notify stream subscribers
          await doPost(env, "/internal/wake", {
            node_id: run.node_id,
            reason: "run_queued",
            run_id: run.id
          });
          const initialRecord = mapRunRow(run, { view: "summary", tailBytes: 16384 });
          await broadcastRun(env, initialRecord);

          const waitMs = Math.min(Math.max(Number(url.searchParams.get("wait_ms") || "0"), 0), 45000);
          if (waitMs > 0) {
            const stub = getNodeHubStub(env);
            const waitPromise = stub.fetch(
              `https://node-hub/internal/wait-run?run_id=${encodeURIComponent(run.id)}&timeout_ms=${waitMs}`
            );
            // Re-check DB right after registering waiter so we never miss an ultra-fast completion
            const freshImmediate = await getRunById(env.DB, principal, run.id, "summary", 16384);
            if (
              freshImmediate.status === "done" ||
              freshImmediate.status === "failed" ||
              freshImmediate.status === "cancelled" ||
              freshImmediate.status === "needs_approval"
            ) {
              return Response.json({ ok: true, run: freshImmediate }, { status: 200 });
            }
            const waitResp = await waitPromise;
            const waitData = (await waitResp.json()) as { run: RunRecord | null };
            const finalRun = waitData.run ?? (await getRunById(env.DB, principal, run.id, "summary", 16384));
            if (
              finalRun.status === "done" ||
              finalRun.status === "failed" ||
              finalRun.status === "cancelled" ||
              finalRun.status === "needs_approval"
            ) {
              return Response.json({ ok: true, run: finalRun }, { status: 200 });
            }
            const armed = body.notify.target !== "none";
            return Response.json(
              { ok: true, run: { ...finalRun, webhook_armed: armed } },
              { status: 202 }
            );
          }

          return Response.json({ ok: true, run: initialRecord }, { status: 202 });
        }

        if (request.method === "GET" && pathname === "/api/v1/runs") {
          requireScope(principal, ["admin", "client"]);
          const nodeId = url.searchParams.get("node_id") || undefined;
          const threadId = url.searchParams.get("thread_id") || undefined;
          const status = (url.searchParams.get("status") || undefined) as RunStatus | undefined;
          const rootRunId = url.searchParams.get("root_run_id") || undefined;
          const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || "50"), 1), 200);
          const runs = await listRuns(env.DB, principal, { nodeId, threadId, status, rootRunId, limit });
          return Response.json({ ok: true, runs });
        }

        if (request.method === "POST" && pathname === "/api/v1/runs/reorder") {
          requireScope(principal, ["admin", "client"]);
          const body = parseReorderRunsRequest(await readJsonBody(request));
          const runs = await reorderQueuedRuns(env.DB, principal, body.nodeId, body.orderedRunIds);
          return Response.json({
            ok: true,
            runs: runs.map((r) => mapRunRow(r, { view: "list" }))
          });
        }

        const runDetailMatch = /^\/api\/v1\/runs\/([^/]+)$/.exec(pathname);
        if (request.method === "GET" && runDetailMatch) {
          requireScope(principal, ["admin", "client"]);
          const runId = decodeURIComponent(runDetailMatch[1]!);
          const view = url.searchParams.get("view") === "full" ? "full" : "summary";
          const tailBytes = Math.min(Math.max(Number(url.searchParams.get("tail_bytes") || "16384"), 256), 900 * 1024);
          const run = await getRunById(env.DB, principal, runId, view, tailBytes);
          return Response.json({ ok: true, run });
        }

        if (request.method === "PATCH" && runDetailMatch) {
          requireScope(principal, ["admin", "client"]);
          const runId = decodeURIComponent(runDetailMatch[1]!);
          const body = parsePatchRunRequest(await readJsonBody(request));
          const updated = await patchQueuedRun(env.DB, principal, runId, body);
          const runRecord = mapRunRow(updated, { view: "summary" });
          await broadcastRun(env, runRecord);
          await doPost(env, "/internal/wake", {
            node_id: updated.node_id,
            reason: "run_queued",
            run_id: updated.id
          });
          return Response.json({ ok: true, run: runRecord });
        }

        const runEventsMatch = /^\/api\/v1\/runs\/([^/]+)\/events$/.exec(pathname);
        if (request.method === "GET" && runEventsMatch) {
          requireScope(principal, ["admin", "client"]);
          const runId = decodeURIComponent(runEventsMatch[1]!);
          const afterSeq = Math.max(Number(url.searchParams.get("after_seq") || "0"), 0);
          const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || "200"), 1), 500);
          const res = await listRunEvents(env.DB, principal, runId, afterSeq, limit);
          return Response.json({ ok: true, events: res.events, next_seq: res.nextSeq });
        }

        const runResolveMatch = /^\/api\/v1\/runs\/([^/]+)\/resolve$/.exec(pathname);
        if (request.method === "POST" && runResolveMatch) {
          requireScope(principal, ["admin", "client"]);
          const runId = decodeURIComponent(runResolveMatch[1]!);
          const rawBody = await readOptionalJsonBody(request, "Resolve");
          const body = parseResolveRunRequest(rawBody);
          const { run, alreadyTerminal } = await resolveRunApproval(env.DB, env, principal, runId, body);
          if (!alreadyTerminal) {
            await doPost(env, "/internal/abort", {
              targets: [{ nodeId: run.node_id, runId: run.id }],
              reason: "approval_resolved"
            }).catch(() => undefined);
          }
          const runRecord = mapRunRow(run, { view: "summary", tailBytes: 16384 });
          await broadcastRun(env, runRecord);
          return Response.json({ ok: true, run: runRecord });
        }

        const runCancelMatch = /^\/api\/v1\/runs\/([^/]+)\/cancel$/.exec(pathname);
        if (request.method === "POST" && runCancelMatch) {
          requireScope(principal, ["admin", "client"]);
          const runId = decodeURIComponent(runCancelMatch[1]!);
          const rawBody = await readOptionalJsonBody(request, "Cancel");
          const body = parseCancelRunRequest(rawBody);
          const { cancelledRuns, abortTargets } = await cancelRun(env.DB, env, principal, runId, body);
          if (abortTargets.length > 0) {
            await doPost(env, "/internal/abort", { targets: abortTargets, reason: body.reason });
          }
          const mapped = cancelledRuns.map((r) => mapRunRow(r, { view: "summary" }));
          for (const r of mapped) {
            await broadcastRun(env, r);
          }
          return Response.json({ ok: true, cancelled_runs: mapped });
        }

        // 2.4 API Keys
        if (request.method === "GET" && pathname === "/api/v1/keys") {
          requireScope(principal, ["admin"]);
          const scopeParam = url.searchParams.get("scope") || undefined;
          const scope =
            scopeParam === "admin" || scopeParam === "client" || scopeParam === "node"
              ? (scopeParam as ApiScope)
              : undefined;
          const includeRevoked = url.searchParams.get("include_revoked") === "true";
          const keys = await listApiKeys(env.DB, { scope, includeRevoked });
          return Response.json({ ok: true, keys });
        }

        if (request.method === "POST" && pathname === "/api/v1/keys") {
          requireScope(principal, ["admin"]);
          const body = parseCreateKeyRequest(await readJsonBody(request));
          let notifyWebhookCiphertext = "";
          let notifyWebhookHost = "";
          if (body.webhookUrl) {
            const encrypted = await encryptWebhookConfig(requireWebhookEncryptionKey(env), {
              url: body.webhookUrl,
              key: body.webhookKey
            });
            notifyWebhookCiphertext = encrypted.ciphertext;
            notifyWebhookHost = encrypted.host;
          }
          const prefixMap: Record<ApiScope, string> = {
            admin: "ahub_adm_",
            client: "ahub_cli_",
            node: "ahub_nod_"
          };
          const token = randomToken(prefixMap[body.scope]);
          const tokenSha256 = await sha256Hex(token);
          const key = await createApiKey(env.DB, {
            ...body,
            notifyWebhookCiphertext,
            notifyWebhookHost,
            token,
            tokenSha256
          });
          return Response.json({ ok: true, key, token }, { status: 201 });
        }

        const keyMatch = /^\/api\/v1\/keys\/([^/]+)$/.exec(pathname);
        if (request.method === "PATCH" && keyMatch) {
          requireScope(principal, ["admin"]);
          const keyId = decodeURIComponent(keyMatch[1]!);
          const body = parsePatchKeyRequest(await readJsonBody(request));
          const existing = await getApiKeyRawById(env.DB, keyId);
          if (!existing) {
            throw new HubError(404, "NOT_FOUND", `API key '${keyId}' not found.`);
          }
          if (existing.revoked_at !== null) {
            throw new HubError(409, "INVALID_STATE_TRANSITION", "Cannot modify a revoked API key.");
          }
          if (existing.scope === "node" && body.boundNodeId !== undefined) {
            throw new HubError(400, "BAD_REQUEST", "Cannot change bound_node_id of a node key.");
          }
          if (
            (body.webhookUrl !== undefined || body.webhookKey !== undefined || body.clearWebhook !== undefined) &&
            existing.scope !== "client"
          ) {
            throw new HubError(400, "BAD_REQUEST", "Webhook settings are only supported on client scope keys.");
          }

          let notifyWebhookCiphertext: string | undefined;
          let notifyWebhookHost: string | undefined;
          if (body.clearWebhook) {
            notifyWebhookCiphertext = "";
            notifyWebhookHost = "";
          } else if (body.webhookUrl !== undefined) {
            const encrypted = await encryptWebhookConfig(requireWebhookEncryptionKey(env), {
              url: body.webhookUrl,
              key: body.webhookKey
            });
            notifyWebhookCiphertext = encrypted.ciphertext;
            notifyWebhookHost = encrypted.host;
          } else if (body.webhookKey !== undefined) {
            if (!existing.notify_webhook_ciphertext) {
              throw new HubError(400, "BAD_REQUEST", "webhook_key requires webhook_url when no webhook is configured.");
            }
            const encSecret = requireWebhookEncryptionKey(env);
            let current: { url: string; key?: string };
            try {
              current = await decryptWebhookConfig(encSecret, existing.notify_webhook_ciphertext);
            } catch {
              throw new HubError(
                500,
                "INTERNAL_ERROR",
                "Existing encrypted webhook cannot be decrypted; pass a full webhook_url to overwrite it."
              );
            }
            const encrypted = await encryptWebhookConfig(encSecret, {
              url: current.url,
              key: body.webhookKey || undefined
            });
            notifyWebhookCiphertext = encrypted.ciphertext;
            notifyWebhookHost = encrypted.host;
          }

          const key = await patchApiKey(env.DB, keyId, {
            boundNodeId: body.boundNodeId,
            allowedNodes: body.allowedNodes,
            allowUnsandboxed: body.allowUnsandboxed,
            maxDepthLimit: body.maxDepthLimit,
            notifyWebhookCiphertext,
            notifyWebhookHost
          });
          const affectedNodes = await listNodesBoundToNotifyKey(env.DB, keyId);
          for (const n of affectedNodes) {
            await broadcastNode(env, n);
          }
          return Response.json({ ok: true, key });
        }

        if (request.method === "DELETE" && keyMatch) {
          requireScope(principal, ["admin"]);
          const keyId = decodeURIComponent(keyMatch[1]!);
          const res = await revokeApiKey(env.DB, keyId);
          await doPost(env, "/internal/revoke-key", {
            key_id: keyId,
            bound_node_id: res.boundNodeId
          });
          const affectedNodes = await listNodesBoundToNotifyKey(env.DB, keyId);
          for (const n of affectedNodes) {
            await broadcastNode(env, n);
          }
          return Response.json({ ok: true, revoked_at: res.revokedAt });
        }

        // 2.5 Native Activity & Delivery Ledger (admin only)
        if (request.method === "GET" && pathname === "/api/v1/native-events") {
          requireScope(principal, ["admin"]);
          const filters = parseListNativeEventsQuery(url.searchParams);
          const res = await listNativeEvents(env.DB, filters);
          return Response.json({
            ok: true,
            events: res.events,
            open_interaction_count: res.openInteractionCount,
            next_cursor: res.nextCursor
          });
        }

        const nativeEventDetailMatch = /^\/api\/v1\/native-events\/([^/]+)$/.exec(pathname);
        if (request.method === "GET" && nativeEventDetailMatch) {
          requireScope(principal, ["admin"]);
          const eventId = decodeURIComponent(nativeEventDetailMatch[1]!);
          const event = await getNativeEventById(env.DB, eventId);
          if (!event) {
            throw new HubError(404, "NOT_FOUND", `Native event '${eventId}' not found.`);
          }
          const deliveries = await listDeliveriesForSource(env.DB, "native_event", eventId);
          return Response.json({ ok: true, event, deliveries });
        }

        const nativeEventAckMatch = /^\/api\/v1\/native-events\/([^/]+)\/ack$/.exec(pathname);
        if (request.method === "POST" && nativeEventAckMatch) {
          requireScope(principal, ["admin"]);
          const eventId = decodeURIComponent(nativeEventAckMatch[1]!);
          const body = parseAckNativeEventRequest(await readOptionalJsonBody(request, "AckNativeEvent"));
          const res = await ackNativeEvent(env.DB, eventId, body.scope);
          ctx.waitUntil(broadcastNativeEvent(env, res.event, res.openInteractionCount));
          return Response.json({
            ok: true,
            event: res.event,
            acked_count: res.ackedCount,
            open_interaction_count: res.openInteractionCount
          });
        }

        const nativeEventRedeliverMatch = /^\/api\/v1\/native-events\/([^/]+)\/redeliver$/.exec(pathname);
        if (request.method === "POST" && nativeEventRedeliverMatch) {
          requireScope(principal, ["admin"]);
          const eventId = decodeURIComponent(nativeEventRedeliverMatch[1]!);
          const body = parseRedeliverRequest(await readOptionalJsonBody(request, "RedeliverNativeEvent"));
          const res = await redeliverSourceDeliveries(env.DB, env, "native_event", eventId, body.deliveryId);
          if (res.requeuedCount > 0) {
            for (const d of res.requeuedDeliveries) {
              ctx.waitUntil(broadcastDelivery(env, d));
            }
            ctx.waitUntil(broadcastNativeEvent(env, res.event, res.openInteractionCount));
          }
          return Response.json({
            ok: true,
            event: res.event,
            deliveries: res.deliveries,
            requeued_count: res.requeuedCount
          });
        }

        const runDeliveriesMatch = /^\/api\/v1\/runs\/([^/]+)\/deliveries$/.exec(pathname);
        if (request.method === "GET" && runDeliveriesMatch) {
          requireScope(principal, ["admin"]);
          const runId = decodeURIComponent(runDeliveriesMatch[1]!);
          const deliveries = await listDeliveriesForRun(env.DB, runId);
          return Response.json({ ok: true, deliveries });
        }

        const runRedeliverMatch = /^\/api\/v1\/runs\/([^/]+)\/redeliver$/.exec(pathname);
        if (request.method === "POST" && runRedeliverMatch) {
          requireScope(principal, ["admin"]);
          const runId = decodeURIComponent(runRedeliverMatch[1]!);
          const body = parseRedeliverRequest(await readOptionalJsonBody(request, "RedeliverRun"));
          const res = await redeliverSourceDeliveries(env.DB, env, "run", runId, body.deliveryId);
          if (res.requeuedCount > 0) {
            for (const d of res.requeuedDeliveries) {
              ctx.waitUntil(broadcastDelivery(env, d));
            }
            ctx.waitUntil(broadcastRun(env, res.run));
          }
          return Response.json({
            ok: true,
            run: res.run,
            deliveries: res.deliveries,
            requeued_count: res.requeuedCount
          });
        }

        // 2.6 Web Push Subscriptions (admin only)
        if (request.method === "GET" && pathname === "/api/v1/push/config") {
          requireScope(principal, ["admin"]);
          const vapid = getVapidConfig(env);
          if (!vapid.enabled) {
            return Response.json({
              ok: true,
              enabled: false,
              vapid_public_key: null,
              reason: vapid.reason
            });
          }
          return Response.json({
            ok: true,
            enabled: true,
            vapid_public_key: vapid.config.publicKey
          });
        }

        if (request.method === "GET" && pathname === "/api/v1/push-subscriptions") {
          requireScope(principal, ["admin"]);
          const includeRevoked = parseIncludeRevokedQuery(url.searchParams);
          const subscriptions = await listPushSubscriptions(env.DB, includeRevoked);
          return Response.json({ ok: true, subscriptions });
        }

        if (request.method === "POST" && pathname === "/api/v1/push-subscriptions") {
          requireScope(principal, ["admin"]);
          const body = parseCreatePushSubscriptionRequest(
            await readJsonBody(request),
            isLoopbackPushAllowed(env)
          );
          const subscriptionCiphertext = await encryptJsonSecret(
            requireWebhookEncryptionKey(env),
            body.subscription
          );
          const endpointSha256 = await sha256Hex(body.subscription.endpoint);
          const { subscription, created } = await upsertPushSubscription(env.DB, {
            label: body.label,
            endpointSha256,
            endpointHost: body.endpointHost,
            subscriptionCiphertext,
            nodeFilter: body.nodeFilter,
            eventFilter: body.eventFilter
          });
          return Response.json({ ok: true, subscription }, { status: created ? 201 : 200 });
        }

        const pushSubTestMatch = /^\/api\/v1\/push-subscriptions\/([^/]+)\/test$/.exec(pathname);
        if (request.method === "POST" && pushSubTestMatch) {
          requireScope(principal, ["admin"]);
          const subId = decodeURIComponent(pushSubTestMatch[1]!);
          const found = await getPushSubscriptionByIdWithSecret(env.DB, subId);
          if (!found) {
            throw new HubError(404, "NOT_FOUND", `Push subscription '${subId}' not found.`);
          }
          if (found.record.revoked_at !== null) {
            throw new HubError(
              409,
              "INVALID_STATE_TRANSITION",
              "Cannot test a revoked push subscription."
            );
          }
          const vapid = getVapidConfig(env);
          if (!vapid.enabled) {
            throw new HubError(400, "BAD_REQUEST", "VAPID keys are not configured on Worker.");
          }
          const secretSub = await decryptJsonSecret<WebPushSubscriptionSecret>(
            requireWebhookEncryptionKey(env),
            found.subscriptionCiphertext
          );
          const sendResult = await sendWebPushNotification({
            subscription: secretSub,
            payload: {
              v: 1,
              kind: "test",
              id: subId,
              tag: `ahub-test-${subId}`,
              urgent: false,
              title: "agent-hub 测试通知",
              body: `设备 ${found.record.label} Web Push 通道连通正常`,
              target_url: "/?pane=native",
              ts: new Date().toISOString()
            },
            vapid: vapid.config,
            urgency: "normal",
            ttlSeconds: 86400,
            allowLoopbackForTest: isLoopbackPushAllowed(env)
          });
          const subscription = await recordPushSubscriptionTestResult(env.DB, subId, sendResult);
          return Response.json({
            ok: true,
            delivered: sendResult.ok,
            http_status: sendResult.httpStatus,
            error_code: sendResult.errorCode,
            error_message: sendResult.errorMessage,
            subscription
          });
        }

        const pushSubMatch = /^\/api\/v1\/push-subscriptions\/([^/]+)$/.exec(pathname);
        if (request.method === "PATCH" && pushSubMatch) {
          requireScope(principal, ["admin"]);
          const subId = decodeURIComponent(pushSubMatch[1]!);
          const body = parsePatchPushSubscriptionRequest(await readJsonBody(request));
          const subscription = await patchPushSubscription(env.DB, subId, body);
          return Response.json({ ok: true, subscription });
        }

        if (request.method === "DELETE" && pushSubMatch) {
          requireScope(principal, ["admin"]);
          const subId = decodeURIComponent(pushSubMatch[1]!);
          const res = await revokePushSubscription(env.DB, subId);
          return Response.json({ ok: true, revoked_at: res.revokedAt });
        }

        // Deterministic admin helper to trigger lease reaping on demand
        if (request.method === "POST" && pathname === "/api/v1/admin/reap-leases") {
          requireScope(principal, ["admin"]);
          const reaped = await reapExpiredLeases(env.DB, env);
          for (const r of reaped) {
            await broadcastRun(env, mapRunRow(r, { view: "summary" }));
          }
          return Response.json({ ok: true, reaped_count: reaped.length, reaped_ids: reaped.map((r) => r.id) });
        }

        throw new HubError(404, "NOT_FOUND", `Route ${request.method} ${pathname} not found.`);
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return jsonError(err);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const reaped = await reapExpiredLeases(env.DB, env);
    for (const r of reaped) {
      ctx.waitUntil(broadcastRun(env, mapRunRow(r, { view: "summary" })));
    }
    try {
      await pruneExpiredNativeActivity(env.DB, getNativeEventsRetentionDays(env), 500);
    } catch (err) {
      console.error("[cron] pruneExpiredNativeActivity failed:", err);
    }
  },

  async queue(batch: MessageBatch<NotifyQueueMessage>, env: Env): Promise<void> {
    await processNotifyBatch(batch, env);
  }
};
