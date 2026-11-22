import { create } from "zustand";
import type { AgentName, EffortLevel, RunRecord } from "@/types";

export const MAX_LABEL_FILTERS = 8;
export const LABEL_KEY_RE = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
export const LABEL_VALUE_RE = /^[^\u0000-\u001f\u007f]*$/;

export function parseLabelFilterKv(
  raw: string
): { ok: true; kv: string; key: string; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "标签筛选格式须为 key=value" };
  }
  const eqIdx = raw.indexOf("=");
  if (eqIdx <= 0) {
    return { ok: false, error: "标签筛选格式须为 key=value" };
  }
  const key = raw.slice(0, eqIdx);
  const value = raw.slice(eqIdx + 1);
  if (!LABEL_KEY_RE.test(key)) {
    return { ok: false, error: "标签键须为 1-64 位小写字母、数字或 . _ / -" };
  }
  if ([...value].length > 128 || !LABEL_VALUE_RE.test(value)) {
    return { ok: false, error: "标签值须 <= 128 字符且不含控制字符" };
  }
  return { ok: true, kv: `${key}=${value}`, key, value };
}

export function runMatchesLabelFilters(run: RunRecord, filters: string[]): boolean {
  if (filters.length === 0) return true;
  if (!run.labels) return false;
  for (const kv of filters) {
    const eqIdx = kv.indexOf("=");
    if (eqIdx <= 0) return false;
    const key = kv.slice(0, eqIdx);
    const value = kv.slice(eqIdx + 1);
    if (run.labels[key] !== value) return false;
  }
  return true;
}

export type ThemeMode = "dark" | "light";
export type AuthStatus = "checking" | "authenticated" | "unauthenticated";
export type AuthScope = "admin" | "client" | "node";
export type WorkspaceMode = "board" | "inbox" | "runs";
export type LeftRailTab = "threads" | "native" | "nodes";
export type CenterPaneMode = "controlled" | "native";
export type InspectorTab = "events" | "queue" | "lineage" | "control" | "deliveries";
export type StreamStatus = "connecting" | "connected" | "disconnected";

export interface ComposerDraft {
  mode: "new" | "reply";
  nodeId: string;
  workdir: string;
  agent: AgentName;
  model: string;
  effort: EffortLevel;
  sandbox: boolean;
  notifyTarget: "none" | "webhook" | "grok";
  boardTopicId: string | null;
  prompt: string;
}

interface WorkbenchState {
  theme: ThemeMode;
  token: string;
  authStatus: AuthStatus;
  authKind: string | null;
  authScope: AuthScope | null;
  streamStatus: StreamStatus;
  workspaceMode: WorkspaceMode;
  selectedInboxItemKey: string | null;
  leftTab: LeftRailTab;
  centerMode: CenterPaneMode;
  activeTab: InspectorTab;
  threadQuery: string;
  labelFilters: string[];
  onboardingOpen: boolean;
  keysDialogOpen: boolean;
  browserNotifyOpen: boolean;
  mobileLeftOpen: boolean;
  mobileRightOpen: boolean;
  boardMobileLeftOpen: boolean;
  boardMobileRightOpen: boolean;
  boardMobileShowDetail: boolean;
  errorBanner: string | null;
  composerNotice: string | null;
  composer: ComposerDraft;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setToken: (token: string) => void;
  setAuthState: (authStatus: AuthStatus, authKind?: string | null, authScope?: AuthScope | null) => void;
  setStreamStatus: (status: StreamStatus) => void;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
  setSelectedInboxItemKey: (key: string | null) => void;
  setLeftTab: (tab: LeftRailTab) => void;
  setCenterMode: (mode: CenterPaneMode) => void;
  setActiveTab: (tab: InspectorTab) => void;
  setThreadQuery: (q: string) => void;
  setLabelFilters: (filters: string[]) => void;
  addLabelFilter: (kv: string) => void;
  removeLabelFilter: (kv: string) => void;
  clearLabelFilters: () => void;
  setOnboardingOpen: (open: boolean) => void;
  setKeysDialogOpen: (open: boolean) => void;
  setBrowserNotifyOpen: (open: boolean) => void;
  setMobileLeftOpen: (open: boolean) => void;
  setMobileRightOpen: (open: boolean) => void;
  setBoardMobileLeftOpen: (open: boolean) => void;
  setBoardMobileRightOpen: (open: boolean) => void;
  setBoardMobileShowDetail: (show: boolean) => void;
  setErrorBanner: (msg: string | null) => void;
  setComposerNotice: (msg: string | null) => void;
  patchComposer: (patch: Partial<ComposerDraft>) => void;
}

function readInitialTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem("ahub-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // ignore storage restriction
  }
  return "dark";
}

function readInitialToken(): string {
  try {
    const url = new URL(window.location.href);
    const paramToken = url.searchParams.get("token");
    if (paramToken && paramToken.trim()) {
      localStorage.setItem("ahub-token", paramToken.trim());
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
      return paramToken.trim();
    }
    return localStorage.getItem("ahub-token") ?? "";
  } catch {
    return "";
  }
}

function applyThemeToDom(theme: ThemeMode): void {
  try {
    localStorage.setItem("ahub-theme", theme);
  } catch {
    // ignore
  }
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  theme: readInitialTheme(),
  token: readInitialToken(),
  authStatus: "checking",
  authKind: null,
  authScope: null,
  streamStatus: "connecting",
  workspaceMode: "board",
  selectedInboxItemKey: null,
  leftTab: "threads",
  centerMode: "controlled",
  activeTab: "events",
  threadQuery: "",
  labelFilters: [],
  onboardingOpen: false,
  keysDialogOpen: false,
  browserNotifyOpen: false,
  mobileLeftOpen: false,
  mobileRightOpen: false,
  boardMobileLeftOpen: false,
  boardMobileRightOpen: false,
  boardMobileShowDetail: false,
  errorBanner: null,
  composerNotice: null,
  composer: {
    mode: "reply",
    nodeId: "",
    workdir: "",
    agent: "agy",
    model: "",
    effort: "",
    sandbox: true,
    notifyTarget: "none",
    boardTopicId: null,
    prompt: ""
  },

  setTheme: (theme) => {
    applyThemeToDom(theme);
    set({ theme });
  },
  toggleTheme: () =>
    set((state) => {
      const next: ThemeMode = state.theme === "dark" ? "light" : "dark";
      applyThemeToDom(next);
      return { theme: next };
    }),
  setToken: (token) => {
    try {
      localStorage.setItem("ahub-token", token.trim());
    } catch {
      // ignore
    }
    set({ token: token.trim(), authStatus: "checking", authKind: null, authScope: null, errorBanner: null });
  },
  setAuthState: (authStatus, authKind = null, authScope = null) =>
    set({ authStatus, authKind, authScope }),
  setStreamStatus: (streamStatus) => set({ streamStatus }),
  setWorkspaceMode: (workspaceMode) => set({ workspaceMode }),
  setSelectedInboxItemKey: (selectedInboxItemKey) => set({ selectedInboxItemKey }),
  setLeftTab: (leftTab) => set({ leftTab }),
  setCenterMode: (centerMode) => set({ centerMode }),
  setActiveTab: (activeTab) => set({ activeTab }),
  setThreadQuery: (threadQuery) => set({ threadQuery }),
  setLabelFilters: (filters) => {
    const normalized: string[] = [];
    for (const item of filters) {
      const parsed = parseLabelFilterKv(item);
      if (parsed.ok && !normalized.includes(parsed.kv)) {
        normalized.push(parsed.kv);
        if (normalized.length >= MAX_LABEL_FILTERS) break;
      }
    }
    set({ labelFilters: normalized });
  },
  addLabelFilter: (kv) =>
    set((state) => {
      const parsed = parseLabelFilterKv(kv);
      if (!parsed.ok) return state;
      if (state.labelFilters.includes(parsed.kv)) return state;
      if (state.labelFilters.length >= MAX_LABEL_FILTERS) return state;
      return { labelFilters: [...state.labelFilters, parsed.kv] };
    }),
  removeLabelFilter: (kv) =>
    set((state) => {
      const parsed = parseLabelFilterKv(kv);
      const target = parsed.ok ? parsed.kv : kv;
      const next = state.labelFilters.filter((item) => item !== target);
      if (next.length === state.labelFilters.length) return state;
      return { labelFilters: next };
    }),
  clearLabelFilters: () => set({ labelFilters: [] }),
  setOnboardingOpen: (onboardingOpen) => set({ onboardingOpen }),
  setKeysDialogOpen: (keysDialogOpen) => set({ keysDialogOpen }),
  setBrowserNotifyOpen: (browserNotifyOpen) => set({ browserNotifyOpen }),
  setMobileLeftOpen: (mobileLeftOpen) => set({ mobileLeftOpen }),
  setMobileRightOpen: (mobileRightOpen) => set({ mobileRightOpen }),
  setBoardMobileLeftOpen: (boardMobileLeftOpen) => set({ boardMobileLeftOpen }),
  setBoardMobileRightOpen: (boardMobileRightOpen) => set({ boardMobileRightOpen }),
  setBoardMobileShowDetail: (boardMobileShowDetail) => set({ boardMobileShowDetail }),
  setErrorBanner: (errorBanner) => set({ errorBanner }),
  setComposerNotice: (composerNotice) => set({ composerNotice }),
  patchComposer: (patch) =>
    set((state) => ({
      composer: { ...state.composer, ...patch }
    }))
}));
