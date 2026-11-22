import {
  ensureBoardChannelAllowed,
  ensureNodeAllowedForClient,
  ensureRunAccessible
} from "./auth";
import {
  assertNoDelegationCycle,
  dependencySetsMatchWithRetryLineage,
  deriveThreadTitle,
  ensureParentRunDelegatable,
  getNodeById,
  hydrateRunRecord,
  hydrateRunRecords,
  parseNullableJsonObject,
  parseRunLabelsJson,
  resolveWorkspace,
  type RunRow
} from "./db";
import { deepEqualJson } from "./json-schema-subset";
import {
  type AuthPrincipal,
  type Env,
  HubError,
  type RunRecord,
  type RunStatus
} from "./types";
import { newId } from "./ulid";
import {
  codePointLength,
  type ParsedCreatePlan,
  type ParsedPlanNodeSpec,
  type ParsedRetryRun,
  RUN_ID_RE
} from "./validation";

export interface TopologicalPlanResult {
  ordered: ParsedPlanNodeSpec[];
  internalDepsByKey: Map<string, string[]>;
  externalDepsByKey: Map<string, string[]>;
}

export function kahnTopologicalSort(nodes: readonly ParsedPlanNodeSpec[]): TopologicalPlanResult {
  const nodeByKey = new Map<string, ParsedPlanNodeSpec>();
  for (const node of nodes) {
    nodeByKey.set(node.key, node);
  }

  const inDegree = new Map<string, number>();
  const dependentsByKey = new Map<string, string[]>();
  const internalDepsByKey = new Map<string, string[]>();
  const externalDepsByKey = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.key, 0);
    dependentsByKey.set(node.key, []);
    internalDepsByKey.set(node.key, []);
    externalDepsByKey.set(node.key, []);
  }

  for (const node of nodes) {
    const internalDeps: string[] = [];
    const externalDeps: string[] = [];
    for (const dep of node.dependsOn) {
      if (nodeByKey.has(dep)) {
        if (dep === node.key) {
          throw new HubError(
            400,
            "DEPENDENCY_CYCLE_DETECTED",
            `Plan node '${node.key}' cannot depend on itself.`
          );
        }
        internalDeps.push(dep);
        dependentsByKey.get(dep)!.push(node.key);
        inDegree.set(node.key, (inDegree.get(node.key) ?? 0) + 1);
      } else if (RUN_ID_RE.test(dep)) {
        externalDeps.push(dep);
      } else {
        throw new HubError(
          400,
          "BAD_REQUEST",
          `Plan node '${node.key}' references unknown dependency '${dep}'.`
        );
      }
    }
    internalDepsByKey.set(node.key, internalDeps);
    externalDepsByKey.set(node.key, externalDeps);
  }

  const queue: string[] = [];
  for (const node of nodes) {
    if ((inDegree.get(node.key) ?? 0) === 0) {
      queue.push(node.key);
    }
  }

  const ordered: ParsedPlanNodeSpec[] = [];
  let head = 0;
  while (head < queue.length) {
    const key = queue[head++]!;
    ordered.push(nodeByKey.get(key)!);
    for (const nextKey of dependentsByKey.get(key) ?? []) {
      const nextDeg = (inDegree.get(nextKey) ?? 0) - 1;
      inDegree.set(nextKey, nextDeg);
      if (nextDeg === 0) {
        queue.push(nextKey);
      }
    }
  }

  if (ordered.length !== nodes.length) {
    throw new HubError(
      400,
      "DEPENDENCY_CYCLE_DETECTED",
      "Plan dependency graph contains a cycle."
    );
  }

  return {
    ordered,
    internalDepsByKey,
    externalDepsByKey
  };
}

export async function createPlan(
  db: D1Database,
  env: Env,
  principal: AuthPrincipal,
  input: ParsedCreatePlan,
  headerIdempotencyKey?: string,
  nowMs = Date.now()
): Promise<{
  planId: string;
  runs: RunRecord[];
  queuedRunRows: RunRow[];
  deduplicated: boolean;
}> {
  if (headerIdempotencyKey !== undefined) {
    const hdrLen = codePointLength(headerIdempotencyKey);
    if (hdrLen < 8 || hdrLen > 128) {
      throw new HubError(400, "BAD_REQUEST", "Idempotency-Key header must have length 8..128.");
    }
  }

  if (principal.scope === "client" && !principal.allowUnsandboxed) {
    if (input.nodes.some((n) => !n.sandbox)) {
      throw new HubError(
        403,
        "FORBIDDEN_SCOPE",
        "Client key is not permitted to disable sandbox (--no-sandbox)."
      );
    }
  }

  // 1. Kahn O(V + E) topological sort & reference check (zero DB writes on cycle)
  const topo = kahnTopologicalSort(input.nodes);

  // 2. Validate board_topic_id existence & channel prefix permission
  if (input.boardTopicId) {
    const topicRow = await db
      .prepare(`SELECT id, channel FROM board_topics WHERE id = ?1 LIMIT 1`)
      .bind(input.boardTopicId)
      .first<{ id: string; channel: string }>();
    if (!topicRow) {
      throw new HubError(404, "NOT_FOUND", `Board topic '${input.boardTopicId}' not found.`);
    }
    ensureBoardChannelAllowed(principal, topicRow.channel);
  }

  // 3. Validate external run_... dependencies existence & access
  const allExternalRunIds = Array.from(
    new Set(Array.from(topo.externalDepsByKey.values()).flat())
  );
  const externalRunById = new Map<
    string,
    { id: string; node_id: string; created_by_key_id: string | null; status: RunStatus }
  >();
  const chunkSize = 50;
  for (let i = 0; i < allExternalRunIds.length; i += chunkSize) {
    const chunk = allExternalRunIds.slice(i, i + chunkSize);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(", ");
    const res = await db
      .prepare(`SELECT id, node_id, created_by_key_id, status FROM runs WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ id: string; node_id: string; created_by_key_id: string | null; status: RunStatus }>();
    for (const row of res.results ?? []) {
      externalRunById.set(row.id, row);
    }
  }
  for (const extId of allExternalRunIds) {
    const extRow = externalRunById.get(extId);
    if (!extRow) {
      throw new HubError(400, "BAD_REQUEST", `Dependency run '${extId}' not found.`);
    }
    ensureRunAccessible(principal, extRow);
  }

  // 4. Validate parent_run_id & depth limits
  const defaultMaxDepth = Number.parseInt(env.DEFAULT_MAX_DEPTH || "1", 10);
  const baseMaxDepth = Number.isFinite(defaultMaxDepth) ? Math.min(Math.max(defaultMaxDepth, 0), 3) : 1;
  let parentRun: {
    id: string;
    root_run_id: string;
    depth: number;
    max_depth: number;
    node_id: string;
    workdir: string;
    created_by_key_id: string | null;
  } | null = null;
  let depth = 0;
  let maxDepth =
    principal.scope === "client" ? Math.min(baseMaxDepth, principal.maxDepthLimit) : baseMaxDepth;

  if (input.parentRunId) {
    parentRun = await db
      .prepare(
        `SELECT id, root_run_id, depth, max_depth, node_id, workdir, created_by_key_id
         FROM runs WHERE id = ?1`
      )
      .bind(input.parentRunId)
      .first<{
        id: string;
        root_run_id: string;
        depth: number;
        max_depth: number;
        node_id: string;
        workdir: string;
        created_by_key_id: string | null;
      }>();
    if (!parentRun) {
      throw new HubError(400, "BAD_REQUEST", `Parent run '${input.parentRunId}' not found.`);
    }
    await ensureParentRunDelegatable(db, principal, parentRun);
    depth = parentRun.depth + 1;
    maxDepth =
      principal.scope === "client"
        ? Math.min(parentRun.max_depth, principal.maxDepthLimit)
        : parentRun.max_depth;
    if (depth > maxDepth) {
      throw new HubError(
        409,
        "DEPTH_LIMIT_EXCEEDED",
        `Delegation depth ${depth} exceeds max_depth ${maxDepth}.`
      );
    }
  }

  // 5. Validate each node's scope, existence, draining, workspace, and delegation cycle
  const nodeCache = new Map<string, NonNullable<Awaited<ReturnType<typeof getNodeById>>>>();
  const resolvedByKey = new Map<string, { workdir: string; projectKey: string }>();

  for (const spec of input.nodes) {
    if (principal.scope === "client") {
      ensureNodeAllowedForClient(principal, spec.nodeId);
    }
    let nodeRecord = nodeCache.get(spec.nodeId);
    if (!nodeRecord) {
      const fetched = await getNodeById(db, spec.nodeId);
      if (!fetched) {
        throw new HubError(404, "NODE_NOT_FOUND", `Node '${spec.nodeId}' not found.`, undefined, [
          "ahub nodes --json"
        ]);
      }
      nodeRecord = fetched;
      nodeCache.set(spec.nodeId, nodeRecord);
    }
    if (nodeRecord.status === "draining") {
      throw new HubError(409, "NODE_DRAINING", `Node '${spec.nodeId}' is draining.`);
    }
    const resolved = resolveWorkspace(nodeRecord.workspaces, spec.workdir);
    resolvedByKey.set(spec.key, { workdir: resolved.path, projectKey: resolved.projectKey });

    if (parentRun) {
      await assertNoDelegationCycle(db, parentRun.id, spec.nodeId, resolved.path);
    }
  }

  // 6. Idempotency check
  const effectiveIdemKey = input.idempotencyKey ?? headerIdempotencyKey;
  const dbIdemKey = effectiveIdemKey ? `plan:${effectiveIdemKey}` : null;

  const checkExistingPlanIdempotency = async (
    seedRun: RunRow
  ): Promise<{
    planId: string;
    runs: RunRecord[];
    queuedRunRows: RunRow[];
    deduplicated: boolean;
  }> => {
    ensureRunAccessible(principal, seedRun);
    if (!seedRun.plan_id) {
      throw new HubError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key already used by a non-plan run."
      );
    }
    const existingRes = await db
      .prepare(`SELECT * FROM runs WHERE plan_id = ?1 AND retry_of_run_id IS NULL`)
      .bind(seedRun.plan_id)
      .all<RunRow>();
    const existingRows = existingRes.results ?? [];
    for (const r of existingRows) {
      ensureRunAccessible(principal, r);
    }
    if (existingRows.length !== input.nodes.length) {
      throw new HubError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key already used with different plan node count."
      );
    }
    const existingByKey = new Map<string, RunRow>();
    for (const r of existingRows) {
      if (!r.plan_key) {
        throw new HubError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key plan mismatch.");
      }
      existingByKey.set(r.plan_key, r);
    }

    const existingIds = existingRows.map((r) => r.id);
    const depsByRunId = new Map<string, string[]>();
    for (let i = 0; i < existingIds.length; i += chunkSize) {
      const chunk = existingIds.slice(i, i + chunkSize);
      const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(", ");
      const depRes = await db
        .prepare(
          `SELECT run_id, depends_on_run_id FROM run_dependencies WHERE run_id IN (${placeholders})`
        )
        .bind(...chunk)
        .all<{ run_id: string; depends_on_run_id: string }>();
      for (const row of depRes.results ?? []) {
        const list = depsByRunId.get(row.run_id) ?? [];
        list.push(row.depends_on_run_id);
        depsByRunId.set(row.run_id, list);
      }
    }

    const existingThreadIds = Array.from(new Set(existingRows.map((r) => r.thread_id)));
    const threadTitleById = new Map<string, string>();
    for (let i = 0; i < existingThreadIds.length; i += chunkSize) {
      const chunk = existingThreadIds.slice(i, i + chunkSize);
      const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(", ");
      const threadRes = await db
        .prepare(`SELECT id, title FROM threads WHERE id IN (${placeholders})`)
        .bind(...chunk)
        .all<{ id: string; title: string }>();
      for (const row of threadRes.results ?? []) {
        threadTitleById.set(row.id, row.title);
      }
    }

    for (const spec of input.nodes) {
      const existing = existingByKey.get(spec.key);
      if (!existing) {
        throw new HubError(
          409,
          "IDEMPOTENCY_CONFLICT",
          `Idempotency-Key already used with different plan keys (missing '${spec.key}').`
        );
      }
      const resolved = resolvedByKey.get(spec.key)!;
      const expectedDepIds = [
        ...(topo.internalDepsByKey.get(spec.key) ?? []).map((k) => existingByKey.get(k)?.id ?? ""),
        ...(topo.externalDepsByKey.get(spec.key) ?? [])
      ];
      const actualDepIds = depsByRunId.get(existing.id) ?? [];

      let scheduleMatches = false;
      if (spec.inSec !== undefined) {
        if (existing.scheduled_at) {
          const deltaSec = (Date.parse(existing.scheduled_at) - Date.parse(existing.created_at)) / 1000;
          scheduleMatches = Math.abs(deltaSec - spec.inSec) <= 5;
        }
      } else {
        scheduleMatches = (existing.scheduled_at ?? null) === (spec.scheduledAt ?? null);
      }

      const depsEqual = await dependencySetsMatchWithRetryLineage(db, expectedDepIds, actualDepIds);
      const labelsEqual = deepEqualJson(parseRunLabelsJson(existing.labels_json), spec.labels);
      const schemaEqual = deepEqualJson(
        parseNullableJsonObject(existing.result_schema_json),
        spec.resultSchema ?? null
      );
      const expectedTitle = deriveThreadTitle(spec.title, spec.prompt);
      const actualTitle = threadTitleById.get(existing.thread_id);
      const titleMatches = actualTitle !== undefined && actualTitle === expectedTitle;
      const priorityMatches =
        spec.priorityOrder === undefined || Number(existing.priority_order) === spec.priorityOrder;
      if (
        existing.node_id !== spec.nodeId ||
        existing.workdir !== resolved.workdir ||
        existing.agent !== spec.agent ||
        existing.model !== spec.model ||
        existing.effort !== spec.effort ||
        (existing.sandbox === 1) !== spec.sandbox ||
        existing.timeout_sec !== spec.timeoutSec ||
        existing.prompt !== spec.prompt ||
        existing.notify_policy_json !== JSON.stringify(spec.notify) ||
        (existing.board_topic_id ?? null) !== (input.boardTopicId ?? null) ||
        (existing.actor_profile ?? "") !== input.actorProfile ||
        (existing.parent_run_id ?? null) !== (input.parentRunId ?? null) ||
        !scheduleMatches ||
        !depsEqual ||
        !labelsEqual ||
        !schemaEqual ||
        !priorityMatches ||
        !titleMatches
      ) {
        throw new HubError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key already used with different plan parameters."
        );
      }
    }

    const orderedRows = input.nodes.map((spec) => existingByKey.get(spec.key)!);
    const hydrated = await hydrateRunRecords(db, orderedRows, {
      view: "summary",
      tailBytes: 16384,
      promptMode: "preview",
      includeDeliveries: true
    });
    return {
      planId: seedRun.plan_id,
      runs: hydrated,
      queuedRunRows: [],
      deduplicated: true
    };
  };

  if (dbIdemKey) {
    const existing = await db
      .prepare(`SELECT * FROM runs WHERE idempotency_key = ?1 LIMIT 1`)
      .bind(dbIdemKey)
      .first<RunRow>();
    if (existing) {
      return checkExistingPlanIdempotency(existing);
    }
  }

  // 7. Atomic batch creation
  const planId = newId("pln");
  const now = new Date(nowMs).toISOString();
  const runIdByKey = new Map<string, string>();
  const threadIdByKey = new Map<string, string>();
  for (const spec of topo.ordered) {
    runIdByKey.set(spec.key, newId("run"));
    threadIdByKey.set(spec.key, newId("thr"));
  }

  const maxPriorityByNode = new Map<string, number>();
  for (const nodeId of nodeCache.keys()) {
    const priorityRow = await db
      .prepare(`SELECT COALESCE(MAX(priority_order), 0) AS max_p FROM runs WHERE node_id = ?1 AND status = 'queued'`)
      .bind(nodeId)
      .first<{ max_p: number }>();
    maxPriorityByNode.set(nodeId, priorityRow?.max_p ?? 0);
  }
  const nodeQueueOffset = new Map<string, number>();
  const statements: D1PreparedStatement[] = [];

  for (let i = 0; i < topo.ordered.length; i++) {
    const spec = topo.ordered[i]!;
    const runId = runIdByKey.get(spec.key)!;
    const threadId = threadIdByKey.get(spec.key)!;
    const resolved = resolvedByKey.get(spec.key)!;
    const rootRunId = parentRun ? parentRun.root_run_id : runId;
    const parentRunId = parentRun ? parentRun.id : null;
    const internalDeps = topo.internalDepsByKey.get(spec.key) ?? [];
    const externalDeps = topo.externalDepsByKey.get(spec.key) ?? [];

    const hasUnmetDeps =
      internalDeps.length > 0 ||
      externalDeps.some((extId) => externalRunById.get(extId)?.status !== "done");
    const scheduledAt = spec.scheduledAt ?? null;
    const isScheduledFuture = scheduledAt !== null && scheduledAt > now;
    const initialStatus: RunStatus = hasUnmetDeps || isScheduledFuture ? "waiting" : "queued";

    let priorityOrder = spec.priorityOrder;
    if (priorityOrder === undefined) {
      const offset = (nodeQueueOffset.get(spec.nodeId) ?? 0) + 1;
      nodeQueueOffset.set(spec.nodeId, offset);
      priorityOrder = (maxPriorityByNode.get(spec.nodeId) ?? 0) + offset * 100;
    }

    const derivedTitle = deriveThreadTitle(spec.title, spec.prompt);

    statements.push(
      db
        .prepare(
          `INSERT INTO threads (id, title, node_id, workdir, project_key, agent, native_session_id, status, pinned, sort_order, last_run_id, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'active', 0, 0, ?7, ?8, ?8)`
        )
        .bind(
          threadId,
          derivedTitle,
          spec.nodeId,
          resolved.workdir,
          resolved.projectKey,
          spec.agent,
          runId,
          now
        )
    );

    statements.push(
      db
        .prepare(
          `INSERT INTO runs (
             id, thread_id, root_run_id, parent_run_id, depth, max_depth,
             node_id, workdir, agent, model, effort, sandbox, timeout_sec, prompt,
             status, priority_order, idempotency_key, created_by_key_id,
             native_session_id, notify_policy_json, notify_status, created_at, updated_at,
             plan_id, plan_key, scheduled_at, retry_of_run_id, actor_profile, board_topic_id,
             labels_json, result_schema_json, result_json
           ) VALUES (
             ?1, ?2, ?3, ?4, ?5, ?6,
             ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
             ?15, ?16, ?17, ?18,
             NULL, ?19, 'none', ?20, ?20,
             ?21, ?22, ?23, NULL, ?24, ?25,
             ?26, ?27, NULL
           )`
        )
        .bind(
          runId,
          threadId,
          rootRunId,
          parentRunId,
          depth,
          maxDepth,
          spec.nodeId,
          resolved.workdir,
          spec.agent,
          spec.model,
          spec.effort,
          spec.sandbox ? 1 : 0,
          spec.timeoutSec,
          spec.prompt,
          initialStatus,
          priorityOrder,
          i === 0 ? dbIdemKey : null,
          principal.keyId,
          JSON.stringify(spec.notify),
          now,
          planId,
          spec.key,
          scheduledAt,
          input.actorProfile,
          input.boardTopicId ?? null,
          JSON.stringify(spec.labels),
          spec.resultSchema ? JSON.stringify(spec.resultSchema) : null
        )
    );
  }

  for (const spec of topo.ordered) {
    const runId = runIdByKey.get(spec.key)!;
    const depRunIds = [
      ...(topo.internalDepsByKey.get(spec.key) ?? []).map((k) => runIdByKey.get(k)!),
      ...(topo.externalDepsByKey.get(spec.key) ?? [])
    ];
    for (const depId of depRunIds) {
      statements.push(
        db
          .prepare(
            `INSERT INTO run_dependencies (run_id, depends_on_run_id, created_at)
             VALUES (?1, ?2, ?3)`
          )
          .bind(runId, depId, now)
      );
    }
  }

  try {
    await db.batch(statements);
  } catch (err) {
    if (dbIdemKey) {
      const raced = await db
        .prepare(`SELECT * FROM runs WHERE idempotency_key = ?1 LIMIT 1`)
        .bind(dbIdemKey)
        .first<RunRow>();
      if (raced) {
        return checkExistingPlanIdempotency(raced);
      }
    }
    throw err;
  }

  const createdRes = await db
    .prepare(`SELECT * FROM runs WHERE plan_id = ?1`)
    .bind(planId)
    .all<RunRow>();
  const createdByKey = new Map<string, RunRow>();
  for (const r of createdRes.results ?? []) {
    if (r.plan_key) createdByKey.set(r.plan_key, r);
  }
  const orderedCreatedRows = input.nodes.map((spec) => createdByKey.get(spec.key)!);
  const runs = await hydrateRunRecords(db, orderedCreatedRows, {
    view: "summary",
    tailBytes: 16384,
    promptMode: "preview",
    includeDeliveries: true
  });
  const queuedRunRows = orderedCreatedRows.filter((r) => r.status === "queued");

  return {
    planId,
    runs,
    queuedRunRows,
    deduplicated: false
  };
}

export async function retryRun(
  db: D1Database,
  _env: Env,
  principal: AuthPrincipal,
  runId: string,
  input: ParsedRetryRun,
  headerIdempotencyKey?: string,
  nowMs = Date.now()
): Promise<{
  run: RunRecord;
  newRunRow: RunRow;
  reboundRunIds: string[];
  reboundRuns: RunRecord[];
  deduplicated: boolean;
}> {
  if (headerIdempotencyKey !== undefined) {
    const hdrLen = codePointLength(headerIdempotencyKey);
    if (hdrLen < 8 || hdrLen > 128) {
      throw new HubError(400, "BAD_REQUEST", "Idempotency-Key header must have length 8..128.");
    }
  }

  const target = await db
    .prepare(`SELECT * FROM runs WHERE id = ?1 LIMIT 1`)
    .bind(runId)
    .first<RunRow>();
  if (!target) {
    throw new HubError(404, "NOT_FOUND", `Run '${runId}' not found.`);
  }
  ensureRunAccessible(principal, target);

  if (target.status !== "failed" && target.status !== "cancelled") {
    throw new HubError(
      409,
      "INVALID_STATE_TRANSITION",
      `Run '${runId}' is '${target.status}' and can only be retried from 'failed' or 'cancelled'.`
    );
  }

  const nodeRecord = await getNodeById(db, target.node_id);
  if (!nodeRecord) {
    throw new HubError(404, "NODE_NOT_FOUND", `Node '${target.node_id}' not found.`, undefined, [
      "ahub nodes --json"
    ]);
  }
  if (nodeRecord.status === "draining") {
    throw new HubError(409, "NODE_DRAINING", `Node '${target.node_id}' is draining.`);
  }

  const now = new Date(nowMs).toISOString();
  const nextModel = input.model !== undefined ? input.model : target.model;
  const nextEffort = input.effort !== undefined ? input.effort : target.effort;
  const nextTimeoutSec = input.timeoutSec !== undefined ? input.timeoutSec : target.timeout_sec;
  const nextActorProfile =
    input.actorProfile !== undefined ? input.actorProfile : (target.actor_profile ?? "");
  const nextScheduledAt =
    target.scheduled_at && target.scheduled_at > now ? target.scheduled_at : null;

  const effectiveIdemKey = input.idempotencyKey ?? headerIdempotencyKey;
  const dbIdemKey = effectiveIdemKey ? `retry:${effectiveIdemKey}` : null;

  const checkExistingRetryIdempotency = async (existing: RunRow) => {
    ensureRunAccessible(principal, existing);
    if (
      existing.retry_of_run_id !== runId ||
      existing.model !== nextModel ||
      existing.effort !== nextEffort ||
      existing.timeout_sec !== nextTimeoutSec ||
      (existing.actor_profile ?? "") !== nextActorProfile
    ) {
      throw new HubError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key already used with different retry parameters."
      );
    }
    const reboundRes = await db
      .prepare(
        `SELECT run_id FROM run_dependencies WHERE depends_on_run_id = ?1 ORDER BY created_at ASC, run_id ASC`
      )
      .bind(existing.id)
      .all<{ run_id: string }>();
    const reboundRunIds = (reboundRes.results ?? []).map((r) => r.run_id);
    const hydrated = await hydrateRunRecord(db, existing, {
      view: "summary",
      tailBytes: 16384,
      promptMode: "preview",
      includeDeliveries: true
    });
    return {
      run: hydrated,
      newRunRow: existing,
      reboundRunIds,
      reboundRuns: [],
      deduplicated: true
    };
  };

  if (dbIdemKey) {
    const existing = await db
      .prepare(`SELECT * FROM runs WHERE idempotency_key = ?1 LIMIT 1`)
      .bind(dbIdemKey)
      .first<RunRow>();
    if (existing) {
      return checkExistingRetryIdempotency(existing);
    }
  }

  const upstreamRes = await db
    .prepare(
      `SELECT d.depends_on_run_id, up.status AS upstream_status
       FROM run_dependencies d
       LEFT JOIN runs up ON up.id = d.depends_on_run_id
       WHERE d.run_id = ?1
       ORDER BY d.created_at ASC, d.depends_on_run_id ASC`
    )
    .bind(runId)
    .all<{ depends_on_run_id: string; upstream_status: RunStatus | null }>();
  const upstreamDeps = upstreamRes.results ?? [];
  const hasUnmetDeps = upstreamDeps.some((d) => d.upstream_status !== "done");
  const initialStatus: RunStatus =
    hasUnmetDeps || nextScheduledAt !== null ? "waiting" : "queued";

  const newRunId = newId("run");
  const rootRunId = target.parent_run_id ? target.root_run_id : newRunId;
  const priorityRow = await db
    .prepare(`SELECT COALESCE(MAX(priority_order), 0) AS max_p FROM runs WHERE node_id = ?1 AND status = 'queued'`)
    .bind(target.node_id)
    .first<{ max_p: number }>();
  const nextPriority = (priorityRow?.max_p ?? 0) + 100;

  const statements: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE threads SET last_run_id = ?1, updated_at = ?2 WHERE id = ?3`)
      .bind(newRunId, now, target.thread_id),
    db
      .prepare(
        `INSERT INTO runs (
           id, thread_id, root_run_id, parent_run_id, depth, max_depth,
           node_id, workdir, agent, model, effort, sandbox, timeout_sec, prompt,
           status, priority_order, idempotency_key, created_by_key_id,
           native_session_id, notify_policy_json, notify_status, created_at, updated_at,
           plan_id, plan_key, scheduled_at, retry_of_run_id, actor_profile, board_topic_id,
           labels_json, result_schema_json, result_json
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6,
           ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
           ?15, ?16, ?17, ?18,
           ?19, ?20, 'none', ?21, ?21,
           ?22, ?23, ?24, ?25, ?26, ?27,
           ?28, ?29, NULL
         )`
      )
      .bind(
        newRunId,
        target.thread_id,
        rootRunId,
        target.parent_run_id,
        target.depth,
        target.max_depth,
        target.node_id,
        target.workdir,
        target.agent,
        nextModel,
        nextEffort,
        target.sandbox,
        nextTimeoutSec,
        target.prompt,
        initialStatus,
        nextPriority,
        dbIdemKey,
        principal.keyId ?? target.created_by_key_id,
        target.native_session_id,
        target.notify_policy_json,
        now,
        target.plan_id ?? null,
        target.plan_key ?? null,
        nextScheduledAt,
        runId,
        nextActorProfile,
        target.board_topic_id ?? null,
        target.labels_json ?? "{}",
        target.result_schema_json ?? null
      )
  ];

  for (const dep of upstreamDeps) {
    statements.push(
      db
        .prepare(
          `INSERT INTO run_dependencies (run_id, depends_on_run_id, created_at)
           VALUES (?1, ?2, ?3)`
        )
        .bind(newRunId, dep.depends_on_run_id, now)
    );
  }

  statements.push(
    db
      .prepare(
        `UPDATE run_dependencies
         SET depends_on_run_id = ?1
         WHERE depends_on_run_id = ?2
           AND run_id IN (SELECT id FROM runs WHERE status = 'waiting')`
      )
      .bind(newRunId, runId)
  );

  try {
    await db.batch(statements);
  } catch (err) {
    if (dbIdemKey) {
      const raced = await db
        .prepare(`SELECT * FROM runs WHERE idempotency_key = ?1 LIMIT 1`)
        .bind(dbIdemKey)
        .first<RunRow>();
      if (raced) {
        return checkExistingRetryIdempotency(raced);
      }
    }
    throw err;
  }

  const [newRunRow, reboundRowsRes] = await Promise.all([
    db.prepare(`SELECT * FROM runs WHERE id = ?1`).bind(newRunId).first<RunRow>(),
    db
      .prepare(
        `SELECT r.*
         FROM run_dependencies d
         JOIN runs r ON r.id = d.run_id
         WHERE d.depends_on_run_id = ?1
         ORDER BY d.created_at ASC, r.id ASC`
      )
      .bind(newRunId)
      .all<RunRow>()
  ]);

  const reboundRows = reboundRowsRes.results ?? [];
  const [hydratedRun, reboundRuns] = await Promise.all([
    hydrateRunRecord(db, newRunRow!, {
      view: "summary",
      tailBytes: 16384,
      promptMode: "preview",
      includeDeliveries: true
    }),
    hydrateRunRecords(db, reboundRows, {
      view: "summary",
      tailBytes: 16384,
      promptMode: "preview",
      includeDeliveries: true
    })
  ]);

  return {
    run: hydratedRun,
    newRunRow: newRunRow!,
    reboundRunIds: reboundRows.map((r) => r.id),
    reboundRuns,
    deduplicated: false
  };
}
