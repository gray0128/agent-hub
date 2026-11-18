import { useEffect, useMemo, useState } from "react";
import { Bell, CheckCircle2, RefreshCw, Send, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { apiClient, ApiClientError } from "@/lib/api-client";
import {
  DEFAULT_PUSH_EVENT_FILTER,
  detectBrowserNotifyHealth,
  enableDeviceWebPush,
  PUSH_EVENT_FILTER_OPTIONS,
  suggestDeviceLabel
} from "@/lib/browser-notify";
import { cn, formatShortTime } from "@/lib/utils";
import type {
  NodeRecord,
  PushConfigRecord,
  PushEventFilterKey,
  PushSubscriptionTestResponse,
  WebPushSubscriptionRecord
} from "@/types";

export interface BrowserNotifyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  nodes: NodeRecord[];
  pushConfig: PushConfigRecord | null;
  subscriptions: WebPushSubscriptionRecord[];
  localEndpointSha256Prefix: string | null;
  inPageFallbackEnabled: boolean;
  onToggleInPageFallback: (enabled: boolean) => void;
  onSubscriptionsChange: (subs: WebPushSubscriptionRecord[]) => void;
  onLocalEndpointChange: (prefix: string | null) => void;
}

export function BrowserNotifyDialog({
  open,
  onOpenChange,
  token,
  nodes,
  pushConfig,
  subscriptions,
  localEndpointSha256Prefix,
  inPageFallbackEnabled,
  onToggleInPageFallback,
  onSubscriptionsChange,
  onLocalEndpointChange
}: BrowserNotifyDialogProps) {
  const [deviceLabel, setDeviceLabel] = useState(() => suggestDeviceLabel());
  const [nodeFilter, setNodeFilter] = useState<string[]>([]);
  const [eventFilter, setEventFilter] = useState<PushEventFilterKey[]>(() => [
    ...DEFAULT_PUSH_EVENT_FILTER
  ]);
  const [subscribing, setSubscribing] = useState(false);
  const [busySubId, setBusySubId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, PushSubscriptionTestResponse>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErrorMsg(null);
    void apiClient
      .fetchPushSubscriptions(token, false)
      .then((res) => onSubscriptionsChange(res.subscriptions))
      .catch(() => {
        // non-fatal refresh
      });
  }, [open, onSubscriptionsChange, token]);

  const health = useMemo(
    () =>
      detectBrowserNotifyHealth({
        pushConfig,
        subscriptions,
        localEndpointSha256Prefix
      }),
    [localEndpointSha256Prefix, pushConfig, subscriptions]
  );

  function toggleNodeFilter(nodeId: string) {
    setNodeFilter((prev) =>
      prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId]
    );
  }

  function toggleEventFilter(key: PushEventFilterKey, checked: boolean) {
    setEventFilter((prev) => {
      if (checked) {
        return prev.includes(key) ? prev : [...prev, key];
      }
      return prev.filter((k) => k !== key);
    });
  }

  async function handleEnablePush() {
    if (!pushConfig?.enabled || !pushConfig.vapid_public_key) {
      setErrorMsg("控制面尚未配置 VAPID 公私钥，暂无法启用 Web Push。");
      return;
    }
    setSubscribing(true);
    setErrorMsg(null);
    try {
      const result = await enableDeviceWebPush({
        token,
        label: deviceLabel,
        vapidPublicKey: pushConfig.vapid_public_key,
        nodeFilter,
        eventFilter
      });
      onLocalEndpointChange(result.endpointSha256Prefix);
      const listRes = await apiClient.fetchPushSubscriptions(token, false);
      onSubscriptionsChange(listRes.subscriptions);
    } catch (err) {
      setErrorMsg(
        err instanceof ApiClientError || err instanceof Error
          ? err.message
          : "开启浏览器通知失败"
      );
    } finally {
      setSubscribing(false);
    }
  }

  async function handleToggleSubEnabled(sub: WebPushSubscriptionRecord, enabled: boolean) {
    setBusySubId(sub.id);
    setErrorMsg(null);
    try {
      const res = await apiClient.patchPushSubscription(token, sub.id, { enabled });
      onSubscriptionsChange(subscriptions.map((s) => (s.id === sub.id ? res.subscription : s)));
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : "更新设备状态失败");
    } finally {
      setBusySubId(null);
    }
  }

  async function handleSaveRename(subId: string) {
    const trimmed = editingLabel.trim();
    if (!trimmed) return;
    setBusySubId(subId);
    setErrorMsg(null);
    try {
      const res = await apiClient.patchPushSubscription(token, subId, { label: trimmed });
      onSubscriptionsChange(subscriptions.map((s) => (s.id === subId ? res.subscription : s)));
      setEditingId(null);
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : "重命名设备失败");
    } finally {
      setBusySubId(null);
    }
  }

  async function handleTestSub(subId: string) {
    setBusySubId(subId);
    setErrorMsg(null);
    try {
      const res = await apiClient.testPushSubscription(token, subId);
      setTestResults((prev) => ({ ...prev, [subId]: res }));
      onSubscriptionsChange(subscriptions.map((s) => (s.id === subId ? res.subscription : s)));
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : "发送测试通知失败");
    } finally {
      setBusySubId(null);
    }
  }

  async function handleRevokeSub(subId: string) {
    setBusySubId(subId);
    setErrorMsg(null);
    try {
      await apiClient.revokePushSubscription(token, subId);
      onSubscriptionsChange(subscriptions.filter((s) => s.id !== subId));
    } catch (err) {
      setErrorMsg(err instanceof ApiClientError ? err.message : "解绑设备失败");
    } finally {
      setBusySubId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="browser-notify-dialog"
        className="max-h-[88dvh] w-[min(94vw,640px)] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bell className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            <span>浏览器通知渠道（Web Push）</span>
          </DialogTitle>
          <DialogDescription>
            管理当前与历史设备的系统通知推送；离线通知经由控制面加密直推，Service Worker 不回源请求 API。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-xs">
          {/* 3-State Health Banner */}
          <div
            data-testid="browser-notify-health"
            data-health-status={health.status}
            className={cn(
              "rounded-[6px] border p-3 space-y-1.5",
              health.status === "active"
                ? "border-[var(--status-done)]/40 bg-[var(--status-done)]/10"
                : health.status === "denied"
                  ? "border-[var(--status-failed)]/40 bg-[var(--status-failed)]/10"
                  : "border-[var(--status-approval)]/40 bg-[var(--status-approval)]/10"
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    health.status === "active"
                      ? "done"
                      : health.status === "denied"
                        ? "failed"
                        : "approval"
                  }
                >
                  {health.label}
                </Badge>
                {pushConfig?.enabled ? (
                  <span className="font-mono text-[10px] text-muted-foreground">VAPID 已就绪</span>
                ) : (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    VAPID_NOT_CONFIGURED
                  </span>
                )}
              </div>
              <label className="inline-flex items-center gap-1.5 text-[11px] text-foreground cursor-pointer">
                <Switch
                  data-testid="in-page-fallback-switch"
                  checked={inPageFallbackEnabled}
                  onCheckedChange={onToggleInPageFallback}
                />
                <span>页内兜底提醒</span>
              </label>
            </div>
            <p className="text-[11px] text-foreground/90 text-pretty">{health.detail}</p>
          </div>

          {errorMsg ? (
            <div
              role="alert"
              className="rounded-[6px] border border-[var(--status-failed)]/40 bg-[var(--status-failed)]/10 px-3 py-2 text-[11px] text-[var(--status-failed)]"
            >
              {errorMsg}
            </div>
          ) : null}

          {/* Subscribe Current Device */}
          <div className="rounded-[6px] border border-border bg-card p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground">注册当前设备</span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                已选 {eventFilter.length} 类触发事件
              </span>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
              <div>
                <label
                  htmlFor="push-device-label"
                  className="mb-1 block text-[11px] text-muted-foreground"
                >
                  设备备注名称
                </label>
                <Input
                  id="push-device-label"
                  data-testid="push-device-label-input"
                  value={deviceLabel}
                  onChange={(e) => setDeviceLabel(e.target.value)}
                  placeholder="例如：MacMini Chrome / iPhone Safari"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </div>
              <div className="flex items-end">
                <Button
                  type="button"
                  data-testid="enable-browser-push-btn"
                  disabled={!pushConfig?.enabled || subscribing || health.status === "denied"}
                  onClick={handleEnablePush}
                  className="w-full sm:w-auto min-h-11 sm:min-h-0 sm:h-8"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  {subscribing ? "注册中..." : "开启本设备浏览器通知"}
                </Button>
              </div>
            </div>

            {nodes.length > 0 ? (
              <div className="space-y-1.5">
                <span className="block text-[11px] text-muted-foreground">
                  节点过滤（不选默认接收全部节点）
                </span>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    aria-pressed={nodeFilter.length === 0}
                    onClick={() => setNodeFilter([])}
                    className={cn(
                      "inline-flex min-h-11 px-2.5 sm:min-h-0 sm:h-6 sm:px-2 items-center rounded-[4px] border text-xs sm:text-[11px] font-medium transition-colors duration-150 cursor-pointer",
                      nodeFilter.length === 0
                        ? "border-[var(--status-running)]/50 bg-[var(--status-running)]/12 text-foreground"
                        : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
                    )}
                  >
                    全部节点
                  </button>
                  {nodes.map((node) => {
                    const selected = nodeFilter.includes(node.id);
                    return (
                      <button
                        key={node.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleNodeFilter(node.id)}
                        className={cn(
                          "inline-flex min-h-11 px-2.5 sm:min-h-0 sm:h-6 sm:px-2 items-center rounded-[4px] border font-mono text-xs sm:text-[11px] transition-colors duration-150 cursor-pointer",
                          selected
                            ? "border-[var(--status-running)]/50 bg-[var(--status-running)]/12 text-foreground"
                            : "border-border bg-background/60 text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {node.id}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="divide-y divide-border rounded-[5px] border border-border bg-background/50">
              {PUSH_EVENT_FILTER_OPTIONS.map((opt) => {
                const checked = eventFilter.includes(opt.key);
                return (
                  <label
                    key={opt.key}
                    className="flex min-h-11 items-center justify-between gap-2 px-2.5 py-2 cursor-pointer"
                  >
                    <div className="min-w-0">
                      <div className="text-[11px] font-medium text-foreground">{opt.label}</div>
                      <div className="text-[10px] text-muted-foreground">{opt.description}</div>
                    </div>
                    <Switch
                      data-testid={`push-filter-switch-${opt.key}`}
                      checked={checked}
                      onCheckedChange={(val) => toggleEventFilter(opt.key, val)}
                    />
                  </label>
                );
              })}
            </div>
          </div>

          {/* Registered Devices List */}
          <div className="rounded-[6px] border border-border bg-card overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="font-medium text-foreground tabular-nums">
                已注册推送设备 ({subscriptions.length})
              </span>
              <button
                type="button"
                onClick={() => {
                  void apiClient
                    .fetchPushSubscriptions(token, false)
                    .then((res) => onSubscriptionsChange(res.subscriptions))
                    .catch(() => {});
                }}
                className="inline-flex min-h-11 px-2 sm:min-h-0 sm:px-0 items-center gap-1 text-xs sm:text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <RefreshCw className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                刷新
              </button>
            </div>

            {subscriptions.length === 0 ? (
              <div className="px-3 py-5 text-center text-[11px] text-muted-foreground">
                暂无已注册 Web Push 设备
              </div>
            ) : (
              <div className="divide-y divide-border">
                {subscriptions.map((sub) => {
                  const isCurrentDevice =
                    Boolean(localEndpointSha256Prefix) &&
                    sub.endpoint_sha256_prefix === localEndpointSha256Prefix;
                  const testRes = testResults[sub.id];
                  const isBusy = busySubId === sub.id;

                  return (
                    <div
                      key={sub.id}
                      data-testid={`push-sub-row-${sub.id}`}
                      className="space-y-2 px-3 py-2.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          {editingId === sub.id ? (
                            <div className="flex flex-wrap items-center gap-1">
                              <Input
                                value={editingLabel}
                                onChange={(e) => setEditingLabel(e.target.value)}
                                autoComplete="off"
                                className="w-40"
                              />
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={isBusy}
                                onClick={() => handleSaveRename(sub.id)}
                                className="min-h-11 sm:min-h-0 sm:h-7 px-2.5 sm:px-2 text-xs sm:text-[11px]"
                              >
                                保存
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditingId(null)}
                                className="min-h-11 sm:min-h-0 sm:h-7 px-2.5 sm:px-2 text-xs sm:text-[11px]"
                              >
                                取消
                              </Button>
                            </div>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingId(sub.id);
                                  setEditingLabel(sub.label);
                                }}
                                title="点击重命名设备"
                                className="inline-flex min-h-11 sm:min-h-0 items-center truncate text-xs font-medium text-foreground hover:underline cursor-pointer"
                              >
                                {sub.label}
                              </button>
                              {isCurrentDevice ? (
                                <Badge variant="done" className="text-[10px]">
                                  本机
                                </Badge>
                              ) : null}
                            </>
                          )}
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                          <Switch
                            data-testid={`toggle-push-sub-${sub.id}`}
                            checked={sub.enabled}
                            disabled={isBusy}
                            onCheckedChange={(checked) => handleToggleSubEnabled(sub, checked)}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            data-testid={`test-push-sub-${sub.id}`}
                            disabled={isBusy || !sub.enabled}
                            onClick={() => handleTestSub(sub.id)}
                            className="min-h-11 sm:min-h-0 sm:h-7 px-2.5 sm:px-2 text-xs sm:text-[11px]"
                          >
                            <Send className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                            发送测试通知
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            data-testid={`revoke-push-sub-${sub.id}`}
                            disabled={isBusy}
                            onClick={() => handleRevokeSub(sub.id)}
                            aria-label={`解绑 ${sub.label}`}
                            className="min-h-11 sm:min-h-0 sm:h-7 px-2.5 sm:px-2 text-xs sm:text-[11px] text-[var(--status-failed)] hover:text-[var(--status-failed)]"
                          >
                            <Trash2 className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                            解绑
                          </Button>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground tabular-nums">
                        <span>网关：{sub.endpoint_host}</span>
                        <span>指纹：{sub.endpoint_sha256_prefix}</span>
                        <span>失败计数：{sub.failure_count}</span>
                        <span>最近送达：{formatShortTime(sub.last_sent_at)}</span>
                      </div>

                      {sub.last_error_code ? (
                        <div className="font-mono text-[10px] text-[var(--status-failed)]">
                          最近错误：{sub.last_error_code} {sub.last_error_message}
                        </div>
                      ) : null}

                      {testRes ? (
                        <div
                          data-testid={`test-push-result-${sub.id}`}
                          className={cn(
                            "rounded-[4px] border px-2 py-1 font-mono text-[10px] tabular-nums",
                            testRes.delivered
                              ? "border-[var(--status-done)]/40 bg-[var(--status-done)]/10 text-[var(--status-done)]"
                              : "border-[var(--status-failed)]/40 bg-[var(--status-failed)]/10 text-[var(--status-failed)]"
                          )}
                        >
                          测试回执：{testRes.delivered ? "送达成功" : "投递失败"} · HTTP{" "}
                          {testRes.http_status ?? "--"}
                          {testRes.error_code ? ` · ${testRes.error_code}` : ""}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
