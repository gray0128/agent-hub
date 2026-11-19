import type { StreamStatus } from "@/stores/workbench-store";
import { cn } from "@/lib/utils";

const STREAM_CORE_CLASS: Record<StreamStatus, string> = {
  connected: "fill-[var(--status-done)]",
  connecting: "fill-[var(--status-running)] animate-pulse",
  disconnected: "fill-[var(--status-failed)]"
};

interface BrandMarkProps {
  streamStatus: StreamStatus;
  className?: string;
}

export function BrandMark({ streamStatus, className }: BrandMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      <path
        d="M15.5 17.5L23 24M15.5 46.5L23 40M44 32H51"
        stroke="currentColor"
        strokeWidth={6}
        strokeLinecap="round"
      />
      <circle
        data-testid="brand-stream-dot"
        cx={32}
        cy={32}
        r={6}
        className={STREAM_CORE_CLASS[streamStatus]}
      />
    </svg>
  );
}
