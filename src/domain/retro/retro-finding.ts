import { z } from "zod";
import type { SignalSourceKind } from "./signal-source.js";

/** docs/specs/retro-agent.md. A factory finding rests on runs, an error finding on errors, an idea finding on analytics or the web. */
export const RETRO_FINDING_KINDS = ["factory", "error", "idea"] as const;
export type RetroFindingKind = (typeof RETRO_FINDING_KINDS)[number];

export const RETRO_FINDING_STATUSES = ["proposed", "created", "dismissed", "already_proposed"] as const;
export type RetroFindingStatus = (typeof RETRO_FINDING_STATUSES)[number];

export const MAX_FINDINGS = 20;

/** One finding as the retro agent writes it in findings.json. An agent claim until Factoree checks it. */
export const proposedFindingSchema = z.object({
  product: z.string().min(1),
  kind: z.enum(RETRO_FINDING_KINDS),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(8_000),
  runIds: z.array(z.string().min(1)).max(50).default([]),
  signalResultIds: z.array(z.string().min(1)).max(50).default([]),
  webResultIds: z.array(z.string().min(1)).max(50).default([]),
  repositories: z.array(z.string().min(1)).max(10).default([]),
});
export type ProposedFinding = z.infer<typeof proposedFindingSchema>;

export const findingsFileSchema = z.object({ findings: z.array(z.unknown()) });

/** What one retro session read: its product, the runs, the signal results and the repositories. */
export interface RetroSessionInput {
  productId: string;
  /** The names the agent may write in `product`: the product id and its slug. */
  productNames: string[];
  runIds: ReadonlySet<string>;
  signalResults: ReadonlyMap<string, SignalSourceKind>;
  /** docs/specs/retro-web-research.md. The web results the session received through the retro gateway. */
  webResults: ReadonlySet<string>;
  repositories: ReadonlySet<string>;
}

export interface CheckedFinding {
  kind: RetroFindingKind;
  title: string;
  description: string;
  runIds: string[];
  signalResultIds: string[];
  webResultIds: string[];
  repositories: string[];
}

export interface DroppedFinding {
  title: string;
  reason: string;
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * docs/specs/retro-agent.md. An agent claim is never evidence. Factoree keeps a finding only when
 * it targets the session's product, cites only what the session read, and cites the evidence its
 * kind rests on. A repository the product does not hold is dropped from the finding, not kept.
 */
export const checkFinding = (raw: unknown, input: RetroSessionInput): { kept: CheckedFinding } | { dropped: DroppedFinding } => {
  const parsed = proposedFindingSchema.safeParse(raw);
  const titleOf = (value: unknown): string =>
    value !== null && typeof value === "object" && typeof (value as { title?: unknown }).title === "string"
      ? (value as { title: string }).title.slice(0, 200)
      : "(no title)";
  if (!parsed.success) return { dropped: { title: titleOf(raw), reason: `it does not match the finding schema: ${parsed.error.issues[0]?.message ?? "invalid"}` } };
  const finding = parsed.data;
  const drop = (reason: string) => ({ dropped: { title: finding.title, reason } });
  if (!input.productNames.includes(finding.product)) return drop(`it targets "${finding.product}", which is not the product of this session`);
  const runIds = unique(finding.runIds);
  const signalResultIds = unique(finding.signalResultIds);
  const foreignRun = runIds.find((id) => !input.runIds.has(id));
  if (foreignRun !== undefined) return drop(`it cites the run ${foreignRun}, which is not in the retro input`);
  const foreignSignal = signalResultIds.find((id) => !input.signalResults.has(id));
  if (foreignSignal !== undefined) return drop(`it cites the signal result ${foreignSignal}, which is not in the retro input`);
  const webResultIds = unique(finding.webResultIds);
  const foreignWeb = webResultIds.find((id) => !input.webResults.has(id));
  if (foreignWeb !== undefined) return drop(`it cites the web result ${foreignWeb}, which this session did not receive`);
  const cites = (kind: SignalSourceKind) => signalResultIds.some((id) => input.signalResults.get(id) === kind);
  if (finding.kind === "factory" && runIds.length === 0) return drop("a factory finding cites no run");
  if (finding.kind === "error" && !cites("errors")) return drop("an error finding cites no result from an errors source");
  // docs/specs/retro-web-research.md. An idea rests on analytics or on the web. It stays human-gated.
  if (finding.kind === "idea" && !cites("analytics") && webResultIds.length === 0) return drop("an idea finding cites no analytics result and no web result");
  return {
    kept: {
      kind: finding.kind,
      title: finding.title.trim(),
      description: finding.description.trim(),
      runIds,
      signalResultIds,
      webResultIds,
      repositories: unique(finding.repositories).filter((name) => input.repositories.has(name)),
    },
  };
};

/** Two titles name the same finding when they match after trimming, collapsing whitespace and ignoring case. */
export const titleKeyOf = (title: string): string => title.trim().replace(/\s+/g, " ").toLowerCase();

/** The text of the Linear issue "Create issue" makes from a finding. */
export const findingIssueText = (
  finding: CheckedFinding,
  links: {
    runUrl: (runId: string) => string;
    signalResultUrl: (signalResultId: string) => string;
    webResultUrl: (webResultId: string) => string;
    retroUrl: string;
  },
): { title: string; description: string } => {
  const lines = [finding.description, "", `Proposed by a Factoree retro: ${links.retroUrl}`];
  if (finding.runIds.length > 0) lines.push("", "Runs:", ...finding.runIds.map((id) => `- ${links.runUrl(id)}`));
  if (finding.signalResultIds.length > 0) lines.push("", "Signal results:", ...finding.signalResultIds.map((id) => `- ${links.signalResultUrl(id)}`));
  if (finding.webResultIds.length > 0) lines.push("", "Web results:", ...finding.webResultIds.map((id) => `- ${links.webResultUrl(id)}`));
  if (finding.repositories.length > 0) lines.push("", "Repositories:", ...finding.repositories.map((name) => `- ${name}`));
  return { title: finding.title, description: lines.join("\n") };
};
