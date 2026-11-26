import type { GetRetroResponse, ListRetrosResponse } from "@/api/types.gen";

/** docs/specs/retro-agent.md. The shared formatting of the Retro pages. */
export type RetroSummary = ListRetrosResponse["retros"][number];
export type RetroDetail = GetRetroResponse;
export type Finding = RetroDetail["findings"][number];
/** docs/specs/retro-web-research.md. A stored search hit or page of a retro. */
export type WebResultRef = RetroDetail["webResults"][number];
export type SignalResultRef = RetroDetail["signalResults"][number];

/** formatDay renders a published date as a day, since a source date has no reliable time. */
export const formatDay = (value: string | null): string => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { dateStyle: "medium" });
};

export const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** webResultLabel names a web result by its title, or by its URL when it has none. */
export const webResultLabel = (result: { title: string | null; url: string }): string => result.title?.trim() || result.url;

export const retroTone = (status: RetroSummary["status"]) =>
  status === "running" ? "accent" : status === "succeeded" ? "success" : "danger";

export const KIND_TONE = { factory: "accent", error: "danger", idea: "warning" } as const;

export const FINDING_STATUS_LABEL: Record<Finding["status"], string> = {
  proposed: "proposed",
  created: "issue created",
  dismissed: "dismissed",
  already_proposed: "already proposed",
};

export const percent = (rate: number | null): string => (rate === null ? "—" : `${Math.round(rate * 100)}%`);

export const decimal = (value: number | null): string => (value === null ? "—" : value.toFixed(value < 10 ? 2 : 1));

/** The ISO weekdays, as the retro settings number them: 1 is Monday. */
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
export const hourLabel = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

export const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/** The IANA zones the browser knows, for the time zone suggestions. */
export const timeZones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
};
