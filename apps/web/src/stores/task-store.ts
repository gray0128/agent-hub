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
    case "queued":
      return 0;
    case "claimed":
      return 1;
    case "running":
    case "needs_approval":
      return 2;
    case "done":
    case "failed":
    case "cancelled":
      return 3;
  }
}

function isTerminalRunStatus(status: RunRecord["status"]): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

function mergeRunRecord(existing: RunRecord, incoming: RunRecord): RunRecord {
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
      ...existing,
      prompt: existing.prompt ?? incoming.prompt,
      output_preview: existing.output_preview ?? incoming.output_preview,
      output_md: existing.output_md ?? incoming.output_md
    };
  }

  return {
    ...existing,
    ...incoming,
    prompt: incoming.prompt ?? existing.prompt,
    output_preview: incoming.output_preview ?? existing.output_preview,
    output_md: incoming.output_md ?? existing.output_md
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
      const merged = runs.map((r) => {
        const prev = prevById.get(r.id);
        return prev ? mergeRunRecord(prev, r) : r;
      });
      const sorted = sortRuns(merged);
      const validRun = state.selectedRunId && sorted.some((r) => r.id === state.selectedRunId);
      return {
        runs: sorted,
        selectedRunId: validRun ? state.selectedRunId : (sorted[0]?.id ?? null)
      };
    }),

  upsertRun: (run) =>
    set((state) => {
      const idx = state.runs.findIndex((r) => r.id === run.id);
      const next =
        idx >= 0
          ? state.runs.map((r, i) => (i === idx ? mergeRunRecord(r, run) : r))
          : [run, ...state.runs];
      return {
        runs: sortRuns(next),
        selectedRunId: state.selectedRunId ?? run.id
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
