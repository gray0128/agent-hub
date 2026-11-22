import {
  buildBoardPrefixNextHints,
  ensureBoardChannelAllowed,
  ensureBoardReadAllowed,
  isBoardChannelAllowed,
  requireScope,
  sanitizeNextHints
} from "./auth";
import {
  getDeliveriesSummaryMap,
  getNodeById,
  listMatchingWebPushSubscriptions,
  parseJsonObject,
  parseStringArray,
  recomputeSourceNotifyStatus
} from "./db";
import { redactBoardData, redactSecrets } from "./redact";
import {
  type AuthPrincipal,
  type BoardChannelSummary,
  type BoardEvent,
  type BoardEventType,
  type BoardHandoffSnapshot,
  type BoardMessage,
  type BoardMessageKind,
  type BoardPreviousStatus,
  type BoardQuestionState,
  type BoardTopic,
  type BoardTopicStatus,
  type DeliveriesSummary,
  type Env,
  HubError
} from "./types";
import { newId, nowIso } from "./ulid";
import {
  BOARD_CHANNEL_RE,
  BOARD_MESSAGE_ID_RE,
  BOARD_TOPIC_ID_RE,
  codePointLength,
  DEFAULT_NODE_NOTIFY_EVENTS,
  type ParsedAnswerBoardQuestion,
  type ParsedCreateBoardMessage,
  type ParsedCreateBoardTopic,
  type ParsedListBoardTopicsQuery,
  type ParsedPatchBoardTopic,
  type ParsedReorderBoardTopics,
  utf8ByteLength
} from "./validation";

export interface BoardTopicRow {
  id: string;
  channel: string;
  title: string;
  external_ref: string;
  status: BoardTopicStatus;
  previous_status: BoardPreviousStatus;
  pinned: number;
  sort_order: number;
  labels_json: string;
  created_by_key_id: string | null;
  last_message_id: string;
  last_handoff_message_id: string;
  last_event_cursor: number;
  created_at: string;
  updated_at: string;
}

export interface BoardMessageRow {
  id: string;
  topic_id: string;
  channel: string;
  seq: number;
  kind: BoardMessageKind;
  reply_to_id: string | null;
  actor_scope: "admin" | "client";
  actor_key_id: string | null;
  actor_profile: string;
  source_node: string;
  text_md: string;
  data_json: string;
  idempotency_key: string | null;
  question_state: BoardQuestionState;
  question_options_json: string;
  question_expires_at: string | null;
  answered_message_id: string | null;
  answered_at: string | null;
  created_at: string;
}

export interface BoardEventRow {
  cursor: number;
  channel: string;
  topic_id: string;
  message_id: string | null;
  event_type: BoardEventType;
  actor_profile: string;
  created_at: string;
}

const SAFE_EXTERNAL_REF_RE = /^[A-Za-z0-9._:#/-]{1,200}$/;

function parseBoardLabelsJson(raw: string): Record<string, string> {
  const obj = parseJsonObject(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      out[k] = v;
    }
  }
  return out;
}

function buildSafeReadChannelNext(channel: string, externalRef?: string): string[] {
  if (!BOARD_CHANNEL_RE.test(channel)) return [];
  if (
    externalRef &&
    SAFE_EXTERNAL_REF_RE.test(externalRef) &&
    redactSecrets(externalRef) === externalRef
  ) {
    return sanitizeNextHints([`ahub board read ${channel} --ref ${externalRef} --json`]);
  }
  return sanitizeNextHints([`ahub board read ${channel} --json`]);
}

function buildSafeReadTopicNext(channel: string, topicId: string): string[] {
  if (!BOARD_CHANNEL_RE.test(channel)) return [];
  if (BOARD_TOPIC_ID_RE.test(topicId)) {
    return sanitizeNextHints([`ahub board read ${topicId} --json`, `ahub board read ${channel} --json`]);
  }
  return sanitizeNextHints([`ahub board read ${channel} --json`]);
}

function buildClientPrefixSqlFilter(
  principal: AuthPrincipal,
  columnExpr: string,
  binds: unknown[]
): string | null {
  if (principal.scope === "admin") return null;
  const prefixes = principal.allowedBoardPrefixes ?? [];
  if (prefixes.includes("*")) return null;
  if (prefixes.length === 0) {
    return "1 = 0";
  }
  const clauses: string[] = [];
  for (const prefix of prefixes) {
    binds.push(prefix);
    const p = `?${binds.length}`;
    clauses.push(
      `(${columnExpr} = ${p} OR (length(${columnExpr}) > length(${p}) AND substr(${columnExpr}, 1, length(${p}) + 1) = (${p} || '/')))`
    );
  }
  return `(${clauses.join(" OR ")})`;
}

export function mapBoardMessageRow(
  row: BoardMessageRow,
  deliveriesSummary?: DeliveriesSummary
): BoardMessage {
  const msg: BoardMessage = {
    id: row.id,
    topic_id: row.topic_id,
    channel: row.channel,
    seq: Number(row.seq),
    kind: row.kind,
    reply_to_id: row.reply_to_id ?? null,
    actor_scope: row.actor_scope,
    actor_key_id: row.actor_key_id ?? null,
    actor_profile: row.actor_profile ?? "",
    source_node: row.source_node ?? "",
    text_md: row.text_md,
    data: parseJsonObject(row.data_json),
    question_state: row.question_state ?? "",
    question_options: parseStringArray(row.question_options_json),
    question_expires_at: row.question_expires_at ?? null,
    answered_message_id: row.answered_message_id ?? null,
    answered_at: row.answered_at ?? null,
    created_at: row.created_at
  };
  if (deliveriesSummary !== undefined) {
    msg.deliveries_summary = deliveriesSummary;
  }
  return msg;
}

export function mapBoardEventRow(row: BoardEventRow): BoardEvent {
  return {
    cursor: Number(row.cursor),
    channel: row.channel,
    topic_id: row.topic_id,
    message_id: row.message_id ?? null,
    event_type: row.event_type,
    actor_profile: row.actor_profile ?? "",
    created_at: row.created_at
  };
}

export function mapBoardTopicRow(
  row: BoardTopicRow,
  extras?: {
    openQuestionCount?: number;
    messageCount?: number;
    latestHandoff?: BoardHandoffSnapshot | null;
  }
): BoardTopic {
  const topic: BoardTopic = {
    id: row.id,
    channel: row.channel,
    title: row.title,
    external_ref: row.external_ref ?? "",
    status: row.status,
    previous_status: row.previous_status ?? "",
    pinned: row.pinned === 1,
    sort_order: Number(row.sort_order ?? 0),
    labels: parseBoardLabelsJson(row.labels_json),
    created_by_key_id: row.created_by_key_id ?? null,
    last_message_id: row.last_message_id ?? "",
    last_handoff_message_id: row.last_handoff_message_id ?? "",
    last_event_cursor: Number(row.last_event_cursor ?? 0),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  if (extras?.openQuestionCount !== undefined) {
    topic.open_question_count = extras.openQuestionCount;
  }
  if (extras?.messageCount !== undefined) {
    topic.message_count = extras.messageCount;
  }
  if (extras?.latestHandoff !== undefined) {
    topic.latest_handoff = extras.latestHandoff;
  }
  return topic;
}

export async function hydrateBoardTopics(
  db: D1Database,
  rows: BoardTopicRow[]
): Promise<BoardTopic[]> {
  if (rows.length === 0) return [];
  const topicIds = rows.map((r) => r.id);
  const openCountMap = new Map<string, number>();
  const msgCountMap = new Map<string, number>();
  const handoffIds = Array.from(
    new Set(rows.map((r) => r.last_handoff_message_id).filter((id) => Boolean(id)))
  );
  const handoffMap = new Map<string, BoardHandoffSnapshot>();

  const chunkSize = 50;
  for (let i = 0; i < topicIds.length; i += chunkSize) {
    const chunk = topicIds.slice(i, i + chunkSize);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(", ");
    const statsRes = await db
      .prepare(
        `SELECT topic_id,
                COUNT(*) AS message_count,
                COALESCE(SUM(CASE WHEN kind = 'question' AND question_state = 'open' THEN 1 ELSE 0 END), 0) AS open_question_count
         FROM board_messages
         WHERE topic_id IN (${placeholders})
         GROUP BY topic_id`
      )
      .bind(...chunk)
      .all<{ topic_id: string; message_count: number; open_question_count: number }>();
    for (const s of statsRes.results ?? []) {
      msgCountMap.set(s.topic_id, Number(s.message_count ?? 0));
      openCountMap.set(s.topic_id, Number(s.open_question_count ?? 0));
    }
  }

  for (let i = 0; i < handoffIds.length; i += chunkSize) {
    const chunk = handoffIds.slice(i, i + chunkSize);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(", ");
    const handoffRes = await db
      .prepare(
        `SELECT id, actor_profile, source_node, text_md, data_json, created_at
         FROM board_messages
         WHERE id IN (${placeholders})`
      )
      .bind(...chunk)
      .all<{
        id: string;
        actor_profile: string;
        source_node: string;
        text_md: string;
        data_json: string;
        created_at: string;
      }>();
    for (const h of handoffRes.results ?? []) {
      handoffMap.set(h.id, {
        id: h.id,
        actor_profile: h.actor_profile ?? "",
        source_node: h.source_node ?? "",
        text_md: h.text_md,
        data: parseJsonObject(h.data_json),
        created_at: h.created_at
      });
    }
  }

  return rows.map((row) =>
    mapBoardTopicRow(row, {
      openQuestionCount: openCountMap.get(row.id) ?? 0,
      messageCount: msgCountMap.get(row.id) ?? 0,
      latestHandoff: row.last_handoff_message_id
        ? (handoffMap.get(row.last_handoff_message_id) ?? null)
        : null
    })
  );
}

export async function hydrateBoardTopic(db: D1Database, row: BoardTopicRow): Promise<BoardTopic> {
  const [hydrated] = await hydrateBoardTopics(db, [row]);
  return hydrated!;
}

export async function countOpenBoardQuestions(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM board_messages
       WHERE kind = 'question' AND question_state = 'open'`
    )
    .first<{ cnt: number }>();
  return Number(row?.cnt ?? 0);
}

export async function listBoardChannels(
  db: D1Database,
  principal: AuthPrincipal
): Promise<BoardChannelSummary[]> {
  ensureBoardReadAllowed(principal);

  const binds: unknown[] = [];
  const prefixWhere = buildClientPrefixSqlFilter(principal, "t.channel", binds);
  const sql = `SELECT t.channel,
                      COALESCE(SUM(CASE WHEN t.status != 'archived' THEN 1 ELSE 0 END), 0) AS active_topic_count,
                      COUNT(*) AS total_topic_count,
                      MAX(t.updated_at) AS updated_at,
                      COALESCE((
                        SELECT COUNT(*)
                        FROM board_messages m
                        WHERE m.channel = t.channel
                          AND m.kind = 'question'
                          AND m.question_state = 'open'
                      ), 0) AS open_question_count
               FROM board_topics t
               ${prefixWhere ? `WHERE ${prefixWhere}` : ""}
               GROUP BY t.channel
               ORDER BY updated_at DESC, t.channel ASC`;

  const res = await db.prepare(sql).bind(...binds).all<{
    channel: string;
    active_topic_count: number;
    total_topic_count: number;
    updated_at: string | null;
    open_question_count: number;
  }>();

  return (res.results ?? [])
    .filter((r) => isBoardChannelAllowed(principal, r.channel))
    .map((r) => ({
      channel: r.channel,
      active_topic_count: Number(r.active_topic_count ?? 0),
      open_question_count: Number(r.open_question_count ?? 0),
      total_topic_count: Number(r.total_topic_count ?? 0),
      updated_at: r.updated_at ?? null
    }));
}

export async function listBoardTopics(
  db: D1Database,
  principal: AuthPrincipal,
  query: ParsedListBoardTopicsQuery
): Promise<BoardTopic[]> {
  if (query.channel) {
    ensureBoardChannelAllowed(principal, query.channel);
  } else {
    ensureBoardReadAllowed(principal);
  }

  const where: string[] = [];
  const binds: unknown[] = [];
  const prefixWhere = buildClientPrefixSqlFilter(principal, "t.channel", binds);
  if (prefixWhere) {
    where.push(prefixWhere);
  }
  if (query.channel) {
    binds.push(query.channel);
    where.push(`t.channel = ?${binds.length}`);
  }
  if (query.externalRef) {
    binds.push(query.externalRef);
    where.push(`t.external_ref = ?${binds.length}`);
  }
  if (query.status) {
    binds.push(query.status);
    where.push(`t.status = ?${binds.length}`);
  }
  if (query.hasOpenQuestion !== undefined) {
    if (query.hasOpenQuestion) {
      where.push(
        `EXISTS (SELECT 1 FROM board_messages m WHERE m.topic_id = t.id AND m.kind = 'question' AND m.question_state = 'open')`
      );
    } else {
      where.push(
        `NOT EXISTS (SELECT 1 FROM board_messages m WHERE m.topic_id = t.id AND m.kind = 'question' AND m.question_state = 'open')`
      );
    }
  }
  if (query.q) {
    binds.push(`%${query.q}%`);
    const p = `?${binds.length}`;
    where.push(`(t.title LIKE ${p} OR t.external_ref LIKE ${p} OR t.channel LIKE ${p})`);
  }

  binds.push(query.limit);
  const orderBy =
    query.sort === "order"
      ? `t.pinned DESC, t.sort_order ASC, t.updated_at DESC, t.id ASC`
      : `t.pinned DESC, t.updated_at DESC, t.id DESC`;

  const sql = `SELECT t.*
               FROM board_topics t
               ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY ${orderBy}
               LIMIT ?${binds.length}`;

  const res = await db.prepare(sql).bind(...binds).all<BoardTopicRow>();
  const rows = (res.results ?? []).filter((r) => isBoardChannelAllowed(principal, r.channel));
  return hydrateBoardTopics(db, rows);
}

export async function getBoardTopicById(
  db: D1Database,
  principal: AuthPrincipal,
  topicId: string
): Promise<BoardTopic> {
  ensureBoardReadAllowed(principal);
  if (!BOARD_TOPIC_ID_RE.test(topicId)) {
    throw new HubError(404, "NOT_FOUND", `Board topic '${topicId}' not found.`);
  }
  const row = await db
    .prepare(`SELECT * FROM board_topics WHERE id = ?1 LIMIT 1`)
    .bind(topicId)
    .first<BoardTopicRow>();
  if (!row) {
    throw new HubError(404, "NOT_FOUND", `Board topic '${topicId}' not found.`);
  }
  ensureBoardChannelAllowed(principal, row.channel);
  return hydrateBoardTopic(db, row);
}

function sanitizeLabels(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    const clean = redactSecrets(v);
    if (codePointLength(clean) > 128) {
      throw new HubError(400, "BAD_REQUEST", `Label '${k}' exceeds max length 128 after redaction.`);
    }
    out[k] = clean;
  }
  return out;
}

export async function createOrUpsertBoardTopic(
  db: D1Database,
  principal: AuthPrincipal,
  input: ParsedCreateBoardTopic
): Promise<{ topic: BoardTopic; created: boolean }> {
  ensureBoardChannelAllowed(principal, input.channel);

  const sanitizedTitle = redactSecrets(input.title).trim();
  if (codePointLength(sanitizedTitle) < 1 || codePointLength(sanitizedTitle) > 200) {
    throw new HubError(400, "BAD_REQUEST", "Field 'title' must have 1..200 characters.");
  }
  const sanitizedLabels = sanitizeLabels(input.labels);

  if (input.externalRef !== "") {
    const existing = await db
      .prepare(`SELECT * FROM board_topics WHERE channel = ?1 AND external_ref = ?2 LIMIT 1`)
      .bind(input.channel, input.externalRef)
      .first<BoardTopicRow>();
    if (existing) {
      if (input.upsert) {
        return { topic: await hydrateBoardTopic(db, existing), created: false };
      }
      throw new HubError(
        409,
        "INVALID_STATE_TRANSITION",
        `Topic with external_ref '${redactSecrets(input.externalRef)}' already exists in channel '${input.channel}'.`,
        { topic_id: existing.id },
        buildSafeReadChannelNext(input.channel, input.externalRef)
      );
    }
  }

  const now = nowIso();
  const topicId = newId("top");
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO board_topics (
             id, channel, title, external_ref, status, previous_status,
             pinned, sort_order, labels_json, created_by_key_id,
             last_message_id, last_handoff_message_id, last_event_cursor, created_at, updated_at
           ) VALUES (
             ?1, ?2, ?3, ?4, ?5, '',
             ?6, 0, ?7, ?8,
             '', '', 0, ?9, ?9
           )`
        )
        .bind(
          topicId,
          input.channel,
          sanitizedTitle,
          input.externalRef,
          input.status,
          input.pinned ? 1 : 0,
          JSON.stringify(sanitizedLabels),
          principal.keyId,
          now
        ),
      db
        .prepare(
          `INSERT INTO board_events (channel, topic_id, message_id, event_type, actor_profile, created_at)
           VALUES (?1, ?2, NULL, 'topic.created', '', ?3)`
        )
        .bind(input.channel, topicId, now),
      db
        .prepare(
          `UPDATE board_topics
           SET last_event_cursor = last_insert_rowid()
           WHERE id = ?1`
        )
        .bind(topicId)
    ]);
  } catch (err) {
    if (input.externalRef !== "") {
      const raced = await db
        .prepare(`SELECT * FROM board_topics WHERE channel = ?1 AND external_ref = ?2 LIMIT 1`)
        .bind(input.channel, input.externalRef)
        .first<BoardTopicRow>();
      if (raced) {
        if (input.upsert) {
          return { topic: await hydrateBoardTopic(db, raced), created: false };
        }
        throw new HubError(
          409,
          "INVALID_STATE_TRANSITION",
          `Topic with external_ref '${redactSecrets(input.externalRef)}' already exists in channel '${input.channel}'.`,
          { topic_id: raced.id },
          buildSafeReadChannelNext(input.channel, input.externalRef)
        );
      }
    }
    throw err;
  }

  const createdRow = await db
    .prepare(`SELECT * FROM board_topics WHERE id = ?1 LIMIT 1`)
    .bind(topicId)
    .first<BoardTopicRow>();
  return { topic: await hydrateBoardTopic(db, createdRow!), created: true };
}

export async function patchBoardTopic(
  db: D1Database,
  principal: AuthPrincipal,
  topicId: string,
  patch: ParsedPatchBoardTopic
): Promise<BoardTopic> {
  ensureBoardReadAllowed(principal);
  if (!BOARD_TOPIC_ID_RE.test(topicId)) {
    throw new HubError(404, "NOT_FOUND", `Board topic '${topicId}' not found.`);
  }
  const existing = await db
    .prepare(`SELECT * FROM board_topics WHERE id = ?1 LIMIT 1`)
    .bind(topicId)
    .first<BoardTopicRow>();
  if (!existing) {
    throw new HubError(404, "NOT_FOUND", `Board topic '${topicId}' not found.`);
  }
  ensureBoardChannelAllowed(principal, existing.channel);

  let nextTitle = existing.title;
  if (patch.title !== undefined) {
    nextTitle = redactSecrets(patch.title).trim();
    if (codePointLength(nextTitle) < 1 || codePointLength(nextTitle) > 200) {
      throw new HubError(400, "BAD_REQUEST", "Field 'title' must have 1..200 characters.");
    }
  }

  let nextStatus = existing.status;
  let nextPreviousStatus: BoardPreviousStatus = existing.previous_status;
  if (patch.status !== undefined) {
    nextStatus = patch.status;
    if (patch.status === "blocked") {
      if (existing.status === "todo" || existing.status === "in_progress") {
        nextPreviousStatus = existing.status;
      } else if (existing.status !== "blocked") {
        nextPreviousStatus = "";
      }
    } else {
      nextPreviousStatus = "";
    }
  }

  const nextPinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : existing.pinned;
  const nextSortOrder = patch.sortOrder !== undefined ? patch.sortOrder : existing.sort_order;
  const nextLabelsJson =
    patch.labels !== undefined ? JSON.stringify(sanitizeLabels(patch.labels)) : existing.labels_json;
  const now = nowIso();

  await db.batch([
    db
      .prepare(
        `UPDATE board_topics
         SET title = ?1, status = ?2, previous_status = ?3, pinned = ?4, sort_order = ?5, labels_json = ?6, updated_at = ?7
         WHERE id = ?8`
      )
      .bind(
        nextTitle,
        nextStatus,
        nextPreviousStatus,
        nextPinned,
        nextSortOrder,
        nextLabelsJson,
        now,
        topicId
      ),
    db
      .prepare(
        `INSERT INTO board_events (channel, topic_id, message_id, event_type, actor_profile, created_at)
         VALUES (?1, ?2, NULL, 'topic.updated', '', ?3)`
      )
      .bind(existing.channel, topicId, now),
    db
      .prepare(
        `UPDATE board_topics
         SET last_event_cursor = last_insert_rowid()
         WHERE id = ?1`
      )
      .bind(topicId)
  ]);

  const updated = await db
    .prepare(`SELECT * FROM board_topics WHERE id = ?1 LIMIT 1`)
    .bind(topicId)
    .first<BoardTopicRow>();
  return hydrateBoardTopic(db, updated!);
}

export async function reorderBoardTopics(
  db: D1Database,
  principal: AuthPrincipal,
  input: ParsedReorderBoardTopics
): Promise<BoardTopic[]> {
  ensureBoardChannelAllowed(principal, input.channel);

  const existingById = new Map<string, BoardTopicRow>();
  const chunkSize = 50;
  for (let i = 0; i < input.orderedTopicIds.length; i += chunkSize) {
    const chunk = input.orderedTopicIds.slice(i, i + chunkSize);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(", ");
    const res = await db
      .prepare(`SELECT * FROM board_topics WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<BoardTopicRow>();
    for (const row of res.results ?? []) {
      existingById.set(row.id, row);
    }
  }

  for (const tid of input.orderedTopicIds) {
    const row = existingById.get(tid);
    if (!row) {
      throw new HubError(404, "NOT_FOUND", `Board topic '${tid}' not found.`);
    }
    if (row.channel !== input.channel) {
      throw new HubError(
        409,
        "INVALID_STATE_TRANSITION",
        `Topic '${tid}' belongs to channel '${row.channel}', expected '${input.channel}'.`,
        undefined,
        buildSafeReadChannelNext(input.channel)
      );
    }
  }

  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < input.orderedTopicIds.length; i++) {
    const tid = input.orderedTopicIds[i]!;
    const existing = existingById.get(tid)!;
    const nextSortOrder = (i + 1) * 100;
    let nextPreviousStatus: BoardPreviousStatus = existing.previous_status;
    if (input.status === "blocked") {
      if (existing.status === "todo" || existing.status === "in_progress") {
        nextPreviousStatus = existing.status;
      } else if (existing.status !== "blocked") {
        nextPreviousStatus = "";
      }
    } else {
      nextPreviousStatus = "";
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO board_events (channel, topic_id, message_id, event_type, actor_profile, created_at)
           VALUES (?1, ?2, NULL, 'topic.updated', '', ?3)`
        )
        .bind(input.channel, tid, now),
      db
        .prepare(
          `UPDATE board_topics
           SET status = ?1, previous_status = ?2, sort_order = ?3, last_event_cursor = last_insert_rowid(), updated_at = ?4
           WHERE id = ?5`
        )
        .bind(input.status, nextPreviousStatus, nextSortOrder, now, tid)
    );
  }
  await db.batch(stmts);

  const refreshedRows: BoardTopicRow[] = [];
  for (let i = 0; i < input.orderedTopicIds.length; i += chunkSize) {
    const chunk = input.orderedTopicIds.slice(i, i + chunkSize);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(", ");
    const res = await db
      .prepare(`SELECT * FROM board_topics WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<BoardTopicRow>();
    for (const row of res.results ?? []) {
      refreshedRows.push(row);
    }
  }
  const byId = new Map(refreshedRows.map((r) => [r.id, r]));
  const orderedRows = input.orderedTopicIds.map((id) => byId.get(id)!).filter(Boolean);
  return hydrateBoardTopics(db, orderedRows);
}

export async function listBoardTopicMessages(
  db: D1Database,
  principal: AuthPrincipal,
  topicId: string,
  query: { afterSeq: number; limit: number }
): Promise<{ topic: BoardTopic; messages: BoardMessage[]; cursor: number }> {
  const topic = await getBoardTopicById(db, principal, topicId);

  const res = await db
    .prepare(
      `SELECT * FROM board_messages
       WHERE topic_id = ?1 AND seq > ?2
       ORDER BY seq ASC
       LIMIT ?3`
    )
    .bind(topicId, query.afterSeq, query.limit)
    .all<BoardMessageRow>();

  const rows = res.results ?? [];
  const questionIds = rows.filter((r) => r.kind === "question").map((r) => r.id);
  const summaryMap = await getDeliveriesSummaryMap(db, "board_message", questionIds);
  const messages = rows.map((r) => mapBoardMessageRow(r, summaryMap.get(r.id)));
  return {
    topic,
    messages,
    cursor: topic.last_event_cursor
  };
}

async function enqueueBoardQuestionNotification(
  db: D1Database,
  env: Env,
  message: BoardMessage,
  topic: BoardTopic
): Promise<boolean> {
  const candidates: Array<{
    channelKind: "bot_webhook" | "web_push";
    channelId: string;
    channelLabel: string;
    targetHost: string;
    routeMode: "node_default" | "web_push";
  }> = [];

  if (message.source_node !== "") {
    const node = await getNodeById(db, message.source_node);
    if (node?.default_notify_key_id && node.default_notify_valid) {
      const botEvents = node.default_notify_events ?? DEFAULT_NODE_NOTIFY_EVENTS;
      if (botEvents.includes("board_question_opened")) {
        candidates.push({
          channelKind: "bot_webhook",
          channelId: node.default_notify_key_id,
          channelLabel: node.default_notify_key_name || node.default_notify_key_id,
          targetHost: node.default_notify_webhook_host || "",
          routeMode: "node_default"
        });
      }
    }
  }

  // Pass null when source_node is empty so ONLY subscriptions with node_filter_json === [] match
  // (never pass fallback "board" into listMatchingWebPushSubscriptions).
  const pushSubs = await listMatchingWebPushSubscriptions(
    db,
    message.source_node !== "" ? message.source_node : null,
    "board_question_opened"
  );
  for (const sub of pushSubs) {
    candidates.push({
      channelKind: "web_push",
      channelId: sub.id,
      channelLabel: sub.label,
      targetHost: sub.endpoint_host,
      routeMode: "web_push"
    });
  }

  if (candidates.length === 0) {
    return false;
  }

  const now = nowIso();
  const deliveryNodeId = message.source_node || "board";
  let enqueuedAny = false;
  for (const cand of candidates) {
    const dlvId = newId("dlv");
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO notification_deliveries (
           id, source_kind, source_id, trigger_event, node_id,
           channel_kind, channel_id, channel_label, target_host, route_mode,
           status, attempts, http_status, error_code, error_message, sent_at, created_at, updated_at
         ) VALUES (
           ?1, 'board_message', ?2, 'question_opened', ?3,
           ?4, ?5, ?6, ?7, ?8,
           'queued', 0, NULL, '', '', NULL, ?9, ?9
         )`
      )
      .bind(
        dlvId,
        message.id,
        deliveryNodeId,
        cand.channelKind,
        cand.channelId,
        cand.channelLabel,
        cand.targetHost,
        cand.routeMode,
        now
      )
      .run();
    if ((res.meta.changes ?? 0) === 1) {
      await env.NOTIFY_QUEUE.send({ kind: "delivery", delivery_id: dlvId });
      enqueuedAny = true;
    }
  }

  // Verify topic reference isn't unused and deliveries_summary stays consistent
  void topic;
  await recomputeSourceNotifyStatus(db, "board_message", message.id);
  return enqueuedAny;
}

export async function postBoardMessage(
  db: D1Database,
  env: Env,
  principal: AuthPrincipal,
  topicId: string,
  input: ParsedCreateBoardMessage,
  headerIdempotencyKey?: string
): Promise<{
  topic: BoardTopic;
  message: BoardMessage;
  cursor: number;
  deduplicated: boolean;
  statusChanged: boolean;
  openBoardQuestionCount: number;
}> {
  ensureBoardReadAllowed(principal);
  if (!BOARD_TOPIC_ID_RE.test(topicId)) {
    throw new HubError(404, "NOT_FOUND", `Board topic '${topicId}' not found.`);
  }

  if (headerIdempotencyKey !== undefined) {
    const hdrLen = codePointLength(headerIdempotencyKey);
    if (hdrLen < 8 || hdrLen > 128) {
      throw new HubError(400, "BAD_REQUEST", "Idempotency-Key header must have length 8..128.");
    }
  }

  const existingTopic = await db
    .prepare(`SELECT * FROM board_topics WHERE id = ?1 LIMIT 1`)
    .bind(topicId)
    .first<BoardTopicRow>();
  if (!existingTopic) {
    throw new HubError(404, "NOT_FOUND", `Board topic '${topicId}' not found.`);
  }
  ensureBoardChannelAllowed(principal, existingTopic.channel);

  const redactedTextMd = redactSecrets(input.textMd);
  if (codePointLength(redactedTextMd) < 1 || codePointLength(redactedTextMd) > 8192) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      "Field 'text_md' must have 1..8192 characters after redaction."
    );
  }
  const redactedData = redactBoardData(input.data);
  const redactedDataJson = JSON.stringify(redactedData);
  if (utf8ByteLength(redactedDataJson) > 32768) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      "Field 'data' exceeds max size 32768 UTF-8 bytes after redaction."
    );
  }

  const isQuestion = input.kind === "question";
  const redactedOptions = isQuestion
    ? input.questionOptions.map((opt) => {
        const clean = redactSecrets(opt);
        const len = codePointLength(clean);
        if (len < 1 || len > 200) {
          throw new HubError(
            400,
            "BAD_REQUEST",
            "Each question_options item must have 1..200 characters after redaction."
          );
        }
        return clean;
      })
    : [];
  const redactedOptionsJson = JSON.stringify(redactedOptions);
  const effectiveIdemKey = input.idempotencyKey ?? headerIdempotencyKey ?? null;

  const checkIdempotencyRow = async (row: BoardMessageRow) => {
    if (
      row.topic_id !== topicId ||
      row.kind !== input.kind ||
      row.text_md !== redactedTextMd ||
      row.data_json !== redactedDataJson ||
      row.question_options_json !== redactedOptionsJson
    ) {
      throw new HubError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key already used with different board message parameters.",
        undefined,
        buildSafeReadTopicNext(existingTopic.channel, topicId)
      );
    }
    const hydratedTopic = await hydrateBoardTopic(db, existingTopic);
    const summaryMap = await getDeliveriesSummaryMap(db, "board_message", [row.id]);
    const openCount = await countOpenBoardQuestions(db);
    return {
      topic: hydratedTopic,
      message: mapBoardMessageRow(row, summaryMap.get(row.id)),
      cursor: hydratedTopic.last_event_cursor,
      deduplicated: true,
      statusChanged: false,
      openBoardQuestionCount: openCount
    };
  };

  if (effectiveIdemKey) {
    const existingMsg = await db
      .prepare(`SELECT * FROM board_messages WHERE idempotency_key = ?1 LIMIT 1`)
      .bind(effectiveIdemKey)
      .first<BoardMessageRow>();
    if (existingMsg) {
      return checkIdempotencyRow(existingMsg);
    }
  }

  let nextStatus: BoardTopicStatus = existingTopic.status;
  let nextPreviousStatus: BoardPreviousStatus = existingTopic.previous_status;

  if (isQuestion) {
    const baseStatus = input.topicStatus ?? existingTopic.status;
    if (baseStatus === "todo" || baseStatus === "in_progress") {
      nextStatus = "blocked";
      nextPreviousStatus = baseStatus;
    } else if (baseStatus === "blocked") {
      nextStatus = "blocked";
      nextPreviousStatus = existingTopic.previous_status;
    } else {
      nextStatus = "blocked";
      nextPreviousStatus = "";
    }
  } else if (input.topicStatus !== undefined) {
    nextStatus = input.topicStatus;
    if (input.topicStatus === "blocked") {
      if (existingTopic.status === "todo" || existingTopic.status === "in_progress") {
        nextPreviousStatus = existingTopic.status;
      } else if (existingTopic.status !== "blocked") {
        nextPreviousStatus = "";
      }
    } else {
      nextPreviousStatus = "";
    }
  }

  const now = nowIso();
  const messageId = newId("msg");
  const actorScope = principal.scope === "admin" ? "admin" : "client";
  const questionState: BoardQuestionState = isQuestion ? "open" : "";
  const questionExpiresAt = isQuestion ? nowIso(input.questionExpiresSec * 1000) : null;
  const eventType: BoardEventType = isQuestion ? "question.opened" : "message.posted";
  const nextLastHandoffId =
    input.kind === "handoff" ? messageId : existingTopic.last_handoff_message_id;

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO board_messages (
             id, topic_id, channel, seq, kind, reply_to_id,
             actor_scope, actor_key_id, actor_profile, source_node,
             text_md, data_json, idempotency_key,
             question_state, question_options_json, question_expires_at,
             answered_message_id, answered_at, created_at
           ) VALUES (
             ?1, ?2, ?3, COALESCE((SELECT MAX(seq) FROM board_messages WHERE topic_id = ?2), 0) + 1, ?4, NULL,
             ?5, ?6, ?7, ?8,
             ?9, ?10, ?11,
             ?12, ?13, ?14,
             NULL, NULL, ?15
           )`
        )
        .bind(
          messageId,
          topicId,
          existingTopic.channel,
          input.kind,
          actorScope,
          principal.keyId,
          input.actorProfile,
          input.sourceNode,
          redactedTextMd,
          redactedDataJson,
          effectiveIdemKey,
          questionState,
          redactedOptionsJson,
          questionExpiresAt,
          now
        ),
      db
        .prepare(
          `INSERT INTO board_events (channel, topic_id, message_id, event_type, actor_profile, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
        )
        .bind(existingTopic.channel, topicId, messageId, eventType, input.actorProfile, now),
      db
        .prepare(
          `UPDATE board_topics
           SET status = ?1,
               previous_status = ?2,
               last_message_id = ?3,
               last_handoff_message_id = ?4,
               last_event_cursor = last_insert_rowid(),
               updated_at = ?5
           WHERE id = ?6`
        )
        .bind(nextStatus, nextPreviousStatus, messageId, nextLastHandoffId, now, topicId)
    ]);
  } catch (err) {
    if (effectiveIdemKey) {
      const raced = await db
        .prepare(`SELECT * FROM board_messages WHERE idempotency_key = ?1 LIMIT 1`)
        .bind(effectiveIdemKey)
        .first<BoardMessageRow>();
      if (raced) {
        return checkIdempotencyRow(raced);
      }
    }
    throw err;
  }

  const [freshTopicRow, freshMsgRow] = await Promise.all([
    db.prepare(`SELECT * FROM board_topics WHERE id = ?1 LIMIT 1`).bind(topicId).first<BoardTopicRow>(),
    db.prepare(`SELECT * FROM board_messages WHERE id = ?1 LIMIT 1`).bind(messageId).first<BoardMessageRow>()
  ]);

  let hydratedTopic = await hydrateBoardTopic(db, freshTopicRow!);
  let message = mapBoardMessageRow(freshMsgRow!);

  // Push Boundary: ONLY kind = 'question' triggers notification_deliveries & NOTIFY_QUEUE
  if (isQuestion) {
    await enqueueBoardQuestionNotification(db, env, message, hydratedTopic);
    const summaryMap = await getDeliveriesSummaryMap(db, "board_message", [message.id]);
    const summary = summaryMap.get(message.id);
    if (summary) {
      message = mapBoardMessageRow(freshMsgRow!, summary);
    }
  }

  const openBoardQuestionCount = await countOpenBoardQuestions(db);
  return {
    topic: hydratedTopic,
    message,
    cursor: hydratedTopic.last_event_cursor,
    deduplicated: false,
    statusChanged: nextStatus !== existingTopic.status || nextPreviousStatus !== existingTopic.previous_status,
    openBoardQuestionCount
  };
}

export async function answerBoardQuestion(
  db: D1Database,
  principal: AuthPrincipal,
  questionId: string,
  input: ParsedAnswerBoardQuestion
): Promise<{
  topic: BoardTopic;
  question: BoardMessage;
  answer: BoardMessage;
  cursor: number;
  openBoardQuestionCount: number;
}> {
  requireScope(principal, ["admin"]);
  if (!BOARD_MESSAGE_ID_RE.test(questionId)) {
    throw new HubError(404, "NOT_FOUND", `Board question '${questionId}' not found.`);
  }

  const existing = await db
    .prepare(`SELECT * FROM board_messages WHERE id = ?1 LIMIT 1`)
    .bind(questionId)
    .first<BoardMessageRow>();
  if (!existing) {
    throw new HubError(404, "NOT_FOUND", `Board question '${questionId}' not found.`);
  }
  if (existing.kind !== "question") {
    throw new HubError(
      409,
      "INVALID_STATE_TRANSITION",
      `Message '${questionId}' is '${existing.kind}', not a question.`,
      undefined,
      buildSafeReadTopicNext(existing.channel, existing.topic_id)
    );
  }
  if (existing.question_state !== "open") {
    throw new HubError(
      409,
      "INVALID_STATE_TRANSITION",
      `Question '${questionId}' is already '${existing.question_state}'.`,
      undefined,
      buildSafeReadTopicNext(existing.channel, existing.topic_id)
    );
  }

  const redactedSelectedOption =
    input.selectedOption !== undefined ? redactSecrets(input.selectedOption) : undefined;
  if (
    redactedSelectedOption !== undefined &&
    (codePointLength(redactedSelectedOption) < 1 || codePointLength(redactedSelectedOption) > 200)
  ) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      "Field 'selected_option' must have 1..200 characters after redaction."
    );
  }

  const redactedAnswerText =
    input.answerText !== undefined ? redactSecrets(input.answerText) : undefined;
  if (
    redactedAnswerText !== undefined &&
    (codePointLength(redactedAnswerText) < 1 || codePointLength(redactedAnswerText) > 8192)
  ) {
    throw new HubError(
      400,
      "BAD_REQUEST",
      "Field 'answer_text' must have 1..8192 characters after redaction."
    );
  }

  const answerBodyText = redactedAnswerText ?? redactedSelectedOption!;
  const answerDataJson = JSON.stringify(
    redactedSelectedOption !== undefined ? { selected_option: redactedSelectedOption } : {}
  );
  const now = nowIso();

  // CRITICAL FK ORDERING:
  // Single-statement CAS FIRST with answered_message_id = NULL (because answerMsgId does not exist yet
  // and board_messages.answered_message_id REFERENCES board_messages(id) ON DELETE SET NULL under PRAGMA foreign_keys = ON).
  const casRes = await db
    .prepare(
      `UPDATE board_messages
       SET question_state = 'answered',
           answered_message_id = NULL,
           answered_at = ?1
       WHERE id = ?2 AND kind = 'question' AND question_state = 'open'`
    )
    .bind(now, questionId)
    .run();

  if ((casRes.meta.changes ?? 0) === 0) {
    throw new HubError(
      409,
      "INVALID_STATE_TRANSITION",
      `Question '${questionId}' is no longer open.`,
      undefined,
      buildSafeReadTopicNext(existing.channel, existing.topic_id)
    );
  }

  const answerMsgId = newId("msg");
  await db.batch([
    db
      .prepare(
        `INSERT INTO board_messages (
           id, topic_id, channel, seq, kind, reply_to_id,
           actor_scope, actor_key_id, actor_profile, source_node,
           text_md, data_json, idempotency_key,
           question_state, question_options_json, question_expires_at,
           answered_message_id, answered_at, created_at
         ) VALUES (
           ?1, ?2, ?3, COALESCE((SELECT MAX(seq) FROM board_messages WHERE topic_id = ?2), 0) + 1, 'answer', ?4,
           'admin', ?5, ?6, '',
           ?7, ?8, NULL,
           '', '[]', NULL,
           NULL, NULL, ?9
         )`
      )
      .bind(
        answerMsgId,
        existing.topic_id,
        existing.channel,
        questionId,
        principal.keyId,
        input.actorProfile,
        answerBodyText,
        answerDataJson,
        now
      ),
    db
      .prepare(
        `UPDATE board_messages
         SET answered_message_id = ?1
         WHERE id = ?2`
      )
      .bind(answerMsgId, questionId),
    db
      .prepare(
        `INSERT INTO board_events (channel, topic_id, message_id, event_type, actor_profile, created_at)
         VALUES (?1, ?2, ?3, 'question.answered', ?4, ?5)`
      )
      .bind(existing.channel, existing.topic_id, questionId, input.actorProfile, now),
    db
      .prepare(
        `UPDATE board_topics
         SET last_message_id = ?1,
             last_event_cursor = last_insert_rowid(),
             updated_at = ?2,
             status = CASE
               WHEN status = 'blocked'
                AND NOT EXISTS (
                  SELECT 1 FROM board_messages
                  WHERE topic_id = ?3 AND kind = 'question' AND question_state = 'open'
                )
               THEN COALESCE(NULLIF(previous_status, ''), 'in_progress')
               ELSE status
             END,
             previous_status = CASE
               WHEN status = 'blocked'
                AND NOT EXISTS (
                  SELECT 1 FROM board_messages
                  WHERE topic_id = ?3 AND kind = 'question' AND question_state = 'open'
                )
               THEN ''
               ELSE previous_status
             END
         WHERE id = ?3`
      )
      .bind(answerMsgId, now, existing.topic_id)
  ]);

  const [freshTopicRow, freshQuestionRow, freshAnswerRow, openBoardQuestionCount] = await Promise.all([
    db
      .prepare(`SELECT * FROM board_topics WHERE id = ?1 LIMIT 1`)
      .bind(existing.topic_id)
      .first<BoardTopicRow>(),
    db
      .prepare(`SELECT * FROM board_messages WHERE id = ?1 LIMIT 1`)
      .bind(questionId)
      .first<BoardMessageRow>(),
    db
      .prepare(`SELECT * FROM board_messages WHERE id = ?1 LIMIT 1`)
      .bind(answerMsgId)
      .first<BoardMessageRow>(),
    countOpenBoardQuestions(db)
  ]);

  const hydratedTopic = await hydrateBoardTopic(db, freshTopicRow!);
  const summaryMap = await getDeliveriesSummaryMap(db, "board_message", [questionId]);
  return {
    topic: hydratedTopic,
    question: mapBoardMessageRow(freshQuestionRow!, summaryMap.get(questionId)),
    answer: mapBoardMessageRow(freshAnswerRow!),
    cursor: hydratedTopic.last_event_cursor,
    openBoardQuestionCount
  };
}

export async function listBoardEvents(
  db: D1Database,
  principal: AuthPrincipal,
  query: {
    channel?: string;
    topicId?: string;
    afterCursor: number;
    limit: number;
  }
): Promise<{ events: BoardEvent[]; nextCursor: number }> {
  if (query.topicId) {
    // Validates 404 + channel prefix 403
    await getBoardTopicById(db, principal, query.topicId);
  }
  if (query.channel) {
    ensureBoardChannelAllowed(principal, query.channel);
  } else if (!query.topicId) {
    ensureBoardReadAllowed(principal);
  }

  const where: string[] = ["cursor > ?1"];
  const binds: unknown[] = [query.afterCursor];

  const prefixWhere = buildClientPrefixSqlFilter(principal, "channel", binds);
  if (prefixWhere) {
    where.push(prefixWhere);
  }
  if (query.channel) {
    binds.push(query.channel);
    where.push(`channel = ?${binds.length}`);
  }
  if (query.topicId) {
    binds.push(query.topicId);
    where.push(`topic_id = ?${binds.length}`);
  }
  binds.push(query.limit);

  const sql = `SELECT cursor, channel, topic_id, message_id, event_type, actor_profile, created_at
               FROM board_events
               WHERE ${where.join(" AND ")}
               ORDER BY cursor ASC
               LIMIT ?${binds.length}`;
  const res = await db.prepare(sql).bind(...binds).all<BoardEventRow>();
  const events = (res.results ?? [])
    .filter((r) => isBoardChannelAllowed(principal, r.channel))
    .map(mapBoardEventRow);
  const nextCursor =
    events.length > 0 ? events[events.length - 1]!.cursor : query.afterCursor;
  return { events, nextCursor };
}

export async function listMissedTopicStreamFrames(
  db: D1Database,
  topicId: string,
  afterCursor: number
): Promise<Array<Record<string, unknown>>> {
  const eventsRes = await db
    .prepare(
      `SELECT cursor, channel, topic_id, message_id, event_type, actor_profile, created_at
       FROM board_events
       WHERE topic_id = ?1 AND cursor > ?2
       ORDER BY cursor ASC
       LIMIT 500`
    )
    .bind(topicId, afterCursor)
    .all<BoardEventRow>();

  const events = eventsRes.results ?? [];
  if (events.length === 0) {
    return [];
  }

  const topicRow = await db
    .prepare(`SELECT * FROM board_topics WHERE id = ?1 LIMIT 1`)
    .bind(topicId)
    .first<BoardTopicRow>();
  if (!topicRow) {
    return [];
  }
  const hydratedTopic = await hydrateBoardTopic(db, topicRow);

  const msgIds = Array.from(
    new Set(events.map((e) => e.message_id).filter((id): id is string => Boolean(id)))
  );
  const msgMap = new Map<string, BoardMessageRow>();
  const chunkSize = 50;
  for (let i = 0; i < msgIds.length; i += chunkSize) {
    const chunk = msgIds.slice(i, i + chunkSize);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(", ");
    const msgRes = await db
      .prepare(`SELECT * FROM board_messages WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<BoardMessageRow>();
    for (const m of msgRes.results ?? []) {
      msgMap.set(m.id, m);
    }
  }

  const answerIds = Array.from(
    new Set(
      Array.from(msgMap.values())
        .map((m) => m.answered_message_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0 && !msgMap.has(id))
    )
  );
  for (let i = 0; i < answerIds.length; i += chunkSize) {
    const chunk = answerIds.slice(i, i + chunkSize);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(", ");
    const ansRes = await db
      .prepare(`SELECT * FROM board_messages WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<BoardMessageRow>();
    for (const a of ansRes.results ?? []) {
      msgMap.set(a.id, a);
    }
  }

  const summaryMap = await getDeliveriesSummaryMap(
    db,
    "board_message",
    Array.from(msgMap.values())
      .filter((m) => m.kind === "question")
      .map((m) => m.id)
  );

  const frames: Array<Record<string, unknown>> = [];
  for (const ev of events) {
    const cursor = Number(ev.cursor);
    switch (ev.event_type) {
      case "topic.created":
      case "topic.updated": {
        frames.push({
          type: "board.topic_updated",
          topic: hydratedTopic,
          cursor
        });
        break;
      }
      case "message.posted":
      case "question.opened": {
        const msgRow = ev.message_id ? msgMap.get(ev.message_id) : undefined;
        if (msgRow) {
          frames.push({
            type: "board.message_created",
            message: mapBoardMessageRow(msgRow, summaryMap.get(msgRow.id)),
            topic: hydratedTopic,
            cursor
          });
        } else {
          frames.push({
            type: "board.topic_updated",
            topic: hydratedTopic,
            cursor
          });
        }
        break;
      }
      case "question.answered": {
        const qRow = ev.message_id ? msgMap.get(ev.message_id) : undefined;
        const aRow = qRow?.answered_message_id ? msgMap.get(qRow.answered_message_id) : undefined;
        if (qRow && aRow) {
          frames.push({
            type: "board.question_answered",
            question: mapBoardMessageRow(qRow, summaryMap.get(qRow.id)),
            answer: mapBoardMessageRow(aRow),
            topic: hydratedTopic,
            cursor
          });
        } else {
          frames.push({
            type: "board.topic_updated",
            topic: hydratedTopic,
            cursor
          });
        }
        break;
      }
      case "question.expired":
      case "question.cancelled": {
        frames.push({
          type: "board.topic_updated",
          topic: hydratedTopic,
          cursor
        });
        const qRow = ev.message_id ? msgMap.get(ev.message_id) : undefined;
        if (qRow) {
          frames.push({
            type: "board.message_created",
            message: mapBoardMessageRow(qRow, summaryMap.get(qRow.id)),
            topic: hydratedTopic,
            cursor
          });
        }
        break;
      }
    }
  }
  return frames;
}

export async function expireOpenBoardQuestions(
  db: D1Database,
  nowMs = Date.now()
): Promise<Array<{ topic: BoardTopic; message: BoardMessage; cursor: number }>> {
  const now = new Date(nowMs).toISOString();
  const expiredRes = await db
    .prepare(
      `SELECT * FROM board_messages
       WHERE kind = 'question'
         AND question_state = 'open'
         AND question_expires_at IS NOT NULL
         AND question_expires_at < ?1
       ORDER BY question_expires_at ASC
       LIMIT 100`
    )
    .bind(now)
    .all<BoardMessageRow>();

  const rows = expiredRes.results ?? [];
  const results: Array<{ topic: BoardTopic; message: BoardMessage; cursor: number }> = [];

  for (const row of rows) {
    const casRes = await db
      .prepare(
        `UPDATE board_messages
         SET question_state = 'expired'
         WHERE id = ?1 AND kind = 'question' AND question_state = 'open'`
      )
      .bind(row.id)
      .run();

    if ((casRes.meta.changes ?? 0) !== 1) {
      continue;
    }

    await db.batch([
      db
        .prepare(
          `INSERT INTO board_events (channel, topic_id, message_id, event_type, actor_profile, created_at)
           VALUES (?1, ?2, ?3, 'question.expired', '', ?4)`
        )
        .bind(row.channel, row.topic_id, row.id, now),
      db
        .prepare(
          `UPDATE board_topics
           SET last_event_cursor = last_insert_rowid(),
               updated_at = ?1,
               status = CASE
                 WHEN status = 'blocked'
                  AND NOT EXISTS (
                    SELECT 1 FROM board_messages
                    WHERE topic_id = ?2 AND kind = 'question' AND question_state = 'open'
                  )
                 THEN COALESCE(NULLIF(previous_status, ''), 'in_progress')
                 ELSE status
               END,
               previous_status = CASE
                 WHEN status = 'blocked'
                  AND NOT EXISTS (
                    SELECT 1 FROM board_messages
                    WHERE topic_id = ?2 AND kind = 'question' AND question_state = 'open'
                  )
                 THEN ''
                 ELSE previous_status
               END
           WHERE id = ?2`
        )
        .bind(now, row.topic_id)
    ]);

    const [freshTopicRow, freshMsgRow] = await Promise.all([
      db.prepare(`SELECT * FROM board_topics WHERE id = ?1 LIMIT 1`).bind(row.topic_id).first<BoardTopicRow>(),
      db.prepare(`SELECT * FROM board_messages WHERE id = ?1 LIMIT 1`).bind(row.id).first<BoardMessageRow>()
    ]);
    if (freshTopicRow && freshMsgRow) {
      const topic = await hydrateBoardTopic(db, freshTopicRow);
      results.push({
        topic,
        message: mapBoardMessageRow(freshMsgRow),
        cursor: topic.last_event_cursor
      });
    }
  }
  return results;
}

export async function pruneExpiredBoardEvents(
  db: D1Database,
  retentionDays = 90,
  batchLimit = 500,
  nowMs = Date.now()
): Promise<{ deletedEvents: number; deletedDeliveries: number }> {
  const days =
    Number.isFinite(retentionDays) && retentionDays >= 1
      ? Math.min(Math.floor(retentionDays), 3650)
      : 90;
  const limit =
    Number.isFinite(batchLimit) && batchLimit >= 1
      ? Math.min(Math.floor(batchLimit), 1000)
      : 500;
  const cutoffIso = new Date(nowMs - days * 86_400_000).toISOString();

  // Never delete board_topics or board_messages entities — only old board_events and expired board_message deliveries.
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM board_events
         WHERE cursor IN (
           SELECT cursor FROM board_events
           WHERE created_at < ?1
           ORDER BY cursor ASC
           LIMIT ?2
         )`
      )
      .bind(cutoffIso, limit),
    db
      .prepare(
        `DELETE FROM notification_deliveries
         WHERE id IN (
           SELECT id FROM notification_deliveries
           WHERE source_kind = 'board_message'
             AND created_at < ?1
           ORDER BY created_at ASC, id ASC
           LIMIT ?2
         )`
      )
      .bind(cutoffIso, limit)
  ]);

  return {
    deletedEvents: Number(results[0]?.meta?.changes ?? 0),
    deletedDeliveries: Number(results[1]?.meta?.changes ?? 0)
  };
}

export function buildForbiddenBoardScopeError(principal: AuthPrincipal, channel: string): HubError {
  const hints = buildBoardPrefixNextHints(principal);
  return new HubError(
    403,
    "FORBIDDEN_SCOPE",
    `Client key is not permitted to access board channel '${channel}'.`,
    undefined,
    hints.length > 0 ? hints : undefined
  );
}
