import type { ComposerDraft } from "@/stores/workbench-store";
import type { AgentCapability, AgentName, EffortLevel, ModelCapability, NodeRecord } from "@/types";

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
