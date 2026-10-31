import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button, type MutationState } from "@/components/button";

/**
 * Confirm uses the native <dialog>. Radix Dialog locks scroll through react-remove-scroll, which
 * injects a <style> element that the CSP default-src 'self' blocks.
 */
export function Confirm({
  open,
  title,
  children,
  confirmLabel,
  mutation,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  mutation?: MutationState;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      className="dialog m-auto w-[min(26rem,calc(100vw-2rem))] rounded-card border border-hairline-strong bg-panel p-0 text-body"
    >
      <div className="p-4">
        <h2 id={titleId} className="t-section">
          {title}
        </h2>
        {children ? <div className="mt-2 text-sm text-body">{children}</div> : null}
      </div>
      <div className="flex justify-end gap-2 border-t border-hairline px-4 py-3">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" mutation={mutation} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
