import { create } from "zustand";
import type { AgentName, EffortLevel } from "@/types";

export type ThemeMode = "dark" | "light";
export type AuthStatus = "checking" | "authenticated" | "unauthenticated";
export type InspectorTab = "events" | "queue" | "lineage" | "control";
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
  streamStatus: StreamStatus;
  activeTab: InspectorTab;
  threadQuery: string;
  onboardingOpen: boolean;
  keysDialogOpen: boolean;
  mobileLeftOpen: boolean;
  mobileRightOpen: boolean;
  errorBanner: string | null;
  composer: ComposerDraft;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setToken: (token: string) => void;
  setAuthState: (authStatus: AuthStatus, authKind?: string | null) => void;
  setStreamStatus: (status: StreamStatus) => void;
  setActiveTab: (tab: InspectorTab) => void;
  setThreadQuery: (q: string) => void;
  setOnboardingOpen: (open: boolean) => void;
  setKeysDialogOpen: (open: boolean) => void;
  setMobileLeftOpen: (open: boolean) => void;
  setMobileRightOpen: (open: boolean) => void;
  setErrorBanner: (msg: string | null) => void;
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
  streamStatus: "connecting",
  activeTab: "events",
  threadQuery: "",
  onboardingOpen: false,
  keysDialogOpen: false,
  mobileLeftOpen: false,
  mobileRightOpen: false,
  errorBanner: null,
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
    set({ token: token.trim(), authStatus: "checking", authKind: null, errorBanner: null });
  },
  setAuthState: (authStatus, authKind = null) => set({ authStatus, authKind }),
  setStreamStatus: (streamStatus) => set({ streamStatus }),
  setActiveTab: (activeTab) => set({ activeTab }),
  setThreadQuery: (threadQuery) => set({ threadQuery }),
  setOnboardingOpen: (onboardingOpen) => set({ onboardingOpen }),
  setKeysDialogOpen: (keysDialogOpen) => set({ keysDialogOpen }),
  setMobileLeftOpen: (mobileLeftOpen) => set({ mobileLeftOpen }),
  setMobileRightOpen: (mobileRightOpen) => set({ mobileRightOpen }),
  setErrorBanner: (errorBanner) => set({ errorBanner }),
  patchComposer: (patch) =>
    set((state) => ({
      composer: { ...state.composer, ...patch }
    }))
}));
