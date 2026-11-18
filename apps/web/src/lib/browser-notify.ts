import { apiClient } from "@/lib/api-client";
import type {
  NativeEventKind,
  PushConfigRecord,
  PushEventFilterKey,
  RunStatus,
  WebPushSubscriptionRecord
} from "@/types";

export const DEFAULT_PUSH_EVENT_FILTER: PushEventFilterKey[] = [
  "run_needs_approval",
  "run_failed",
  "native_interaction_needed"
];

export const PUSH_EVENT_FILTER_OPTIONS: Array<{
  key: PushEventFilterKey;
  label: string;
  description: string;
}> = [
  {
    key: "native_interaction_needed",
    label: "原生待互动确认",
    description: "本机终端触发 interaction_needed 时推送"
  },
  {
    key: "run_needs_approval",
    label: "受控任务待审批",
    description: "受控执行进入 needs_approval 时推送"
  },
  {
    key: "run_failed",
    label: "受控任务失败",
    description: "受控任务执行失败时推送"
  },
  {
    key: "native_turn_summary",
    label: "原生回合总结",
    description: "本机终端完成一轮对话总结时推送"
  },
  {
    key: "native_progress",
    label: "原生阶段里程碑",
    description: "本机终端主动汇报阶段里程碑时推送"
  },
  {
    key: "run_done",
    label: "受控任务完成",
    description: "受控任务正常结束时推送"
  },
  {
    key: "run_cancelled",
    label: "受控任务已取消",
    description: "受控任务被取消时推送"
  }
];

export const IN_PAGE_FALLBACK_STORAGE_KEY = "ahub-in-page-notify-enabled";

export interface BrowserNotifyHealth {
  status: "active" | "in_page_only" | "denied";
  label: string;
  detail: string;
  pushSupported: boolean;
  standaloneRequired: boolean;
  permission: NotificationPermission | "unsupported";
}

const NOTIFY_CHANNEL_NAME = "ahub-notify-dedup";
const MAX_DEDUP_KEYS = 500;
const seenInPageKeys = new Set<string>();
let broadcastChannel: BroadcastChannel | null = null;

function ensureBroadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel !== "function") {
    return null;
  }
  if (!broadcastChannel) {
    try {
      broadcastChannel = new BroadcastChannel(NOTIFY_CHANNEL_NAME);
      broadcastChannel.addEventListener("message", (evt: MessageEvent) => {
        const data = evt.data as { type?: string; eventKey?: string } | null;
        if (data?.type === "notified" && typeof data.eventKey === "string") {
          rememberSeenKey(data.eventKey);
        }
      });
    } catch {
      return null;
    }
  }
  return broadcastChannel;
}

export function initBrowserNotifyCoordinator(): void {
  ensureBroadcastChannel();
}

if (typeof window !== "undefined" && typeof BroadcastChannel === "function") {
  ensureBroadcastChannel();
}

function rememberSeenKey(eventKey: string): void {
  if (seenInPageKeys.has(eventKey)) return;
  seenInPageKeys.add(eventKey);
  if (seenInPageKeys.size > MAX_DEDUP_KEYS) {
    const oldest = seenInPageKeys.values().next().value;
    if (typeof oldest === "string") {
      seenInPageKeys.delete(oldest);
    }
  }
}

export function readInPageFallbackPref(): boolean {
  try {
    const val = localStorage.getItem(IN_PAGE_FALLBACK_STORAGE_KEY);
    return val === null ? true : val === "true";
  } catch {
    return true;
  }
}

export function writeInPageFallbackPref(enabled: boolean): void {
  try {
    localStorage.setItem(IN_PAGE_FALLBACK_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // ignore storage errors
  }
}

export function suggestDeviceLabel(): string {
  if (typeof navigator === "undefined") return "当前浏览器";
  const ua = navigator.userAgent;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Mac OS X|Macintosh/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "Browser";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Web";
  return `${os} ${browser}`;
}

export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function computeEndpointSha256Prefix(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex.slice(0, 12);
}

export async function getCurrentDevicePushInfo(): Promise<{
  endpoint: string;
  endpointSha256Prefix: string;
} | null> {
  if (
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator) ||
    typeof window === "undefined" ||
    !("PushManager" in window)
  ) {
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    if (!reg) return null;
    const sub = await reg.pushManager.getSubscription();
    if (!sub || !sub.endpoint) return null;
    const endpointSha256Prefix = await computeEndpointSha256Prefix(sub.endpoint);
    return { endpoint: sub.endpoint, endpointSha256Prefix };
  } catch {
    return null;
  }
}

export function detectBrowserNotifyHealth(opts: {
  pushConfig: PushConfigRecord | null;
  subscriptions: WebPushSubscriptionRecord[];
  localEndpointSha256Prefix: string | null;
}): BrowserNotifyHealth {
  const permission: NotificationPermission | "unsupported" =
    typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  const pushSupported =
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const isIos = /iPad|iPhone|iPod/.test(ua);
  const isStandalone =
    typeof window !== "undefined" &&
    (Boolean(window.matchMedia?.("(display-mode: standalone)")?.matches) ||
      (typeof navigator !== "undefined" &&
        (navigator as { standalone?: boolean }).standalone === true));
  const standaloneRequired = isIos && !isStandalone;

  if (permission === "denied") {
    return {
      status: "denied",
      label: "浏览器权限已拒绝",
      detail: "浏览器通知权限已被拒绝，请在浏览器站点设置中重新允许通知后刷新页面。",
      pushSupported,
      standaloneRequired,
      permission
    };
  }

  const matchedSub = opts.localEndpointSha256Prefix
    ? opts.subscriptions.find(
        (s) =>
          s.endpoint_sha256_prefix === opts.localEndpointSha256Prefix &&
          s.enabled &&
          s.revoked_at === null
      )
    : undefined;

  if (permission === "granted" && opts.pushConfig?.enabled && matchedSub) {
    return {
      status: "active",
      label: "Web Push 已激活（离线可达）",
      detail: `当前设备已绑定为「${matchedSub.label}」，标签页关闭或后台挂起时仍可送达系统通知。`,
      pushSupported,
      standaloneRequired,
      permission
    };
  }

  let detail = "当前仅在页面打开期间提供页内浏览器提醒。";
  if (opts.pushConfig && !opts.pushConfig.enabled) {
    detail = "服务端尚未配置 VAPID 密钥（VAPID_NOT_CONFIGURED），当前降级为页内提醒。";
  } else if (standaloneRequired) {
    detail = "iOS Safari 需先点击「分享 -> 添加到主屏幕」并在主屏幕应用内打开，才支持离线 Web Push。";
  } else if (!pushSupported) {
    detail = "当前浏览器环境不支持 Service Worker / PushManager，将使用页内提醒降级通道。";
  } else {
    detail = "点击下方「开启本设备浏览器通知」即可注册 Service Worker 与 Web Push 离线推送。";
  }

  return {
    status: "in_page_only",
    label: "仅页内提醒",
    detail,
    pushSupported,
    standaloneRequired,
    permission
  };
}

function extractSubscriptionPayload(sub: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  const p256dhBuf = sub.getKey ? sub.getKey("p256dh") : null;
  const authBuf = sub.getKey ? sub.getKey("auth") : null;
  if (p256dhBuf && authBuf) {
    return {
      endpoint: sub.endpoint,
      keys: {
        p256dh: uint8ArrayToBase64Url(new Uint8Array(p256dhBuf)),
        auth: uint8ArrayToBase64Url(new Uint8Array(authBuf))
      }
    };
  }
  const raw = sub.toJSON();
  const p256dh = raw.keys?.p256dh ?? "";
  const auth = raw.keys?.auth ?? "";
  if (!raw.endpoint || !p256dh || !auth) {
    throw new Error("浏览器返回的 PushSubscription 缺少 endpoint 或加密密钥");
  }
  return {
    endpoint: raw.endpoint,
    keys: { p256dh, auth }
  };
}

export async function enableDeviceWebPush(opts: {
  token: string;
  label: string;
  vapidPublicKey: string;
  nodeFilter: string[];
  eventFilter: PushEventFilterKey[];
}): Promise<{
  subscription: WebPushSubscriptionRecord;
  endpointSha256Prefix: string;
}> {
  if (typeof Notification === "undefined") {
    throw new Error("当前浏览器不支持 Notification API");
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    throw new Error("浏览器通知权限已被拒绝，请在浏览器站点设置中重新允许通知后刷新页面。");
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("当前浏览器不支持 Service Worker Web Push");
  }

  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;

  let pushSub = await reg.pushManager.getSubscription();
  if (!pushSub) {
    pushSub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(opts.vapidPublicKey)
    });
  }

  const cleanSub = extractSubscriptionPayload(pushSub);
  const endpointSha256Prefix = await computeEndpointSha256Prefix(cleanSub.endpoint);
  const res = await apiClient.createPushSubscription(opts.token, {
    label: opts.label.trim() || suggestDeviceLabel(),
    subscription: cleanSub,
    node_filter: opts.nodeFilter,
    event_filter: opts.eventFilter.length > 0 ? opts.eventFilter : DEFAULT_PUSH_EVENT_FILTER
  });

  return {
    subscription: res.subscription,
    endpointSha256Prefix
  };
}

export function mapRunStatusToFilterKey(status: RunStatus): PushEventFilterKey | null {
  switch (status) {
    case "needs_approval":
      return "run_needs_approval";
    case "failed":
      return "run_failed";
    case "done":
      return "run_done";
    case "cancelled":
      return "run_cancelled";
    default:
      return null;
  }
}

export function mapNativeKindToFilterKey(kind: NativeEventKind): PushEventFilterKey {
  switch (kind) {
    case "interaction_needed":
      return "native_interaction_needed";
    case "turn_summary":
      return "native_turn_summary";
    case "progress":
      return "native_progress";
  }
}

export function hasActiveWebPushCoverage(opts: {
  pushConfig: PushConfigRecord | null;
  subscriptions: WebPushSubscriptionRecord[];
  localEndpointSha256Prefix: string | null;
  nodeId: string;
  filterKey: PushEventFilterKey;
}): boolean {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted" ||
    !opts.pushConfig?.enabled ||
    !opts.localEndpointSha256Prefix
  ) {
    return false;
  }
  const localSub = opts.subscriptions.find(
    (s) =>
      s.endpoint_sha256_prefix === opts.localEndpointSha256Prefix &&
      s.enabled &&
      s.revoked_at === null
  );
  if (!localSub) return false;
  const nodeAllowed =
    localSub.node_filter.length === 0 || localSub.node_filter.includes(opts.nodeId);
  const eventAllowed = localSub.event_filter.includes(opts.filterKey);
  return nodeAllowed && eventAllowed;
}

export async function notifyInPageWithDedup(opts: {
  eventKey: string;
  title: string;
  body: string;
  targetUrl: string;
  nodeId: string;
  filterKey: PushEventFilterKey;
  pushConfig: PushConfigRecord | null;
  subscriptions: WebPushSubscriptionRecord[];
  localEndpointSha256Prefix: string | null;
  inPageEnabled: boolean;
  onNavigate: (targetUrl: string) => void;
}): Promise<boolean> {
  if (!opts.inPageEnabled) return false;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return false;
  }
  if (
    hasActiveWebPushCoverage({
      pushConfig: opts.pushConfig,
      subscriptions: opts.subscriptions,
      localEndpointSha256Prefix: opts.localEndpointSha256Prefix,
      nodeId: opts.nodeId,
      filterKey: opts.filterKey
    })
  ) {
    return false;
  }

  const channel = ensureBroadcastChannel();
  if (seenInPageKeys.has(opts.eventKey)) {
    return false;
  }

  const emitNotification = (): boolean => {
    if (seenInPageKeys.has(opts.eventKey)) {
      return false;
    }
    rememberSeenKey(opts.eventKey);
    channel?.postMessage({ type: "notified", eventKey: opts.eventKey });
    const notif = new Notification(opts.title, {
      body: opts.body,
      tag: opts.eventKey,
      icon: "/icons/icon-192.png"
    });
    notif.onclick = () => {
      window.focus();
      opts.onNavigate(opts.targetUrl);
      notif.close();
    };
    return true;
  };

  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    let fired = false;
    await navigator.locks.request(
      `ahub-notify-${opts.eventKey}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          return;
        }
        fired = emitNotification();
        if (fired) {
          await new Promise((resolve) => window.setTimeout(resolve, 1200));
        }
      }
    );
    return fired;
  }

  return emitNotification();
}
