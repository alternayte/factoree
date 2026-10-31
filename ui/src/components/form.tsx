import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { useId } from "react";
import { cn } from "@/lib/utils";

/** mono sets Geist Mono for values that are identity: ids, keys, secrets, URLs, slugs and image references. */
type Mono = { mono?: boolean };

export function Input({ className, mono, ...props }: InputHTMLAttributes<HTMLInputElement> & Mono) {
  return <input className={cn("control", mono && "control-mono", className)} {...props} />;
}

export function Textarea({ className, mono, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & Mono) {
  return <textarea className={cn("control", mono && "control-mono", className)} {...props} />;
}

export function Select({ className, children, mono, ...props }: SelectHTMLAttributes<HTMLSelectElement> & Mono) {
  return (
    <select className={cn("control", mono && "control-mono", className)} {...props}>
      {children}
    </select>
  );
}

/**
 * Field renders a label, a control, a hint and the field errors. The render prop receives the
 * id and the aria attributes, so every control has a label and its hint.
 */
export function Field({
  label,
  hint,
  errors,
  className,
  trailing,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  errors?: string[];
  className?: string;
  trailing?: ReactNode;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described = [hint ? hintId : null, errors?.length ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex min-h-5 items-center justify-between gap-2">
        <label htmlFor={id} className="t-label">
          {label}
        </label>
        {trailing}
      </div>
      {children({ id, "aria-describedby": described, "aria-invalid": errors?.length ? true : undefined })}
      {hint ? (
        <p id={hintId} className="t-hint">
          {hint}
        </p>
      ) : null}
      {errors?.length ? (
        <p id={errorId} className="text-xs text-danger">
          {errors.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2.5">
      <SwitchPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="switch"
      >
        <SwitchPrimitive.Thumb className="switch-thumb" />
      </SwitchPrimitive.Root>
      <label htmlFor={id} className={cn("text-sm", disabled ? "text-mute" : "text-body")}>
        {label}
      </label>
    </div>
  );
}

/** FieldGrid lays fields out in two columns on wide screens. */
export function FieldGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2", className)}>{children}</div>;
}

/** SavedNote confirms a save in place, next to its button. */
export function SavedNote({ show, children = "Saved" }: { show: boolean; children?: ReactNode }) {
  return show ? (
    <span role="status" className="fade-in inline-flex items-center gap-1.5 text-xs text-success">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" />
      {children}
    </span>
  ) : null;
}
