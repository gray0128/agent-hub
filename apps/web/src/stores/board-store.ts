import { create } from "zustand";
import type {
  BoardChannelSummary,
  BoardMessage,
  BoardTopic
} from "@/types";

export type BoardTopicFilter = "active" | "open_questions";

function compareTopics(a: BoardTopic, b: BoardTopic): number {
  if (a.pinned !== b.pinned) {
    return a.pinned ? -1 : 1;
  }
  if (a.updated_at !== b.updated_at) {
    return b.updated_at.localeCompare(a.updated_at);
  }
  return a.id.localeCompare(b.id);
}

function sortAndDedupTopics(topics: BoardTopic[]): BoardTopic[] {
  const map = new Map<string, BoardTopic>();
  for (const t of topics) {
    const prev = map.get(t.id);
    map.set(t.id, prev ? mergeTopicFields(prev, t) : t);
  }
  return Array.from(map.values()).sort(compareTopics);
}

function mergeTopicFields(prev: BoardTopic, next: BoardTopic): BoardTopic {
  return {
    ...prev,
    ...next,
    open_question_count: next.open_question_count ?? prev.open_question_count,
    message_count: next.message_count ?? prev.message_count,
    latest_handoff:
      next.latest_handoff !== undefined ? next.latest_handoff : prev.latest_handoff
  };
}

function sortAndDedupMessages(messages: BoardMessage[]): BoardMessage[] {
  const byId = new Map<string, BoardMessage>();
  for (const m of messages) {
    const existing = byId.get(m.id);
    byId.set(m.id, existing ? { ...existing, ...m } : m);
  }
  return Array.from(byId.values()).sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

function deriveOpenQuestionCount(topics: BoardTopic[]): number {
  return topics.reduce((sum, t) => sum + (t.open_question_count ?? 0), 0);
}

function recomputeChannelsFromTopics(
  existingChannels: BoardChannelSummary[],
  topics: BoardTopic[]
): BoardChannelSummary[] {
  if (existingChannels.length === 0 && topics.length === 0) {
    return [];
  }
  const existingByChannel = new Map<string, BoardChannelSummary>();
  for (const ch of existingChannels) {
    existingByChannel.set(ch.channel, ch);
  }
  const topicsByChannel = new Map<string, BoardTopic[]>();
  for (const t of topics) {
    const list = topicsByChannel.get(t.channel);
    if (list) {
      list.push(t);
    } else {
      topicsByChannel.set(t.channel, [t]);
    }
  }

  const byChannel = new Map<string, BoardChannelSummary>();
  // Preserve server-hydrated counts for channels with no topics in the loaded slice
  for (const [channelName, ch] of existingByChannel.entries()) {
    if (!topicsByChannel.has(channelName)) {
      byChannel.set(channelName, ch);
    }
  }
  for (const [channelName, channelTopics] of topicsByChannel.entries()) {
    const existing = existingByChannel.get(channelName);
    let activeCount = 0;
    let openQuestionCount = 0;
    let latestUpdatedAt: string | null = existing?.updated_at ?? null;
    for (const t of channelTopics) {
      if (t.status !== "archived") {
        activeCount += 1;
      }
      openQuestionCount += t.open_question_count ?? 0;
      if (!latestUpdatedAt || t.updated_at > latestUpdatedAt) {
        latestUpdatedAt = t.updated_at;
      }
    }
    byChannel.set(channelName, {
      channel: channelName,
      active_topic_count: activeCount,
      open_question_count: openQuestionCount,
      total_topic_count: Math.max(existing?.total_topic_count ?? 0, channelTopics.length),
      updated_at: latestUpdatedAt
    });
  }
  return Array.from(byChannel.values()).sort((a, b) => a.channel.localeCompare(b.channel));
}

export interface AppendBoardMessageOptions {
  topicUpdated?: boolean;
  openQuestionCount?: number;
}

export interface BoardState {
  channels: BoardChannelSummary[];
  topics: BoardTopic[];
  messagesByTopicId: Record<string, BoardMessage[]>;
  eventsCursor: number;
  openBoardQuestionCount: number;
  selectedChannel: string | null;
  selectedTopicId: string | null;
  topicFilter: BoardTopicFilter;
  searchQuery: string;
  boardPermissionDenied: boolean;
  hydrateBoard: (payload: {
    channels: BoardChannelSummary[];
    topics: BoardTopic[];
    eventsCursor?: number;
    openQuestionCount?: number;
  }) => void;
  setOpenBoardQuestionCount: (count: number) => void;
  upsertTopic: (topic: BoardTopic) => void;
  setTopicMessages: (topicId: string, messages: BoardMessage[], cursor?: number) => void;
  appendMessage: (
    topicId: string,
    message: BoardMessage,
    cursor?: number,
    options?: AppendBoardMessageOptions
  ) => void;
  applyQuestionAnswered: (payload: {
    question: BoardMessage;
    answer: BoardMessage;
    topic?: BoardTopic;
    cursor?: number;
    openQuestionCount?: number;
  }) => void;
  selectChannel: (channel: string | null) => void;
  selectTopic: (topicId: string | null) => void;
  setTopicFilter: (filter: BoardTopicFilter) => void;
  setSearchQuery: (q: string) => void;
  setBoardPermissionDenied: (denied: boolean) => void;
  reset: () => void;
}

export const useBoardStore = create<BoardState>((set) => ({
  channels: [],
  topics: [],
  messagesByTopicId: {},
  eventsCursor: 0,
  openBoardQuestionCount: 0,
  selectedChannel: null,
  selectedTopicId: null,
  topicFilter: "active",
  searchQuery: "",
  boardPermissionDenied: false,

  hydrateBoard: ({ channels, topics, eventsCursor, openQuestionCount }) =>
    set((state) => {
      const sortedTopics = sortAndDedupTopics(topics);
      const nextChannels = [...channels].sort((a, b) => a.channel.localeCompare(b.channel));
      const maxTopicCursor = sortedTopics.reduce(
        (max, t) => Math.max(max, t.last_event_cursor ?? 0),
        0
      );
      const nextCursor = Math.max(state.eventsCursor, eventsCursor ?? 0, maxTopicCursor);
      const channelCountSum = nextChannels.reduce((s, c) => s + (c.open_question_count ?? 0), 0);
      const topicCountSum = deriveOpenQuestionCount(sortedTopics);
      const nextOpenCount =
        openQuestionCount !== undefined
          ? openQuestionCount
          : Math.max(channelCountSum, topicCountSum);

      let nextSelectedTopicId = state.selectedTopicId;
      if (nextSelectedTopicId && !sortedTopics.some((t) => t.id === nextSelectedTopicId)) {
        nextSelectedTopicId = null;
      }
      if (!nextSelectedTopicId && sortedTopics.length > 0) {
        nextSelectedTopicId = sortedTopics[0].id;
      }

      return {
        channels: nextChannels,
        topics: sortedTopics,
        eventsCursor: nextCursor,
        openBoardQuestionCount: nextOpenCount,
        selectedTopicId: nextSelectedTopicId,
        boardPermissionDenied: false
      };
    }),

  setOpenBoardQuestionCount: (count) =>
    set({ openBoardQuestionCount: Math.max(0, count) }),

  upsertTopic: (topic) =>
    set((state) => {
      const existing = state.topics.find((t) => t.id === topic.id);
      const merged = existing ? mergeTopicFields(existing, topic) : topic;
      const openDelta = (merged.open_question_count ?? 0) - (existing?.open_question_count ?? 0);
      const nextTopics = sortAndDedupTopics(
        existing
          ? state.topics.map((t) => (t.id === topic.id ? merged : t))
          : [merged, ...state.topics]
      );
      const nextChannels = recomputeChannelsFromTopics(state.channels, nextTopics);
      const nextCursor = Math.max(state.eventsCursor, topic.last_event_cursor ?? 0);

      return {
        topics: nextTopics,
        channels: nextChannels,
        eventsCursor: nextCursor,
        openBoardQuestionCount: Math.max(0, state.openBoardQuestionCount + openDelta),
        selectedTopicId: state.selectedTopicId ?? merged.id
      };
    }),

  setTopicMessages: (topicId, messages, cursor) =>
    set((state) => {
      const sorted = sortAndDedupMessages(messages);
      return {
        messagesByTopicId: {
          ...state.messagesByTopicId,
          [topicId]: sorted
        },
        eventsCursor: Math.max(state.eventsCursor, cursor ?? 0)
      };
    }),

  appendMessage: (topicId, message, cursor, options) =>
    set((state) => {
      const current = state.messagesByTopicId[topicId] ?? [];
      const alreadyExists = current.some((m) => m.id === message.id);
      const nextMessages = sortAndDedupMessages([...current, message]);
      const nextCursor = Math.max(state.eventsCursor, cursor ?? 0);

      const isNewOpenQuestion =
        !alreadyExists && message.kind === "question" && message.question_state === "open";
      let topicOpenDelta = 0;
      let nextTopics = state.topics;

      if (isNewOpenQuestion && options?.topicUpdated !== true) {
        const nextOpenInMessages = nextMessages.filter(
          (m) => m.kind === "question" && m.question_state === "open"
        ).length;
        const hasTopic = state.topics.some((t) => t.id === topicId);
        if (hasTopic) {
          nextTopics = state.topics.map((t) => {
            if (t.id !== topicId) return t;
            const prevCount = t.open_question_count ?? 0;
            const targetCount =
              options?.topicUpdated === false
                ? prevCount + 1
                : Math.max(prevCount, nextOpenInMessages);
            topicOpenDelta = targetCount - prevCount;
            return {
              ...t,
              open_question_count: targetCount,
              last_message_id: message.id,
              updated_at: message.created_at
            };
          });
        } else {
          topicOpenDelta = 1;
        }
      }

      const nextOpenCount =
        options?.openQuestionCount !== undefined
          ? Math.max(0, options.openQuestionCount)
          : Math.max(0, state.openBoardQuestionCount + topicOpenDelta);

      return {
        messagesByTopicId: {
          ...state.messagesByTopicId,
          [topicId]: nextMessages
        },
        topics: nextTopics,
        channels: recomputeChannelsFromTopics(state.channels, nextTopics),
        eventsCursor: nextCursor,
        openBoardQuestionCount: nextOpenCount
      };
    }),

  applyQuestionAnswered: ({ question, answer, topic, cursor, openQuestionCount }) =>
    set((state) => {
      const topicId = question.topic_id;
      const current = state.messagesByTopicId[topicId] ?? [];
      const prevQuestion = current.find((m) => m.id === question.id);
      const prevTopic = state.topics.find((t) => t.id === topicId);
      const wasOpen = prevQuestion ? prevQuestion.question_state === "open" : false;
      const nextMessages = sortAndDedupMessages([
        ...current.filter((m) => m.id !== question.id && m.id !== answer.id),
        question,
        answer
      ]);

      let nextTopics = state.topics;
      let topicOpenDelta = 0;
      if (topic) {
        const mergedTopic = prevTopic ? mergeTopicFields(prevTopic, topic) : topic;
        if (prevTopic) {
          topicOpenDelta = (mergedTopic.open_question_count ?? 0) - (prevTopic.open_question_count ?? 0);
        }
        nextTopics = sortAndDedupTopics(
          prevTopic
            ? state.topics.map((t) => (t.id === topic.id ? mergedTopic : t))
            : [mergedTopic, ...state.topics]
        );
      } else if (wasOpen) {
        nextTopics = state.topics.map((t) =>
          t.id === topicId
            ? {
                ...t,
                open_question_count: Math.max(0, (t.open_question_count ?? 1) - 1),
                last_message_id: answer.id,
                updated_at: answer.created_at
              }
            : t
        );
      }

      const nextOpenCount =
        openQuestionCount !== undefined
          ? Math.max(0, openQuestionCount)
          : prevQuestion
            ? wasOpen
              ? Math.max(0, state.openBoardQuestionCount - 1)
              : state.openBoardQuestionCount
            : prevTopic && topic && topicOpenDelta < 0
              ? Math.max(0, state.openBoardQuestionCount + topicOpenDelta)
              : state.openBoardQuestionCount;

      return {
        messagesByTopicId: {
          ...state.messagesByTopicId,
          [topicId]: nextMessages
        },
        topics: nextTopics,
        channels: recomputeChannelsFromTopics(state.channels, nextTopics),
        eventsCursor: Math.max(state.eventsCursor, cursor ?? 0),
        openBoardQuestionCount: nextOpenCount
      };
    }),

  selectChannel: (selectedChannel) => set({ selectedChannel }),
  selectTopic: (selectedTopicId) => set({ selectedTopicId }),
  setTopicFilter: (topicFilter) => set({ topicFilter }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setBoardPermissionDenied: (boardPermissionDenied) => set({ boardPermissionDenied }),

  reset: () =>
    set({
      channels: [],
      topics: [],
      messagesByTopicId: {},
      eventsCursor: 0,
      openBoardQuestionCount: 0,
      selectedChannel: null,
      selectedTopicId: null,
      topicFilter: "active",
      searchQuery: "",
      boardPermissionDenied: false
    })
}));
