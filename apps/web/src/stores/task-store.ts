import { create } from "zustand";
import type { RunEventItem, RunRecord, ThreadRecord } from "@/types";

export const MAX_EVENTS_PER_RUN = 500;

interface TaskState {
  threads: ThreadRecord[];
  runs: RunRecord[];
  eventsByRunId: Record<string, RunEventItem[]>;
  fullOutputByRunId: Record<string, string>;
  selectedThreadId: string | null;
  selectedRunId: string | null;
  setThreads: (threads: ThreadRecord[]) => void;
  upsertThread: (thread: ThreadRecord) => void;
  setRuns: (runs: RunRecord[]) => void;
  upsertRun: (run: RunRecord) => void;
  upsertRuns: (runs: RunRecord[]) => void;
  appendEvents: (runId: string, incoming: RunEventItem[]) => void;
  setFullOutput: (runId: string, outputMd: string) => void;
  selectThread: (threadId: string | null) => void;
  selectRun: (runId: string | null) => void;
}

function sortThreads(threads: ThreadRecord[]): ThreadRecord[] {
  return [...threads].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

function sortRuns(runs: RunRecord[]): RunRecord[] {
  return [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function mergeBoundedEvents(existing: RunEventItem[], incoming: RunEventItem[]): RunEventItem[] {
  const bySeq = new Map<number, RunEventItem>();
  for (const item of existing) {
    bySeq.set(item.seq, item);
  }
  for (const item of incoming) {
    bySeq.set(item.seq, item);
  }
  const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
  if (merged.length > MAX_EVENTS_PER_RUN) {
    return merged.slice(-MAX_EVENTS_PER_RUN);
  }
  return merged;
}

function runStatusRank(status: RunRecord["status"]): number {
  switch (status) {
    case "waiting":
      return 0;
    case "queued":
      return 1;
    case "claimed":
      return 2;
    case "running":
    case "needs_approval":
      return 3;
    case "done":
    case "failed":
    case "cancelled":
      return 4;
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
      return 0;
    }
  }
}

function isTerminalRunStatus(status: RunRecord["status"]): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

function mergeRunRecordWithMeta(
  existing: RunRecord,
  incoming: RunRecord
): { run: RunRecord; outputInvalidated: boolean } {
  const existingTerminal = isTerminalRunStatus(existing.status);
  const incomingTerminal = isTerminalRunStatus(incoming.status);
  const existingTs = Date.parse(existing.updated_at || existing.created_at) || 0;
  const incomingTs = Date.parse(incoming.updated_at || incoming.created_at) || 0;

  const incomingIsStale =
    (existingTerminal && !incomingTerminal) ||
    existingTs > incomingTs ||
    (existingTs === incomingTs && runStatusRank(incoming.status) < runStatusRank(existing.status));

  if (incomingIsStale) {
    return {
      run: {
        ...existing,
        prompt: existing.prompt ?? incoming.prompt,
        output_preview: existing.output_preview ?? incoming.output_preview,
        output_md: existing.output_md ?? incoming.output_md,
        truncated: existing.truncated ?? incoming.truncated,
        deliveries_summary: existing.deliveries_summary ?? incoming.deliveries_summary,
        depends_on_run_ids: existing.depends_on_run_ids ?? incoming.depends_on_run_ids,
        blocked_reason: existing.status === "waiting" ? (existing.blocked_reason ?? null) : null,
        labels: existing.labels !== undefined ? existing.labels : incoming.labels,
        result_schema:
          existing.result_schema !== undefined ? existing.result_schema : incoming.result_schema,
        result: existing.result !== undefined ? existing.result : incoming.result
      },
      outputInvalidated: false
    };
  }

  const outputChanged =
    incoming.output_bytes !== existing.output_bytes ||
    (existing.status === "needs_approval" && incoming.status !== "needs_approval");

  const nextOutputMd = outputChanged ? incoming.output_md : (incoming.output_md ?? existing.output_md);
  const nextOutputPreview = outputChanged
    ? incoming.output_preview
    : (incoming.output_preview ?? existing.output_preview);
  const nextTruncated =
    nextOutputMd !== undefined
      ? false
      : outputChanged
        ? incoming.truncated
        : (incoming.truncated ?? existing.truncated);

  const nextPlanId = incoming.plan_id !== undefined ? incoming.plan_id : existing.plan_id;
  const nextPlanKey = incoming.plan_key !== undefined ? incoming.plan_key : existing.plan_key;
  const nextScheduledAt =
    incoming.scheduled_at !== undefined ? incoming.scheduled_at : existing.scheduled_at;
  const nextRetryOfRunId =
    incoming.retry_of_run_id !== undefined ? incoming.retry_of_run_id : existing.retry_of_run_id;
  const nextActorProfile =
    incoming.actor_profile !== undefined ? incoming.actor_profile : existing.actor_profile;
  const nextBoardTopicId =
    incoming.board_topic_id !== undefined ? incoming.board_topic_id : existing.board_topic_id;
  const nextDependsOnRunIds =
    incoming.depends_on_run_ids !== undefined
      ? incoming.depends_on_run_ids
      : existing.depends_on_run_ids;
  const nextBlockedReason =
    incoming.status !== "waiting"
      ? null
      : incoming.blocked_reason !== undefined
        ? incoming.blocked_reason
        : (existing.blocked_reason ?? null);
  const nextLabels = incoming.labels !== undefined ? incoming.labels : existing.labels;
  const nextResultSchema =
    incoming.result_schema !== undefined ? incoming.result_schema : existing.result_schema;
  const nextResult = incoming.result !== undefined ? incoming.result : existing.result;

  return {
    run: {
      ...existing,
      ...incoming,
      plan_id: nextPlanId,
      plan_key: nextPlanKey,
      scheduled_at: nextScheduledAt,
      retry_of_run_id: nextRetryOfRunId,
      actor_profile: nextActorProfile,
      board_topic_id: nextBoardTopicId,
      depends_on_run_ids: nextDependsOnRunIds,
      blocked_reason: nextBlockedReason,
      labels: nextLabels,
      result_schema: nextResultSchema,
      result: nextResult,
      prompt: incoming.prompt ?? existing.prompt,
      output_preview: nextOutputPreview,
      output_md: nextOutputMd,
      truncated: nextTruncated,
      deliveries_summary: incoming.deliveries_summary ?? existing.deliveries_summary
    },
    outputInvalidated: outputChanged && incoming.output_md === undefined
  };
}

export const useTaskStore = create<TaskState>((set) => ({
  threads: [],
  runs: [],
  eventsByRunId: {},
  fullOutputByRunId: {},
  selectedThreadId: null,
  selectedRunId: null,

  setThreads: (threads) =>
    set((state) => {
      const sorted = sortThreads(threads);
      const validSelection =
        state.selectedThreadId && sorted.some((t) => t.id === state.selectedThreadId);
      return {
        threads: sorted,
        selectedThreadId: validSelection ? state.selectedThreadId : (sorted[0]?.id ?? null)
      };
    }),

  upsertThread: (thread) =>
    set((state) => {
      const idx = state.threads.findIndex((t) => t.id === thread.id);
      const next =
        idx >= 0
          ? state.threads.map((t, i) => (i === idx ? thread : t))
          : [thread, ...state.threads];
      const sorted = sortThreads(next);
      return {
        threads: sorted,
        selectedThreadId: state.selectedThreadId ?? thread.id
      };
    }),

  setRuns: (runs) =>
    set((state) => {
      const prevById = new Map(state.runs.map((r) => [r.id, r]));
      const nextFullOutput = { ...state.fullOutputByRunId };
      let fullChanged = false;
      const merged = runs.map((r) => {
        const prev = prevById.get(r.id);
        if (!prev) {
          if (r.output_md !== undefined && nextFullOutput[r.id] !== r.output_md) {
            nextFullOutput[r.id] = r.output_md;
            fullChanged = true;
          }
          return r;
        }
        const res = mergeRunRecordWithMeta(prev, r);
        if (res.run.output_md !== undefined) {
          if (nextFullOutput[res.run.id] !== res.run.output_md) {
            nextFullOutput[res.run.id] = res.run.output_md;
            fullChanged = true;
          }
        } else if (res.outputInvalidated && res.run.id in nextFullOutput) {
          delete nextFullOutput[res.run.id];
          fullChanged = true;
        }
        return res.run;
      });
      const sorted = sortRuns(merged);
      const validRun = state.selectedRunId && sorted.some((r) => r.id === state.selectedRunId);
      return {
        runs: sorted,
        ...(fullChanged ? { fullOutputByRunId: nextFullOutput } : {}),
        selectedRunId: validRun ? state.selectedRunId : (sorted[0]?.id ?? null)
      };
    }),

  upsertRun: (run) =>
    set((state) => {
      const idx = state.runs.findIndex((r) => r.id === run.id);
      const prev = idx >= 0 ? state.runs[idx] : undefined;
      let mergedRun = run;
      let outputInvalidated = false;
      if (prev) {
        const res = mergeRunRecordWithMeta(prev, run);
        mergedRun = res.run;
        outputInvalidated = res.outputInvalidated;
      }

      let nextFullOutput = state.fullOutputByRunId;
      if (mergedRun.output_md !== undefined) {
        if (nextFullOutput[mergedRun.id] !== mergedRun.output_md) {
          nextFullOutput = { ...nextFullOutput, [mergedRun.id]: mergedRun.output_md };
        }
      } else if (outputInvalidated && mergedRun.id in nextFullOutput) {
        const copy = { ...nextFullOutput };
        delete copy[mergedRun.id];
        nextFullOutput = copy;
      }

      const next =
        idx >= 0
          ? state.runs.map((r, i) => (i === idx ? mergedRun : r))
          : [mergedRun, ...state.runs];
      const nextSorted = sortRuns(next);
      let nextThreads = state.threads;
      if (mergedRun.thread_id) {
        const targetThread = state.threads.find((t) => t.id === mergedRun.thread_id);
        if (
          targetThread &&
          !targetThread.native_session_id &&
          (targetThread.node_id !== mergedRun.node_id || targetThread.workdir !== mergedRun.workdir)
        ) {
          const threadRunCount = next.reduce((acc, r) => (r.thread_id === mergedRun.thread_id ? acc + 1 : acc), 0);
          if (threadRunCount <= 1) {
            const cleanedDir = mergedRun.workdir.replace(/[\\/]+$/, "");
            const sepIdx = Math.max(cleanedDir.lastIndexOf("/"), cleanedDir.lastIndexOf("\\"));
            const projectKey = sepIdx >= 0 ? cleanedDir.slice(sepIdx + 1) : cleanedDir;
            nextThreads = state.threads.map((t) =>
              t.id === mergedRun.thread_id
                ? {
                    ...t,
                    node_id: mergedRun.node_id,
                    workdir: mergedRun.workdir,
                    project_key: projectKey || t.project_key
                  }
                : t
            );
          }
        }
      }
      return {
        runs: nextSorted,
        ...(nextFullOutput !== state.fullOutputByRunId ? { fullOutputByRunId: nextFullOutput } : {}),
        threads: nextThreads,
        selectedRunId: state.selectedRunId ?? mergedRun.id
      };
    }),

  upsertRuns: (incomingRuns) =>
    set((state) => {
      if (incomingRuns.length === 0) return state;
      const byId = new Map(state.runs.map((r) => [r.id, r]));
      const nextFullOutput = { ...state.fullOutputByRunId };
      let fullChanged = false;

      for (const r of incomingRuns) {
        const prev = byId.get(r.id);
        if (!prev) {
          byId.set(r.id, r.status !== "waiting" ? { ...r, blocked_reason: null } : r);
          if (r.output_md !== undefined && nextFullOutput[r.id] !== r.output_md) {
            nextFullOutput[r.id] = r.output_md;
            fullChanged = true;
          }
          continue;
        }
        const res = mergeRunRecordWithMeta(prev, r);
        byId.set(r.id, res.run);
        if (res.run.output_md !== undefined) {
          if (nextFullOutput[res.run.id] !== res.run.output_md) {
            nextFullOutput[res.run.id] = res.run.output_md;
            fullChanged = true;
          }
        } else if (res.outputInvalidated && res.run.id in nextFullOutput) {
          delete nextFullOutput[res.run.id];
          fullChanged = true;
        }
      }

      return {
        runs: sortRuns(Array.from(byId.values())),
        ...(fullChanged ? { fullOutputByRunId: nextFullOutput } : {})
      };
    }),

  appendEvents: (runId, incoming) =>
    set((state) => {
      if (!incoming.length) return state;
      const existing = state.eventsByRunId[runId] ?? [];
      const bounded = mergeBoundedEvents(existing, incoming);
      return {
        eventsByRunId: {
          ...state.eventsByRunId,
          [runId]: bounded
        }
      };
    }),

  setFullOutput: (runId, outputMd) =>
    set((state) => ({
      fullOutputByRunId: {
        ...state.fullOutputByRunId,
        [runId]: outputMd
      }
    })),

  selectThread: (threadId) =>
    set((state) => {
      if (!threadId) return { selectedThreadId: null };
      const latestForThread = state.runs.find((r) => r.thread_id === threadId);
      return {
        selectedThreadId: threadId,
        selectedRunId: latestForThread?.id ?? state.selectedRunId
      };
    }),

  selectRun: (runId) => set({ selectedRunId: runId })
}));
