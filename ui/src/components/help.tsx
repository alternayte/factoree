import { CircleHelp } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

const GAP = 6;
const PAD = 16;

/**
 * HelpPopover is a small help button that opens a popover. It uses the native Popover API, not
 * Radix Popover: the ESLint config refuses Radix Popover, because it pulls in react-remove-scroll,
 * which injects a <style> element that the CSP default-src 'self' blocks. The browser gives light
 * dismiss, Escape and the top layer. The position goes through the CSSOM, which the CSP allows.
 */
export function HelpPopover({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  const id = useId();
  const titleId = `${id}-title`;
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const onToggle = (event: Event) => setOpen((event as ToggleEvent).newState === "open");
    element.addEventListener("toggle", onToggle);
    return () => element.removeEventListener("toggle", onToggle);
  }, []);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const button = trigger.current;
      const element = panel.current;
      if (!button || !element) return;
      const anchor = button.getBoundingClientRect();
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const left = Math.max(PAD, Math.min(anchor.left, window.innerWidth - width - PAD));
      const below = anchor.bottom + GAP;
      const above = anchor.top - GAP - height;
      const room = window.innerHeight - PAD;
      // Below when it fits, else above when that fits, else as low as the viewport allows.
      const top = below + height <= room ? below : above >= PAD ? above : Math.max(PAD, room - height);
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="help-trigger"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-state={open ? "open" : "closed"}
        popoverTarget={id}
      >
        <CircleHelp className="h-3.5 w-3.5" aria-hidden />
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="dialog"
        aria-labelledby={titleId}
        className="popover w-[min(24rem,calc(100vw-2rem))]"
      >
        <p id={titleId} className="t-label mb-2 text-mute">
          {title}
        </p>
        <div className="text-sm font-normal text-body normal-case tracking-normal">{children}</div>
      </div>
    </>
  );
}

/** HelpList lists one statement per line, the way ASD-STE100 writes them. */
export function HelpList({ items }: { items: readonly string[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item) => (
        <li key={item} className="leading-snug">
          {item}
        </li>
      ))}
    </ul>
  );
}
