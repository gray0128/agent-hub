import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { RunEventItem, RunRecord } from "@/types";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDurationMs(ms?: number): string {
  if (!ms || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return `${min}m ${rem}s`;
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatShortTime(iso?: string | null): string {
  if (!iso) return "--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function splitModelAndEffort(rawModel: string, rawEffort: string): { model: string; effort: string } {
  let model = rawModel.trim();
  let effort = rawEffort.trim();
  const atIdx = model.lastIndexOf("@");
  if (atIdx > 0 && atIdx < model.length - 1) {
    if (!effort) {
      effort = model.slice(atIdx + 1).trim();
    }
    model = model.slice(0, atIdx).trim();
  }
  return { model, effort };
}

const AGY_EFFORT_SUFFIXES = ["-xhigh", "-medium", "-low", "-high", "-max"];

function splitAgyEffortSuffix(modelId: string): {
  stem: string;
  effort: string;
  hasSuffix: boolean;
} {
  const trimmed = modelId.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || lower.includes("orchestrator")) {
    return { stem: trimmed, effort: "", hasSuffix: false };
  }
  for (const suf of AGY_EFFORT_SUFFIXES) {
    if (lower.endsWith(suf) && trimmed.length > suf.length) {
      return {
        stem: trimmed.slice(0, trimmed.length - suf.length),
        effort: suf.slice(1),
        hasSuffix: true
      };
    }
  }
  return { stem: trimmed, effort: "", hasSuffix: false };
}

function resolveKnownAgyFamily(raw: string): { base: string; supportsXHigh: boolean } | null {
  switch (raw.trim().toLowerCase()) {
    case "carbon":
    case "gemini-4-carbon":
      return { base: "gemini-4-carbon", supportsXHigh: false };
    case "argon":
    case "gemini-4-argon":
      return { base: "gemini-4-argon", supportsXHigh: false };
    case "hydrogen":
    case "gemini-4-hydrogen":
      return { base: "gemini-4-hydrogen", supportsXHigh: true };
    case "flash":
    case "gemini-3.8-flash":
      return { base: "gemini-3.8-flash", supportsXHigh: false };
    case "opus":
    case "claude-opus-5-5":
      return { base: "claude-opus-5-5", supportsXHigh: false };
    case "sonnet":
    case "claude-sonnet-5-5":
      return { base: "claude-sonnet-5-5", supportsXHigh: false };
    default:
      return null;
  }
}

function expandAgyModel(modelAlias: string, effort: string): { model: string; effort: string } {
  const { model, effort: eff } = splitModelAndEffort(modelAlias, effort);
  if (!model) return { model: "", effort: eff };
  if (model.toLowerCase().includes("orchestrator")) {
    return { model, effort: "" };
  }

  const known = resolveKnownAgyFamily(model);
  if (known) {
    const suffixEffort = eff && eff !== "auto" ? eff : "high";
    const mappedSuffix =
      !known.supportsXHigh && (suffixEffort === "xhigh" || suffixEffort === "max")
        ? "high"
        : suffixEffort;
    return { model: `${known.base}-${mappedSuffix}`, effort: eff };
  }

  const split = splitAgyEffortSuffix(model);
  if (split.hasSuffix) {
    if (!eff || eff === "auto") return { model, effort: eff };
    const stemKnown = resolveKnownAgyFamily(split.stem);
    const mappedSuffix =
      stemKnown && !stemKnown.supportsXHigh && (eff === "xhigh" || eff === "max") ? "high" : eff;
    return { model: `${split.stem}-${mappedSuffix}`, effort: eff };
  }

  if (eff && eff !== "off" && eff !== "auto") {
    return { model: `${model}-${eff}`, effort: eff };
  }
  return { model, effort: eff };
}

export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[a-zA-Z0-9._/:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function compactPromptInline(prompt: string, maxLen = 72): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (!oneLine) return "<prompt>";
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen)}...`;
}

export function buildRunCliPreview(
  run: RunRecord,
  fallbackSessionId?: string | null
): { shortText: string; fullCommand: string } {
  const rawModel = run.model || run.resolved_model || "";
  const rawEffort = run.effort || run.resolved_effort || "";
  const { model, effort } = splitModelAndEffort(rawModel, rawEffort);
  const nativeSession = (run.native_session_id || fallbackSessionId || "").trim();
  const promptFull = (run.prompt || "").trim() || "<prompt>";
  const promptShort = compactPromptInline(promptFull, 60);

  const buildParts = (promptText: string): string => {
    const args: string[] = [run.agent];
    switch (run.agent) {
      case "agy": {
        const expanded = expandAgyModel(model || "gemini-4-hydrogen-high", effort);
        args.push("--output-format", "json");
        args.push(run.sandbox ? "--sandbox" : "--dangerously-skip-permissions");
        if (expanded.model) args.push("--model", expanded.model);
        if (expanded.effort && expanded.effort !== "auto") args.push("--effort", expanded.effort);
        if (run.timeout_sec > 0) args.push("--print-timeout", `${run.timeout_sec}s`);
        if (nativeSession) args.push("--conversation", nativeSession);
        args.push(`-p=${promptText}`);
        break;
      }
      case "pi":
        args.push("--mode", "json", "-p");
        if (!run.sandbox) args.push("--approve");
        if (model) args.push("--model", model);
        if (effort && effort !== "auto") args.push("--thinking", effort);
        if (nativeSession) args.push("--session", nativeSession);
        args.push(promptText);
        break;
      case "omp":
        args.push("--mode=json", "-p", "--auto-approve");
        if (run.timeout_sec > 0) args.push(`--max-time=${run.timeout_sec}`);
        if (model) args.push(`--model=${model}`);
        if (effort && effort !== "auto") args.push(`--thinking=${effort}`);
        if (nativeSession) args.push(`--resume=${nativeSession}`);
        args.push(promptText);
        break;
      case "codex":
        if (nativeSession) {
          args.push("exec", "resume", "--json");
          if (model) args.push("-m", model);
          if (effort && effort !== "auto") args.push("-c", `model_reasoning_effort="${effort}"`);
          args.push(nativeSession, "-");
        } else {
          args.push("exec", "--json");
          if (model) args.push("-m", model);
          if (effort && effort !== "auto") args.push("-c", `model_reasoning_effort="${effort}"`);
          if (run.sandbox) {
            args.push("-s", "workspace-write");
          } else {
            args.push("--dangerously-bypass-approvals-and-sandbox");
          }
          args.push("-");
        }
        break;
      case "claude":
        args.push("-p", "--output-format", "json");
        if (!run.sandbox) args.push("--dangerously-skip-permissions");
        if (model) args.push("--model", model);
        if (effort && effort !== "auto" && effort !== "off") args.push("--effort", effort);
        if (nativeSession) args.push("--session-id", nativeSession);
        args.push(promptText);
        break;
    }

    const quoted = args.map(shellQuote).join(" ");
    const execLine =
      run.agent === "codex" ? `printf '%s' ${shellQuote(promptText)} | ${quoted}` : quoted;
    return run.workdir ? `cd ${shellQuote(run.workdir)} && ${execLine}` : execLine;
  };

  return {
    shortText: buildParts(promptShort),
    fullCommand: buildParts(promptFull)
  };
}

export type EventTone = "neutral" | "running" | "warn" | "approval" | "done";

function asNonEmptyStr(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  return trimmed ? trimmed : null;
}

export function summarizeRunEvent(ev: RunEventItem): {
  badge: string;
  tone: EventTone;
  summary: string;
} {
  const p = ev.payload ?? {};
  switch (ev.kind) {
    case "tool_use": {
      const toolName =
        asNonEmptyStr(p.tool) ??
        asNonEmptyStr(p.name) ??
        asNonEmptyStr(p.tool_name) ??
        asNonEmptyStr(p.kind) ??
        "tool";
      const detail =
        asNonEmptyStr(p.command) ??
        asNonEmptyStr(p.path) ??
        asNonEmptyStr(p.file) ??
        asNonEmptyStr(p.summary) ??
        asNonEmptyStr(p.message) ??
        asNonEmptyStr(p.stage) ??
        (typeof p.seq === "number" ? `seq=${p.seq}` : null);
      return {
        badge: toolName,
        tone: "running",
        summary: detail ?? compactObjectSummary(p)
      };
    }
    case "stderr_warn": {
      const line = asNonEmptyStr(p.line) ?? asNonEmptyStr(p.message) ?? asNonEmptyStr(p.error);
      return {
        badge: "stderr",
        tone: "warn",
        summary: line ?? compactObjectSummary(p)
      };
    }
    case "approval_needed": {
      const url = asNonEmptyStr(p.remote_control_url) ?? asNonEmptyStr(p.url);
      return {
        badge: "审批",
        tone: "approval",
        summary: url ? `等待远程放行 (${url})` : "等待人工审批放行"
      };
    }
    case "turn_end": {
      const msg = typeof p.message === "object" && p.message !== null ? (p.message as Record<string, unknown>) : null;
      const model =
        asNonEmptyStr(p.resolved_model) ??
        asNonEmptyStr(p.model) ??
        (msg ? asNonEmptyStr(msg.model) : null);
      return {
        badge: "轮次结束",
        tone: "done",
        summary: model ? `model: ${model}` : compactObjectSummary(p)
      };
    }
    case "system": {
      const msg = asNonEmptyStr(p.message) ?? asNonEmptyStr(p.stage) ?? asNonEmptyStr(p.status);
      return {
        badge: "系统",
        tone: "neutral",
        summary: msg ?? compactObjectSummary(p)
      };
    }
    case "status":
    default: {
      const stage =
        asNonEmptyStr(p.stage) ??
        asNonEmptyStr(p.status) ??
        asNonEmptyStr(p.type) ??
        "状态";
      const model = asNonEmptyStr(p.resolved_model) ?? asNonEmptyStr(p.model);
      const sessionId = asNonEmptyStr(p.session_id) ?? asNonEmptyStr(p.conversation_id);
      const extras = [model && `model=${model}`, sessionId && `session=${sessionId.slice(0, 12)}`].filter(Boolean);
      return {
        badge: stage,
        tone: stage === "agent_end" || stage === "resumed" ? "done" : "neutral",
        summary: extras.length > 0 ? extras.join(" · ") : compactObjectSummary(p)
      };
    }
  }
}

function compactObjectSummary(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj)
    .filter(([k]) => !["type", "event", "kind"].includes(k))
    .slice(0, 3)
    .map(([k, v]) => {
      if (typeof v === "string") return `${k}=${v}`;
      if (typeof v === "number" || typeof v === "boolean") return `${k}=${String(v)}`;
      return `${k}=…`;
    });
  return entries.length > 0 ? entries.join(" · ") : "{}";
}

export function formatLeaseRemainingSec(leaseExpiresAt: string | null, nowMs = Date.now()): string | null {
  if (!leaseExpiresAt) return null;
  const expiresMs = Date.parse(leaseExpiresAt);
  if (Number.isNaN(expiresMs)) return null;
  const diffSec = Math.max(0, Math.ceil((expiresMs - nowMs) / 1000));
  return `${diffSec}s`;
}

export function formatNotifyBadgeMeta(
  status: RunRecord["notify_status"],
  webhookArmed?: boolean
): { label: string; tone: "neutral" | "done" | "failed" | "running" } | null {
  if (status === "sent") return { label: "通知: 已发送", tone: "done" };
  if (status === "queued") return { label: "通知: 队列投递中", tone: "running" };
  if (status === "failed") return { label: "通知: 发送失败", tone: "failed" };
  if (webhookArmed) return { label: "通知: Webhook 已挂载", tone: "running" };
  return null;
}
