import { Badge } from "@/components/ui/badge";
import type { NodeStatus, RunStatus } from "@/types";

export function NodeStatusDot({ status }: { status: NodeStatus }) {
  const colorClass =
    status === "online"
      ? "bg-[var(--status-done)]"
      : status === "draining"
        ? "bg-[var(--status-approval)]"
        : "bg-[var(--status-failed)]";
  const label = status === "online" ? "在线" : status === "draining" ? "已排空" : "离线";

  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className={`inline-block h-2 w-2 rounded-full ${colorClass}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

const RUN_STATUS_META: Record<
  RunStatus,
  { label: string; variant: "outline" | "done" | "running" | "approval" | "failed" }
> = {
  queued: { label: "排队中", variant: "outline" },
  claimed: { label: "已认领", variant: "running" },
  running: { label: "执行中", variant: "running" },
  needs_approval: { label: "待审批", variant: "approval" },
  done: { label: "已完成", variant: "done" },
  failed: { label: "已失败", variant: "failed" },
  cancelled: { label: "已取消", variant: "outline" }
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const meta = RUN_STATUS_META[status];
  return (
    <Badge variant={meta.variant} data-run-status={status}>
      {status === "running" || status === "claimed" ? (
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />
      ) : null}
      {meta.label}
    </Badge>
  );
}
