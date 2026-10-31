import { AlertTriangle, CheckCircle2, Info, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  crumb,
  titleId,
}: {
  title: ReactNode;
  titleId?: string;
  description?: ReactNode;
  actions?: ReactNode;
  crumb?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        {crumb ? <div className="t-crumb mb-2">{crumb}</div> : null}
        <h1 id={titleId} className="t-title">
          {title}
        </h1>
        {description ? <div className="mt-2 max-w-[60ch] text-sm text-mute">{description}</div> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
  flush,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** flush drops the body padding, for a table that runs to the card edges. */
  flush?: boolean;
}) {
  return (
    <section className={cn("card min-w-0", className)}>
      {title ? (
        <div className="card-head">
          <div className="min-w-0">
            <h2 className="t-section">{title}</h2>
            {description ? <p className="t-hint mt-1">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={flush ? undefined : "p-4"}>{children}</div>
    </section>
  );
}

/** Stack spaces cards and makes them enter in turn. */
export function Stack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("stagger flex flex-col gap-4", className)}>{children}</div>;
}

const badgeTones = {
  neutral: "",
  accent: "badge-accent badge-dot",
  success: "badge-success badge-dot",
  warning: "badge-warning badge-dot",
  danger: "badge-danger badge-dot",
} as const;

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof badgeTones; children: ReactNode }) {
  return <span className={cn("badge", badgeTones[tone])}>{children}</span>;
}

const alertTones = {
  info: { className: "", icon: "text-mute", Icon: Info },
  success: { className: "note-success", icon: "text-success", Icon: CheckCircle2 },
  warning: { className: "note-warning", icon: "text-warning", Icon: AlertTriangle },
  danger: { className: "note-danger", icon: "text-danger", Icon: AlertTriangle },
} as const;

export function Alert({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: keyof typeof alertTones;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const { className: toneClass, icon, Icon } = alertTones[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("note enter", toneClass, className)}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", icon)} aria-hidden />
      <div className="min-w-0 break-words">
        {title ? <p className="font-medium text-ink">{title}</p> : null}
        {children ? <div className={cn(title ? "mt-0.5" : null)}>{children}</div> : null}
      </div>
    </div>
  );
}

export function ErrorAlert({ error, title, className }: { error: unknown; title?: string; className?: string }) {
  if (!error) return null;
  return (
    <Alert tone="danger" title={title} className={className}>
      {errorMessage(error)}
    </Alert>
  );
}

/** Skeleton is one placeholder bar. The caller sets its size. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("skeleton h-3", className)} />;
}

/** Loading wraps skeletons with a status for screen readers. */
export function Loading({
  label = "Loading",
  children,
  className,
}: {
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div role="status" aria-label={label} className={className}>
      {children}
    </div>
  );
}

/** SkeletonTable has the shape of a data table: a header row and body rows. */
export function SkeletonTable({ columns, rows = 3, label }: { columns: number; rows?: number; label?: string }) {
  const cols = Array.from({ length: columns }, (_, i) => i);
  return (
    <Loading label={label} className="card overflow-hidden">
      <div className="flex gap-6 px-4 py-3">
        {cols.map((c) => (
          <Skeleton key={c} className={cn("h-2.5 flex-1", c === 0 ? "max-w-24" : "max-w-16")} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-6 border-t border-hairline px-4 py-3.5">
          {cols.map((c) => (
            <Skeleton key={c} className={cn("flex-1", c === 0 ? "max-w-40" : "max-w-20")} />
          ))}
        </div>
      ))}
    </Loading>
  );
}

/** SkeletonCard has the shape of a card with a header and form fields. */
export function SkeletonCard({
  fields = 4,
  label,
  className,
}: {
  fields?: number;
  label?: string;
  className?: string;
}) {
  return (
    <Loading label={label} className={cn("card", className)}>
      <div className="card-head">
        <Skeleton className="h-3.5 w-32" />
      </div>
      <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
        {Array.from({ length: fields }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
    </Loading>
  );
}

/** SkeletonRows has the shape of a list of one-line rows. */
export function SkeletonRows({ rows = 3, label }: { rows?: number; label?: string }) {
  return (
    <Loading label={label} className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-t border-hairline py-3 first:border-t-0">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="ml-auto h-4 w-16 rounded-full" />
        </div>
      ))}
    </Loading>
  );
}

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("enter flex flex-col items-center gap-2 px-4 py-10 text-center", className)}>
      <Inbox className="h-5 w-5 text-mute" aria-hidden />
      <p className="text-sm text-mute">{children}</p>
    </div>
  );
}

/** TableCard holds a table that scrolls horizontally inside its card. */
export function TableCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("card enter min-w-0 overflow-hidden", className)}>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

/**
 * KeyValue lists read-only settings as a definition list. A value is identity in mono type
 * unless the item marks it as prose.
 */
export function KeyValue({ items }: { items: { label: string; value: ReactNode; prose?: boolean }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-[minmax(9rem,auto)_1fr] sm:gap-y-3">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="t-label pt-2 text-mute sm:pt-1.5">{item.label}</dt>
          <dd className={cn("min-w-0 break-all text-ink sm:py-1", item.prose ? "text-sm break-normal" : "t-value")}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
