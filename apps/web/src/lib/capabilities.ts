import type { ComposerDraft } from "@/stores/workbench-store";
import type {
  AgentCapability,
  AgentName,
  BoardTopic,
  EffortLevel,
  ModelCapability,
  NodeRecord
} from "@/types";

export const ALL_AGENTS: AgentName[] = ["agy", "pi", "omp", "codex", "claude"];
export const DEFAULT_AGY_MODEL = "gemini-4-hydrogen";
export const DEFAULT_AGY_EFFORT: EffortLevel = "high";

const FALLBACK_EFFORTS_BY_AGENT: Record<AgentName, EffortLevel[]> = {
  agy: ["low", "medium", "high", "xhigh"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  omp: ["off", "minimal", "low", "medium", "high", "xhigh"],
  codex: ["low", "medium", "high", "xhigh", "ultra"],
  claude: ["low", "medium", "high", "max"]
};

const AGY_ALIAS_TO_STEM: Record<string, string> = {
  carbon: "gemini-4-carbon",
  argon: "gemini-4-argon",
  hydrogen: "gemini-4-hydrogen",
  flash: "gemini-3.8-flash",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5"
};

export interface ResolvedAgentCatalog {
  status: "pending" | "ready" | "fallback";
  models: ModelCapability[];
  defaultModel: string;
  defaultEffort: EffortLevel;
  allowManual: boolean;
}

export interface ResolvedEffortState {
  supportsEffort: boolean;
  efforts: EffortLevel[];
  defaultEffort: EffortLevel;
}

export function getAvailableAgents(node?: NodeRecord | null): AgentName[] {
  const agentsMap = node?.capabilities?.agents;
  if (!agentsMap) {
    return ALL_AGENTS;
  }

  const ready = ALL_AGENTS.filter((agent) => {
    const cap = agentsMap[agent];
    return Boolean(cap && cap.enabled !== false && cap.available !== false);
  });
  if (ready.length > 0) {
    return ready;
  }

  const enabled = ALL_AGENTS.filter((agent) => {
    const cap = agentsMap[agent];
    return Boolean(cap && cap.enabled !== false);
  });
  return enabled.length > 0 ? enabled : ALL_AGENTS;
}

export function resolveAgentCatalog(
  node: NodeRecord | null | undefined,
  agent: AgentName
): ResolvedAgentCatalog {
  const cap: AgentCapability | undefined = node?.capabilities?.agents?.[agent];
  const models = Array.isArray(cap?.models) ? cap.models : [];
  const status = cap?.catalog_status ?? (models.length > 0 ? "ready" : "fallback");
  const rawDefaultModel = cap?.default_model?.trim() ?? "";
  const rawDefaultEffort = (cap?.default_effort ?? "") as EffortLevel;
  const defaultModel = rawDefaultModel || (agent === "agy" ? DEFAULT_AGY_MODEL : "");
  const defaultEffort = rawDefaultEffort || (agent === "agy" ? DEFAULT_AGY_EFFORT : "");
  const allowManual = !node || node.status === "offline" || status !== "ready" || models.length === 0;

  return {
    status,
    models,
    defaultModel,
    defaultEffort,
    allowManual
  };
}

export function resolveInitialComposerModelAndEffort(
  node: NodeRecord | null | undefined,
  agent: AgentName
): { model: string; effort: EffortLevel } {
  const catalog = resolveAgentCatalog(node, agent);
  if (catalog.models.length === 0) {
    return { model: "", effort: "" };
  }
  const normalizedDefault = normalizeModelLookupId(agent, catalog.defaultModel, catalog.models);
  const model = catalog.models.some((m) => m.id === normalizedDefault)
    ? normalizedDefault
    : (catalog.models[0]?.id ?? "");
  const effortState = resolveEffortState(node, agent, model);
  return {
    model,
    effort: effortState.supportsEffort ? (effortState.defaultEffort || "") : ""
  };
}

function normalizeModelLookupId(agent: AgentName, modelId: string, models: ModelCapability[]): string {
  const trimmed = modelId.trim();
  if (!trimmed) return "";
  if (agent === "agy") {
    const aliasTarget = AGY_ALIAS_TO_STEM[trimmed.toLowerCase()];
    if (aliasTarget && models.some((m) => m.id === aliasTarget)) {
      return aliasTarget;
    }
  }
  return trimmed;
}

export function resolveEffortState(
  node: NodeRecord | null | undefined,
  agent: AgentName,
  modelId: string
): ResolvedEffortState {
  const catalog = resolveAgentCatalog(node, agent);
  const rawId = modelId.trim() || catalog.defaultModel;
  const lookupId = normalizeModelLookupId(agent, rawId, catalog.models);
  const matched = lookupId ? catalog.models.find((m) => m.id === lookupId) : undefined;

  if (matched) {
    const efforts = Array.isArray(matched.efforts) ? matched.efforts : [];
    if (efforts.length === 0) {
      return {
        supportsEffort: false,
        efforts: [],
        defaultEffort: ""
      };
    }
    const preferred =
      (matched.default_effort && efforts.includes(matched.default_effort) && matched.default_effort) ||
      (catalog.defaultEffort && efforts.includes(catalog.defaultEffort) && catalog.defaultEffort) ||
      efforts[0] ||
      "";
    return {
      supportsEffort: true,
      efforts,
      defaultEffort: preferred
    };
  }

  if (agent === "agy" && lookupId.toLowerCase().includes("orchestrator")) {
    return {
      supportsEffort: false,
      efforts: [],
      defaultEffort: ""
    };
  }

  const fallbackEfforts = FALLBACK_EFFORTS_BY_AGENT[agent] ?? [];
  const fallbackDefault =
    catalog.defaultEffort && fallbackEfforts.includes(catalog.defaultEffort)
      ? catalog.defaultEffort
      : "";
  return {
    supportsEffort: fallbackEfforts.length > 0,
    efforts: fallbackEfforts,
    defaultEffort: fallbackDefault
  };
}

export function reconcileComposerDraft(
  composer: ComposerDraft,
  node: NodeRecord | null | undefined,
  isReplyMode: boolean
): Partial<ComposerDraft> | null {
  let nextAgent = composer.agent;
  let nextModel = composer.model;
  let nextEffort = composer.effort;

  if (!isReplyMode && node) {
    const availableAgents = getAvailableAgents(node);
    if (!availableAgents.includes(nextAgent)) {
      nextAgent = availableAgents[0] ?? nextAgent;
      const initial = resolveInitialComposerModelAndEffort(node, nextAgent);
      nextModel = initial.model;
      nextEffort = initial.effort;
    }
  }

  const catalog = resolveAgentCatalog(node, nextAgent);
  if (nextAgent === "agy" && catalog.models.length > 0 && nextModel.trim() !== "") {
    const stem = AGY_ALIAS_TO_STEM[nextModel.trim().toLowerCase()];
    if (stem && catalog.models.some((m) => m.id === stem)) {
      nextModel = stem;
    }
  }

  const effortState = resolveEffortState(node, nextAgent, nextModel);
  if (!effortState.supportsEffort) {
    nextEffort = "";
  } else if (nextEffort !== "" && !effortState.efforts.includes(nextEffort)) {
    nextEffort = effortState.defaultEffort || effortState.efforts[0] || "";
  }

  const patch: Partial<ComposerDraft> = {};
  if (nextAgent !== composer.agent) patch.agent = nextAgent;
  if (nextModel !== composer.model) patch.model = nextModel;
  if (nextEffort !== composer.effort) patch.effort = nextEffort;

  return Object.keys(patch).length > 0 ? patch : null;
}

const GENERIC_CHANNEL_SEGMENTS = new Set([
  "proj",
  "project",
  "projects",
  "repo",
  "repos",
  "ops",
  "team",
  "teams",
  "general",
  "default",
  "misc"
]);

export function extractBoardTopicWorkspaceCandidates(
  topic: Pick<BoardTopic, "channel" | "latest_handoff"> | null | undefined
): string[] {
  if (!topic) return [];
  const out: string[] = [];
  const push = (raw?: string | null) => {
    const trimmed = (raw ?? "").trim().replace(/^\/+|\/+$/g, "");
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (!GENERIC_CHANNEL_SEGMENTS.has(lower) && !out.includes(lower)) {
      out.push(lower);
    }
  };

  const repoRaw = topic.latest_handoff?.data?.repo;
  if (typeof repoRaw === "string" && repoRaw.trim()) {
    const repoClean = repoRaw.trim().replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
    const parts = repoClean.split("/").filter(Boolean);
    if (parts.length > 0) {
      push(parts[parts.length - 1]);
    }
    push(repoClean);
  }

  const channelParts = (topic.channel || "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = channelParts.length - 1; i >= 0; i -= 1) {
    push(channelParts[i]);
  }
  return out;
}

export function matchWorkspacePathForTopic(
  node: NodeRecord | null | undefined,
  topic: Pick<BoardTopic, "channel" | "latest_handoff"> | null | undefined
): string | null {
  if (!node || !node.workspaces || node.workspaces.length === 0) return null;
  const candidates = extractBoardTopicWorkspaceCandidates(topic);
  if (candidates.length === 0) return null;

  const normalized = node.workspaces.map((ws) => {
    const cleanPath = ws.path.replace(/[\\/]+$/, "");
    const segs = cleanPath.split(/[\\/]/).filter(Boolean);
    return {
      path: ws.path,
      key: (ws.key || "").trim().toLowerCase(),
      basename: (segs[segs.length - 1] ?? "").toLowerCase(),
      lowerPath: cleanPath.replace(/\\/g, "/").toLowerCase()
    };
  });

  for (const cand of candidates) {
    const exact = normalized.find((ws) => ws.key === cand || ws.basename === cand);
    if (exact) return exact.path;
  }

  for (const cand of candidates) {
    if (!cand.includes("/")) continue;
    const suffix = `/${cand}`;
    const bySuffix = normalized.find((ws) => ws.lowerPath.endsWith(suffix));
    if (bySuffix) return bySuffix.path;
  }

  return null;
}

export function resolveBoardTopicDispatchTarget(
  nodes: NodeRecord[],
  topic: Pick<BoardTopic, "channel" | "latest_handoff"> | null | undefined,
  preferredNodeId?: string | null
): { node: NodeRecord | null; workdir: string; matchedWorkspace: boolean } {
  if (nodes.length === 0) {
    return { node: null, workdir: "", matchedWorkspace: false };
  }
  const onlineNodes = nodes.filter((n) => n.status === "online");
  const pool = onlineNodes.length > 0 ? onlineNodes : nodes;

  const preferredNode = preferredNodeId
    ? nodes.find((n) => n.id === preferredNodeId) ?? null
    : null;
  const handoffNode = topic?.latest_handoff?.source_node
    ? nodes.find((n) => n.id === topic.latest_handoff?.source_node) ?? null
    : null;

  const orderedNodes: NodeRecord[] = [];
  for (const n of [preferredNode, handoffNode, ...pool, ...nodes]) {
    if (n && !orderedNodes.some((x) => x.id === n.id)) {
      orderedNodes.push(n);
    }
  }

  for (const n of orderedNodes) {
    if (onlineNodes.length > 0 && n.status !== "online") continue;
    const matched = matchWorkspacePathForTopic(n, topic);
    if (matched) {
      return { node: n, workdir: matched, matchedWorkspace: true };
    }
  }

  const fallbackNode =
    (preferredNode && (onlineNodes.length === 0 || preferredNode.status === "online")
      ? preferredNode
      : null) ??
    (handoffNode && (onlineNodes.length === 0 || handoffNode.status === "online")
      ? handoffNode
      : null) ??
    pool[0] ??
    null;

  return {
    node: fallbackNode,
    workdir: fallbackNode?.workspaces[0]?.path ?? "",
    matchedWorkspace: false
  };
}
