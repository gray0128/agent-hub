import { create } from "zustand";
import type { AgentName, EffortLevel } from "@/types";

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
