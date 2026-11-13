import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-[11px] font-medium leading-none tabular-nums whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-border bg-secondary text-secondary-foreground",
        outline: "border-border bg-transparent text-muted-foreground",
        done: "border-[var(--status-done)]/30 bg-[var(--status-done)]/10 text-[var(--status-done)]",
        running: "border-[var(--status-running)]/30 bg-[var(--status-running)]/10 text-[var(--status-running)]",
        approval: "border-[var(--status-approval)]/35 bg-[var(--status-approval)]/12 text-[var(--status-approval)]",
        failed: "border-[var(--status-failed)]/35 bg-[var(--status-failed)]/10 text-[var(--status-failed)]"
      }
    },
    defaultVariants: {
      variant: "outline"
    }
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
