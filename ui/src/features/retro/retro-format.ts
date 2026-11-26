import type { GetRetroResponse, ListRetrosResponse } from "@/api/types.gen";

/** docs/specs/retro-agent.md. The shared formatting of the Retro pages. */
export type RetroSummary = ListRetrosResponse["retros"][number];
export type RetroDetail = GetRetroResponse;
export type Finding = RetroDetail["findings"][number];

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
