import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

let lastLiveAnnouncement = "";

function legacyCopyText(text: string): boolean {
  const field = Object.assign(document.createElement("textarea"), { value: text });
  field.setAttribute("readonly", "");
  field.style.cssText = "position:fixed;inset-block-start:0;opacity:0";
  document.body.append(field);
  field.select();
  try {
    return document.execCommand("copy");
  } finally {
    field.remove();
  }
}

export interface CopyButtonProps {
  text: string;
  label?: string;
  copiedLabel?: string;
  ariaLabel?: string;
  title?: string;
  variant?: "ghost" | "outline";
  className?: string;
  onClickCapture?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export function CopyButton({
  text,
  label,
  copiedLabel = "已复制",
  ariaLabel,
  title,
  variant = "ghost",
  className,
  onClickCapture
}: CopyButtonProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [announcement, setAnnouncement] = useState("");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  async function handleCopy(e: React.MouseEvent<HTMLButtonElement>) {
    onClickCapture?.(e);
    if (!text) return;

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        ok = legacyCopyText(text);
      }
    } catch {
      ok = legacyCopyText(text);
    }

    setStatus(ok ? "copied" : "failed");
    let nextMessage = ok ? "已复制" : "复制失败";
    if (nextMessage === lastLiveAnnouncement) {
      nextMessage += "\u00A0";
    }
    lastLiveAnnouncement = nextMessage;
    setAnnouncement("");
    window.requestAnimationFrame(() => {
      setAnnouncement(nextMessage);
    });

    timerRef.current = window.setTimeout(() => {
      setStatus("idle");
      setAnnouncement("");
      timerRef.current = null;
    }, 1800);
  }

  const visibleText =
    label !== undefined ? (status === "copied" ? copiedLabel : status === "failed" ? "复制失败" : label) : undefined;

  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={visibleText ? undefined : ariaLabel ?? "复制内容"}
        title={status === "copied" ? "已复制" : status === "failed" ? "复制失败" : title ?? ariaLabel ?? label}
        data-copied={status === "copied" ? "" : undefined}
        data-failed={status === "failed" ? "" : undefined}
        className={cn(
          "inline-flex min-h-6 min-w-6 items-center justify-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer",
          variant === "outline"
            ? "border border-border bg-background/80 text-muted-foreground hover:border-foreground/30 hover:bg-accent hover:text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
          status === "copied" && "text-[var(--status-done)] border-[var(--status-done)]/40",
          status === "failed" && "text-[var(--status-failed)] border-[var(--status-failed)]/40",
          className
        )}
      >
        {status === "copied" ? (
          <Check className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        ) : status === "failed" ? (
          <AlertCircle className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Copy className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        )}
        {visibleText ? <span>{visibleText}</span> : null}
      </button>
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </span>
  );
}
