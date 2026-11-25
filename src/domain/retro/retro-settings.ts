import { z } from "zod";
import { AGENT_RUNNERS, effortProblem, modelProblem, type AgentRunnerName } from "~/domain/products/agent-settings.js";

/**
 * docs/specs/retro-agent.md. The retro settings of one tenant. The stored settings are the truth,
 * and the Temporal Schedule `retro-<tenantId>` follows them.
 */
export const RETRO_SCHEDULES = ["off", "daily", "weekly"] as const;
export type RetroSchedule = (typeof RETRO_SCHEDULES)[number];

/** 1 is Monday and 7 is Sunday, as ISO 8601 numbers the days. */
export const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;

export interface RetroSettings {
  tenantId: string;
  schedule: RetroSchedule;
  weekday: number;
  hour: number;
  timeZone: string;
  /** Empty means every active product of the tenant. */
  productIds: string[];
  runner: AgentRunnerName | null;
  model: string | null;
  effort: string | null;
  costCapUsd: number;
}

export const defaultRetroSettings = (tenantId: string): RetroSettings => ({
  tenantId,
  schedule: "off",
  weekday: 1,
  hour: 9,
  timeZone: "UTC",
  productIds: [],
  runner: null,
  model: null,
  effort: null,
  costCapUsd: 5,
});

export const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

export const retroSettingsInputSchema = z
  .object({
    schedule: z.enum(RETRO_SCHEDULES),
    weekday: z.number().int().min(1).max(7),
    hour: z.number().int().min(0).max(23),
    timeZone: z.string().min(1).refine(isTimeZone, "not an IANA time zone"),
    productIds: z.array(z.string().min(1)).max(200),
    runner: z.enum(AGENT_RUNNERS).nullable(),
    model: z.string().min(1).nullable(),
    effort: z.string().min(1).nullable(),
    costCapUsd: z.number().positive().max(1_000),
  })
  .strict();
export type RetroSettingsInput = z.infer<typeof retroSettingsInputSchema>;

/**
 * docs/specs/model-picker.md. The retro row takes the same runner, model and effort rules as a
 * product role. A model or an effort without a runner has no runner to fit, so it needs one.
 */
export const retroSettingsProblems = (input: RetroSettingsInput): Record<string, string> => {
  const problems: Record<string, string> = {};
  if (input.runner === null) {
    if (input.model !== null) problems["model"] = "Pick a runner for the retro model.";
    if (input.effort !== null) problems["effort"] = "Pick a runner for the retro effort.";
    return problems;
  }
  if (input.model !== null) {
    const problem = modelProblem(input.runner, input.model);
    if (problem !== null) problems["model"] = problem;
  }
  if (input.effort !== null) {
    const problem = effortProblem(input.runner, input.effort);
    if (problem !== null) problems["effort"] = problem;
  }
  return problems;
};

/** The one Temporal Schedule of a tenant's retros. */
export const retroScheduleId = (tenantId: string): string => `retro-${tenantId}`;

/** The workflow id of a retro that "Run now" starts. */
export const manualRetroWorkflowId = (tenantId: string, at: Date): string => `retro-${tenantId}-${at.toISOString()}`;

/** The workflow id prefix of a scheduled retro. Temporal appends the scheduled time. */
export const scheduledRetroWorkflowId = (tenantId: string): string => `retro-${tenantId}-scheduled`;

/**
 * The calendar of a schedule, at minute zero of the hour, in the stored time zone. Null for off.
 * The zone keeps "09:00" at 09:00 across daylight saving changes.
 */
export const retroCalendarOf = (
  settings: Pick<RetroSettings, "schedule" | "weekday" | "hour">,
): { hour: number; minute: number; dayOfWeek?: (typeof WEEKDAYS)[number] } | null => {
  if (settings.schedule === "off") return null;
  const base = { hour: settings.hour, minute: 0 };
  return settings.schedule === "weekly" ? { ...base, dayOfWeek: WEEKDAYS[settings.weekday - 1] ?? "MONDAY" } : base;
};

/**
 * docs/specs/model-picker.md. What a retro session runs: the tenant's retro row, or the product's
 * default runner and model where the row names none. A model of one runner means nothing to the
 * other, so a row runner other than the product default takes no product model.
 */
export const resolveRetroRole = (
  settings: Pick<RetroSettings, "runner" | "model" | "effort">,
  product: { defaultRunner: AgentRunnerName; model: string | null },
): { runner: AgentRunnerName; model: string | null; effort: string | null } => {
  const runner = settings.runner ?? product.defaultRunner;
  const model = settings.model ?? (runner === product.defaultRunner ? product.model : null);
  return { runner, model, effort: settings.effort };
};

/** The run id a retro session runs under: no run row exists, so it names the retro and the product. */
export const retroSessionRunId = (retroId: string, productId: string): string => `retro:${retroId}:${productId}`;

export const parseRetroSessionRunId = (runId: string): { retroId: string; productId: string } | null => {
  const match = /^retro:([^:]+):([^:]+)$/.exec(runId);
  return match === null ? null : { retroId: match[1]!, productId: match[2]! };
};
