import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Boxes, Building2, KeyRound, LogOut, Settings2 } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Brand } from "@/app/brand";
import { Button } from "@/components/button";
import { ErrorAlert, Skeleton } from "@/components/layout";
import type { Me } from "@/lib/session";
import { signOut } from "@/lib/session";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/products", label: "Products", Icon: Boxes },
  { to: "/workspaces", label: "Workspaces", Icon: Building2 },
  { to: "/settings/install", label: "Install settings", Icon: Settings2 },
  { to: "/api-keys", label: "API keys", Icon: KeyRound },
] as const;

/**
 * Frame is the page layout: a 200px sidebar with the brand and the navigation, and the main area.
 * Below 640px the navigation becomes a horizontal scroll row under the brand. The sidebar keeps
 * its own view-transition name, so a route change cross-fades only the main area.
 */
export function Frame({
  navLabel,
  nav: navItems,
  account,
  footer,
  children,
  narrow,
}: {
  navLabel: string;
  nav: ReactNode;
  /** account sits beside the brand on narrow screens and at the foot of the sidebar on wide ones. */
  account?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  /** narrow holds the content to the 640px form width. */
  narrow?: boolean;
}) {
  const navRef = useRef<HTMLElement>(null);
  // On a narrow screen the navigation is a scroll row. It keeps the current item in view without
  // scrolling the page.
  useEffect(() => {
    const row = navRef.current;
    const current = row?.querySelector<HTMLElement>('[data-status="active"], [aria-current]');
    if (!row || !current || row.scrollWidth <= row.clientWidth) return;
    const left = current.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft || left + current.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollLeft = left - 12;
    }
  });
  return (
    <div className="min-h-screen bg-canvas sm:grid sm:grid-cols-[200px_minmax(0,1fr)]">
      <aside className="vt-sidebar grid grid-cols-[minmax(0,1fr)_auto] items-center border-b border-hairline bg-sidebar px-3 pt-3.5 pb-2.5 sm:sticky sm:top-0 sm:flex sm:h-screen sm:flex-col sm:items-stretch sm:border-r sm:border-b-0 sm:py-4">
        <Brand className="mx-1 sm:mb-[18px]" />
        {account ? <div className="sm:order-last sm:mt-auto">{account}</div> : null}
        <nav
          ref={navRef}
          aria-label={navLabel}
          className="relative col-span-2 -mx-3 mt-3 overflow-x-auto px-3 [scrollbar-width:none] sm:mx-0 sm:mt-0 sm:overflow-visible sm:px-0"
        >
          {navItems}
        </nav>
        {footer ? <div className="col-span-2 mt-2 px-1 sm:mt-auto sm:pt-4">{footer}</div> : null}
      </aside>
      <main className="vt-main min-w-0 px-5 py-5 sm:px-8 sm:py-7">
        <div className={cn("min-w-0", narrow ? "max-w-[640px]" : "max-w-[960px]")}>{children}</div>
      </main>
    </div>
  );
}

/** navList lays out the items of the sidebar navigation: a row on narrow screens, a column on wide ones. */
export const navList = "flex gap-0.5 sm:flex-col";

export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  return (
    <Frame
      navLabel="Main"
      account={<UserMenu me={me} />}
      nav={
        <div className={navList}>
          {nav.map(({ to, label, Icon }) => (
            <Link key={to} to={to} className="nav-link">
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              {label}
            </Link>
          ))}
        </div>
      }
    >
      {children}
    </Frame>
  );
}

/** AppShellSkeleton has the shape of the shell while the account loads. */
export function AppShellSkeleton() {
  return (
    <Frame
      navLabel="Main"
      nav={
        <div className={navList}>
          {nav.map(({ to }) => (
            <span key={to} className="nav-link">
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-3 w-20" />
            </span>
          ))}
        </div>
      }
    >
      <div role="status" aria-label="Loading your account">
        <Skeleton className="mb-3 h-5 w-48" />
        <Skeleton className="mb-6 h-3 w-80 max-w-full" />
        <Skeleton className="h-40 w-full rounded-card" />
      </div>
    </Frame>
  );
}

/** UserMenu opens with the HTML popover attribute, which needs no script for focus and dismissal. */
function UserMenu({ me }: { me: Me }) {
  const id = useId();
  const menuId = `${id}-menu`;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const out = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      qc.clear();
      await navigate({ to: "/sign-in" });
    },
  });
  const initials = me.name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="sm:border-t sm:border-hairline sm:pt-3">
      <button
        type="button"
        popoverTarget={menuId}
        className="flex w-full items-center gap-2 rounded-card p-1 text-left hover:bg-raised sm:px-1.5 sm:py-1.5"
        aria-label={`Account menu for ${me.name}`}
      >
        <span
          aria-hidden
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-card border border-hairline-strong bg-raised font-mono text-[11px] font-medium text-ink"
        >
          {initials || "?"}
        </span>
        <span className="hidden min-w-0 sm:block">
          <span className="block truncate text-[13px] text-ink">{me.name}</span>
          <span className="block truncate font-mono text-[11px] text-mute">{me.email}</span>
        </span>
      </button>
      <div
        id={menuId}
        popover="auto"
        className="enter fixed inset-auto top-14 right-3 w-64 rounded-card border border-hairline-strong bg-panel p-3 text-body sm:top-auto sm:right-auto sm:bottom-16 sm:left-3"
      >
        <p className="text-sm text-ink">{me.name}</p>
        <p className="truncate font-mono text-[11px] text-mute">{me.email}</p>
        <ul className="mt-3 space-y-1.5 border-t border-hairline pt-3 text-xs">
          {me.memberships.map((m) => (
            <li key={m.linearWorkspaceId} className="flex justify-between gap-2">
              <span className="truncate">{m.workspaceName}</span>
              <span className="font-mono text-[11px] text-mute">{m.admin ? "admin" : "member"}</span>
            </li>
          ))}
          {me.operatorAdmin ? <li className="font-mono text-[11px] text-mute">operator admin</li> : null}
        </ul>
        <ErrorAlert error={out.error} className="mt-3" />
        <Button className="mt-3 w-full" mutation={out} onClick={() => out.mutate()}>
          <LogOut className="h-3.5 w-3.5" aria-hidden />
          Sign out
        </Button>
      </div>
    </div>
  );
}
