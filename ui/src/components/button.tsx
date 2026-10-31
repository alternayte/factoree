import { Slot } from "@radix-ui/react-slot";
import { Check, Loader2 } from "lucide-react";
import { useEffect, useState, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const variants = {
  primary: "btn-primary",
  secondary: "",
  ghost: "btn-ghost",
  danger: "btn-danger",
} as const;

const sizes = {
  sm: "btn-sm",
  md: "",
} as const;

/** The part of a TanStack Query mutation that a button shows: in flight, then a check on success. */
export type MutationState = { isPending: boolean; isSuccess: boolean; submittedAt: number };

const SUCCESS_MS = 900;

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  asChild?: boolean;
  /** pending shows the spinner without a mutation, for example while the page leaves for GitHub. */
  pending?: boolean;
  /** mutation drives the spinner, the disabled state and the check for 900ms after a success. */
  mutation?: MutationState;
};

/**
 * Button keeps its width while busy: the label stays in the layout, invisible, under the spinner
 * or the check. It stays disabled until the request settles.
 */
export function Button({
  variant = "secondary",
  size = "md",
  asChild,
  pending,
  mutation,
  className,
  children,
  disabled,
  type = "button",
  ...props
}: Props) {
  const busy = Boolean(pending || mutation?.isPending);
  const succeeded = useSuccessFlash(mutation);
  const classes = cn("btn", variants[variant], sizes[size], className);
  if (asChild) {
    return (
      <Slot className={classes} {...props}>
        {children}
      </Slot>
    );
  }
  const overlay = busy ? "busy" : succeeded ? "done" : null;
  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-done={overlay === "done" || undefined}
      {...props}
    >
      <span className={cn("btn-label", overlay && "opacity-0")}>{children}</span>
      {overlay === "busy" ? (
        <span className="btn-overlay" aria-hidden>
          <Loader2 className="h-4 w-4 animate-spin" />
        </span>
      ) : null}
      {overlay === "done" ? (
        <span className="btn-overlay">
          <Check className="h-4 w-4" aria-hidden />
          <span className="sr-only" role="status">
            Done
          </span>
        </span>
      ) : null}
    </button>
  );
}

/** useSuccessFlash is true for 900ms after each successful submission of the mutation. */
function useSuccessFlash(mutation: MutationState | undefined): boolean {
  const [expired, setExpired] = useState<number | null>(null);
  const submittedAt = mutation?.submittedAt ?? 0;
  const show = Boolean(mutation?.isSuccess) && submittedAt !== expired;
  useEffect(() => {
    if (!show) return;
    const timer = window.setTimeout(() => setExpired(submittedAt), SUCCESS_MS);
    return () => window.clearTimeout(timer);
  }, [show, submittedAt]);
  return show;
}
