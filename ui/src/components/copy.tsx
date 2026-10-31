import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/button";
import { cn } from "@/lib/utils";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={copied ? "Copied" : label}
      title={label}
      className={copied ? "text-success hover:text-success" : undefined}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setCopied(true));
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      <span className="sr-only sm:not-sr-only">{copied ? "Copied" : "Copy"}</span>
    </Button>
  );
}

/** CopyValue shows a value in mono type with a copy button, for URLs and keys. */
export function CopyValue({ value, label, className }: { value: string; label?: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex min-h-9 items-center gap-2 rounded-control border border-hairline bg-canvas py-0.5 pr-0.5 pl-2.5",
        className,
      )}
    >
      <code className="t-value min-w-0 flex-1 break-all text-accent-text" aria-label={label}>
        {value}
      </code>
      <CopyButton value={value} label={label ? `Copy ${label}` : "Copy"} />
    </div>
  );
}
