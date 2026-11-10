import { describeDecision, type FactoreeDecision } from "~/domain/runs/factoree-decision.js";
import { createHash } from "node:crypto";
import type { ValidationEvidenceKind, ValidationMethod } from "~/domain/validation/validation-contract.js";
import type { AssertionResult } from "~/domain/validation/validation-result.js";
import type { ReviewCategory, ReviewSeverity } from "~/domain/review/review-report.js";
import type { EvidenceKind } from "~/domain/evidence/evidence.js";
import type { AgentSessionOutcome, AgentUsageTotals } from "~/domain/runs/agent-session.js";

/**
 * SDD section 47, amended by docs/specs/proof-pack-and-visual-evidence.md. The Proof Pack has a
 * short body for a human and a full JSON document for an agent. Both come from one input, so they
 * cannot disagree. The body must not dump a raw log into Linear, so no type in this file carries
 * log text. A caller therefore cannot pass one, and the rule holds by construction.
 */

/** The largest number of changed files the document names one by one. */
export const MAX_LISTED_CHANGED_FILES = 50;

/** The largest number of characters one free text field contributes to the body. */
export const MAX_FIELD_CHARACTERS = 500;

/** docs/specs/proof-pack-and-visual-evidence.md fixes these body headings and this order. */
export const PROOF_PACK_HEADINGS = [
  "## Factoree delivery",
  "### Needs your attention",
  "### Visual evidence",
  "### Checks",
] as const;

/** The file name of the JSON document, in Linear and in the body link. */
export const PROOF_PACK_DOCUMENT_NAME = "proof-pack.json";

/** One stored artefact of SDD section 39. The bytes stay in storage, and the reference travels. */
export interface ProofPackEvidenceRef {
  kind: EvidenceKind;
  source: string;
  sha256: string;
  storageRef: string | null;
}

export interface ProofPackAssertion {
  id: string;
  requirement: string;
  /** SDD section 24. The observable behavior. It is the success criterion a human audits. */
  statement: string;
  method: ValidationMethod;
  requiredEvidence: ValidationEvidenceKind[];
  result: AssertionResult;
  reason: string;
  evidence: ProofPackEvidenceRef[];
  /**
   * docs/specs/browser-network-control.md. True when the browser plan of the assertion used
   * failRequest: the error it checked came from Factoree, not from the backend.
   */
  injectedFailure?: boolean;
}

/** docs/specs/repository-setup-and-services.md. One compose service that answered for an external API. */
export interface ProofPackFake {
  service: string;
  name: string;
}

/** One line per fake. A reviewer must know which data was not real. */
export const fakeLine = (fake: ProofPackFake): string =>
  `- FAKE ${fake.name}: the compose service "${fake.service}" answered for this API, so its data is not real.`;

/** The mark one assertion line carries when its plan injected a failed request. */
export const INJECTED_FAILURE_NOTE =
  "(error injected by Factoree with failRequest, not returned by the backend)";

/** SDD section 35. One deterministic check. The retained log stays out of the Proof Pack. */
export interface ProofPackCheck {
  name: string;
  command: string;
  exitCode: number;
  passed: boolean;
  durationMs: number;
  stdoutSha256: string;
  stderrSha256: string;
}

export interface ProofPackFinding {
  id: string;
  severity: ReviewSeverity;
  category: ReviewCategory;
  requirement: string;
  evidence: string;
  description: string;
  /** Factoree's own decision. SDD section 41. A non-blocking finding needs a human. */
  blocking: boolean;
  decisionReason: string;
  attempt: number;
}

export interface ProofPackContextItem {
  ref: string;
  authority: string;
  classification: string;
  sourceVersion: string;
  contentSha256: string | null;
  reason: string;
}

export interface ProofPackConflict {
  id: string;
  subject: string;
  winnerRef: string | null;
  loserRef: string | null;
  reason: string;
}

/** One `RunTarget` row of SDD section 18. The commit the Run pushed to one routed repository. */
export interface ProofPackRoutingTarget {
  fullName: string;
  baseSha: string;
  pullRequestUrl: string;
}

/** One sibling repository the Run read but did not change. SDD section 18. */
export interface ProofPackRoutingSibling {
  fullName: string;
  commitSha: string;
}

/** SDD section 18. Routing information. Absent when a Run predates multi-repository routing. */
export interface ProofPackRouting {
  productSlug: string;
  linearTeamKey: string;
  targets: ProofPackRoutingTarget[];
  siblingsRead: ProofPackRoutingSibling[];
  selectionReason: string;
}

/**
 * DI-15.23. One pass in which Factoree rejected the first Validation Plan and asked the validator
 * once for a corrected one. `outcome` is the outcome of the correction session.
 */
export interface ProofPackPlanCorrection {
  attempt: number;
  outcome: AgentSessionOutcome;
}

/** docs/specs/skill-registry.md. One skill the implementer loaded. */
export interface ProofPackSkill {
  name: string;
  source: "repository" | "registry" | "organization";
  /** The registry version, or null for a skill from a checkout. */
  version: number | null;
  /** The page of the skill in its registry, or null. */
  url: string | null;
}

/** docs/specs/skill-registry.md. One skill proposal of the run. */
export interface ProofPackSkillProposal {
  name: string;
  source: "registry" | "organization";
  state: "submitted" | "refused" | "failed";
  /** Where a person reviews it, or null. */
  url: string | null;
  reason: string | null;
}

export interface ProofPackInput {
  runId: string;
  workItem: { title: string; url: string | null };
  pullRequestUrl: string;
  /** The Reviewer's description of the change. It is labelled as such, and it decides nothing. */
  changeDescription: string;
  assertions: ProofPackAssertion[];
  checks: ProofPackCheck[];
  /** The agent claim of SDD section 41. Factoree's own decision drove the Run. */
  reviewVerdict: "pass" | "fail";
  /** The number of Reviewer sessions this Run ran. */
  reviewPasses: number;
  findings: ProofPackFinding[];
  contextItems: ProofPackContextItem[];
  /** SDD section 21. A discoverable item stays available through a tool and is not preloaded. */
  discoverableItemCount: number;
  conflicts: ProofPackConflict[];
  changedFiles: string[];
  patchByteLength: number;
  /** The check sprite preview of the last pass. It ends with the Run, so only the document holds it. */
  checkPreviewUrl: string | null;
  baseSha: string;
  patchSha256: string;
  commitSha: string;
  repairCount: number;
  repairLimit: number;
  /** docs/specs/autonomy-levels.md. The level of the Run, and one sentence for each cap that applied. */
  autonomyLevel?: string;
  autonomyReasons?: string[];
  /** docs/specs/check-isolation.md. Changed files that define a check. A human reads them first. */
  checkDefiningFiles?: string[];
  /** The visual evidence gap Factoree accepted at refinement, or null. */
  visualEvidenceGap: string | null;
  /** docs/specs/repository-setup-and-services.md. The fakes the last validation ran against. */
  fakes?: ProofPackFake[];
  /** SDD section 18. Present only for a Run that a routed Product produced. */
  routing?: ProofPackRouting;
  /** docs/specs/own-proposals-and-parallel-runs.md. Every proposal Factoree took without asking. */
  decisions?: FactoreeDecision[];
  /** docs/specs/own-proposals-and-parallel-runs.md. How far the base branch moved, or null. */
  baseMove?: ProofPackBaseMove | null;
  /** docs/specs/agent-session-usage-and-hangs.md. The usage of every agent session, per role. */
  agentUsage?: AgentUsageTotals;
  /** DI-21.56. The time the run waited for a run slot or a sandbox slot. */
  waitedMs?: number;
  /** Issue 6, DI-15.17. Why the model of the Run is a guess, or null. `defaultModelWarning` builds it. */
  modelWarning?: string | null;
  /** DI-15.23. The passes whose first Validation Plan Factoree rejected, in attempt order. */
  planCorrections?: ProofPackPlanCorrection[];
  /** docs/specs/skill-registry.md. The skills the implementer loaded, and its skill proposals. */
  skills?: ProofPackSkill[];
  skillProposals?: ProofPackSkillProposal[];
}

/**
 * Issue 6, DI-15.17. With no product model, opencode runs with no `--model` and picks its own
 * default. With no runner credential either, that default can be a free model with a quota, which
 * hung a real Run (FAC-45). The warning names the models the sessions reported.
 */
export const defaultModelWarning = (input: {
  productModel: string | null;
  hasRunnerCredential: boolean;
  /** The runner and the reported model of each agent session of the Run. */
  sessions: ReadonlyArray<{ runner: string; model: string | null }>;
}): string | null => {
  if (input.productModel !== null || input.hasRunnerCredential) return null;
  const opencode = input.sessions.filter((session) => session.runner === "opencode");
  if (opencode.length === 0) return null;
  const models = [...new Set(opencode.map((session) => session.model).filter((model): model is string => model !== null))];
  const chosen =
    models.length === 0 ? "opencode did not report which model it chose" : `opencode chose ${models.map((model) => `\`${model}\``).join(", ")}`;
  return (
    `The product sets no model and holds no runner credential, so ${chosen}. ` +
    "That default can be a free model with a quota. Set a model and a runner credential on the product page."
  );
};

export interface ProofPackBaseMove {
  baseBranch: string;
  headSha: string;
  ahead: number;
  conflicts: string[];
}

/** The JSON document an agent reads. `GET /admin/runs/:id` returns the same value. */
export interface ProofPackDocument {
  version: 1;
  runId: string;
  status: "READY_FOR_HUMAN";
  workItem: { title: string; url: string | null };
  pullRequestUrl: string;
  changeDescription: string;
  needsAttention: string[];
  visualEvidenceGap: string | null;
  fakes: ProofPackFake[];
  assertions: ProofPackAssertion[];
  /** DI-15.23. The passes whose first Validation Plan Factoree rejected. */
  planCorrections: ProofPackPlanCorrection[];
  checks: ProofPackCheck[];
  review: { verdict: "pass" | "fail"; passes: number; findings: ProofPackFinding[] };
  context: {
    items: ProofPackContextItem[];
    discoverableItemCount: number;
    conflicts: ProofPackConflict[];
  };
  change: {
    changedFiles: string[];
    changedFileCount: number;
    patchByteLength: number;
    checkDefiningFiles: string[];
  };
  routing: ProofPackRouting | null;
  decisions: FactoreeDecision[];
  baseMove: ProofPackBaseMove | null;
  /** docs/specs/agent-session-usage-and-hangs.md. The totals per role, or null when none was recorded. */
  agentUsage: AgentUsageTotals | null;
  /** docs/specs/skill-registry.md. The skills the implementer loaded, and its skill proposals. */
  skills: { loaded: ProofPackSkill[]; proposals: ProofPackSkillProposal[] };
  run: {
    baseSha: string;
    patchSha256: string;
    commitSha: string;
    repairCount: number;
    repairLimit: number;
    autonomyLevel: string | null;
    autonomyReasons: string[];
    checkPreviewUrl: string | null;
  };
}

/** Keeps one field inside the cap. A truncated field says so, so a reader never guesses. */
const cap = (value: string): string =>
  value.length <= MAX_FIELD_CHARACTERS
    ? value
    : `${value.slice(0, MAX_FIELD_CHARACTERS)} [truncated]`;

/** One line of the body. A newline breaks a list item, so it becomes a space. */
const line = (value: string): string => cap(value).replace(/\r?\n/g, " ").trim();

/** A link a reader in Linear can open. A worker-local `file:` reference opens for nobody. */
const openable = (ref: string | null): ref is string => ref !== null && /^https:\/\//.test(ref);

/**
 * docs/specs/proof-pack-and-visual-evidence.md. Everything a human must weigh before a merge, in
 * one list. A non-blocking finding, a check-defining file, an assertion that did not pass, and an
 * accepted visual evidence gap each need a human, and none of them may sit at the bottom.
 */
export const needsAttention = (input: ProofPackInput): string[] => {
  const items: string[] = [];
  // docs/specs/run-recovery.md. An unstable assertion is the first thing a human must weigh: the
  // pull request is a draft because Factoree could not prove it.
  for (const assertion of input.assertions.filter((candidate) => candidate.result === "UNSTABLE")) {
    items.push(
      `${assertion.id} is UNSTABLE, so the pull request is a draft: ${assertion.statement} ${assertion.reason} ` +
        "Check it by hand before you merge.",
    );
  }
  if (input.modelWarning !== undefined && input.modelWarning !== null) items.push(input.modelWarning);
  // docs/specs/own-proposals-and-parallel-runs.md. A conflict with the moved branch comes first,
  // because the pull request cannot merge until a human resolves it.
  const move = input.baseMove ?? null;
  if (move !== null && move.conflicts.length > 0) {
    items.push(`Conflicts with ${move.baseBranch} in ${move.conflicts.map((file) => `\`${file}\``).join(", ")}.`);
  }
  if (move !== null) {
    items.push(
      `Verified on \`${input.baseSha.slice(0, 7)}\`. ${move.baseBranch} is now \`${move.headSha.slice(0, 7)}\`, ` +
        `${move.ahead} ${move.ahead === 1 ? "commit" : "commits"} ahead.`,
    );
  }
  for (const decision of input.decisions ?? []) {
    items.push(decision.kind === "not_built" ? `Not built: ${decision.statement.replace(/^did not build /, "")}.` : describeDecision(decision));
  }
  const checkDefining = input.checkDefiningFiles ?? [];
  if (checkDefining.length > 0) {
    items.push(
      `The change edits files that define a check, so the pull request is a draft. Read them first: ${checkDefining.join(", ")}.`,
    );
  }
  for (const finding of input.findings.filter((candidate) => !candidate.blocking)) {
    items.push(
      `Review finding ${finding.id} (${finding.severity}, ${finding.category}) at ${finding.evidence}: ` +
        `${finding.description} It did not block, because ${finding.decisionReason}`,
    );
  }
  for (const assertion of input.assertions.filter((candidate) => candidate.result !== "PASS" && candidate.result !== "UNSTABLE")) {
    items.push(`${assertion.id} is ${assertion.result}: ${assertion.statement} ${assertion.reason}`);
  }
  // A gap Factoree accepted is one of its decisions. Only a gap without one is listed here.
  const gapDecided = (input.decisions ?? []).some((decision) => decision.kind === "visual_evidence");
  if (input.visualEvidenceGap !== null && !gapDecided) items.push(input.visualEvidenceGap);
  return items;
};

/** Builds the full JSON document. It holds every fact, and the body holds a short view of it. */
export const buildProofPackDocument = (input: ProofPackInput): ProofPackDocument => ({
  version: 1,
  runId: input.runId,
  status: "READY_FOR_HUMAN",
  workItem: input.workItem,
  pullRequestUrl: input.pullRequestUrl,
  changeDescription: input.changeDescription,
  needsAttention: needsAttention(input),
  decisions: input.decisions ?? [],
  baseMove: input.baseMove ?? null,
  visualEvidenceGap: input.visualEvidenceGap,
  fakes: input.fakes ?? [],
  assertions: input.assertions,
  planCorrections: input.planCorrections ?? [],
  checks: input.checks,
  review: { verdict: input.reviewVerdict, passes: input.reviewPasses, findings: input.findings },
  context: {
    items: input.contextItems,
    discoverableItemCount: input.discoverableItemCount,
    conflicts: input.conflicts,
  },
  change: {
    changedFiles: input.changedFiles.slice(0, MAX_LISTED_CHANGED_FILES),
    changedFileCount: input.changedFiles.length,
    patchByteLength: input.patchByteLength,
    checkDefiningFiles: input.checkDefiningFiles ?? [],
  },
  routing: input.routing ?? null,
  agentUsage: input.agentUsage ?? null,
  skills: { loaded: input.skills ?? [], proposals: input.skillProposals ?? [] },
  run: {
    baseSha: input.baseSha,
    patchSha256: input.patchSha256,
    commitSha: input.commitSha,
    repairCount: input.repairCount,
    repairLimit: input.repairLimit,
    autonomyLevel: input.autonomyLevel ?? null,
    autonomyReasons: input.autonomyReasons ?? [],
    checkPreviewUrl: input.checkPreviewUrl,
  },
});

const pullRequestLines = (input: ProofPackInput): string[] => {
  const targets = input.routing?.targets.filter((target) => target.pullRequestUrl !== "") ?? [];
  if (targets.length <= 1) return [`**Pull request:** ${input.pullRequestUrl}`];
  return [
    "**Pull requests:**",
    ...targets.map((target) => `- ${target.fullName}: ${target.pullRequestUrl}`),
  ];
};

const visualSection = (input: ProofPackInput): string[] => {
  const lines: string[] = [];
  for (const assertion of input.assertions) {
    for (const item of assertion.evidence) {
      if (!openable(item.storageRef)) continue;
      if (item.kind === "screenshot") lines.push(`![${assertion.id}](${item.storageRef})`);
      if (item.kind === "video") lines.push(`[${assertion.id} video](${item.storageRef})`);
    }
  }
  return lines;
};

const evidenceLinks = (assertion: ProofPackAssertion): string => {
  const links = assertion.evidence
    .filter((item) => openable(item.storageRef))
    .map((item) => `[${item.kind}](${item.storageRef ?? ""})`);
  return links.length === 0 ? "" : ` ${links.join(" ")}`;
};

/** DI-15.23. One line per pass whose first Validation Plan Factoree rejected. */
export const planCorrectionLine = (correction: ProofPackPlanCorrection): string =>
  `- Validation Plan, attempt ${correction.attempt}: Factoree rejected the validator's first plan ` +
  "and asked once for a corrected plan" +
  (correction.outcome === "hung"
    ? ". That session hung, and a fresh validator session wrote the plan that ran."
    : ". The corrected plan passed the plan rules and ran.");

const checkLines = (input: ProofPackInput): string[] => {
  const blocking = input.findings.filter((finding) => finding.blocking).length;
  return [
    ...input.checks.map(
      (check) => `- ${check.passed ? "PASS" : "FAIL"} ${line(check.name)}: \`${line(check.command)}\``,
    ),
    ...input.assertions.map(
      (assertion) =>
        `- ${assertion.result} ${assertion.id}: ${line(assertion.statement)}` +
        `${assertion.injectedFailure === true ? ` ${INJECTED_FAILURE_NOTE}` : ""}${evidenceLinks(assertion)}`,
    ),
    ...(input.planCorrections ?? []).map(planCorrectionLine),
    ...(input.fakes ?? []).map(fakeLine),
    `- ${blocking === 0 ? "PASS" : "FAIL"} Independent review: ${input.reviewPasses} ` +
      `${input.reviewPasses === 1 ? "pass" : "passes"}, ${input.findings.length} ` +
      `${input.findings.length === 1 ? "finding" : "findings"}, ${blocking} blocking.`,
  ];
};

/** A duration as a human reads it: hours and minutes, minutes and seconds, or seconds. */
const formatDuration = (milliseconds: number): string => {
  const seconds = Math.round(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
};

/**
 * docs/specs/agent-session-usage-and-hangs.md. One line with the total cost, the tokens and the
 * model time. A session with no usage record is named, so a reader never takes a partial total
 * for the whole cost.
 */
export const agentUsageLine = (usage: AgentUsageTotals, waitedMs = 0): string => {
  const missing = usage.sessionsWithoutUsage;
  return [
    `**Agent usage:** $${usage.costUsd.toFixed(2)}`,
    `${usage.tokens.toLocaleString("en-US")} tokens`,
    `${formatDuration(usage.modelTimeMs)} model time`,
    // DI-21.56. A wait for a run slot or a sandbox slot is not work, so it stands apart.
    ...(waitedMs >= 1_000 ? [`waited ${formatDuration(waitedMs)} for a free slot`] : []),
    ...(missing === 0 ? [] : [`${missing} ${missing === 1 ? "session" : "sessions"} without a usage record`]),
  ].join(" · ");
};

/** docs/specs/skill-registry.md. Each loaded skill with its source and version, and each proposal. */
export const skillLines = (input: ProofPackInput): string[] => {
  const lines: string[] = [];
  const loaded = input.skills ?? [];
  if (loaded.length > 0) {
    const named = loaded.map((skill) => {
      const label = `${skill.name}${skill.version === null ? "" : ` v${skill.version}`} (${skill.source})`;
      return openable(skill.url) ? `[${label}](${skill.url})` : label;
    });
    lines.push(`**Skills loaded:** ${named.join(", ")}`);
  }
  for (const proposal of input.skillProposals ?? []) {
    const target = proposal.source === "registry" ? "the skill registry" : "the organization skills repository";
    if (proposal.state === "submitted") {
      lines.push(
        `**Skill proposal:** ${proposal.name}, sent to ${target} for review` +
          (openable(proposal.url) ? `: ${proposal.url}` : "."),
      );
    } else {
      lines.push(
        `**Skill proposal:** ${proposal.name}, ${proposal.state === "refused" ? "refused by" : "not sent to"} ${target}: ` +
          line(proposal.reason ?? "no reason given"),
      );
    }
  }
  return lines;
};

const footer = (input: ProofPackInput, documentUrl: string | null): string =>
  [
    `Run ${input.runId}`,
    ...(input.autonomyLevel === undefined ? [] : [input.autonomyLevel]),
    `repairs ${input.repairCount} of ${input.repairLimit}`,
    documentUrl === null ? `${PROOF_PACK_DOCUMENT_NAME} not stored` : `[${PROOF_PACK_DOCUMENT_NAME}](${documentUrl})`,
  ].join(" · ");

/** docs/specs/proof-pack-and-visual-evidence.md. The short body a human reads in Linear. */
export const renderProofPack = (input: ProofPackInput, documentUrl: string | null): string => {
  const attention = needsAttention(input);
  const visual = visualSection(input);
  const description = line(input.changeDescription);
  return [
    "## Factoree delivery",
    "",
    `**Ready for human review.** ${line(input.workItem.title)}${
      input.workItem.url === null ? "" : ` (${input.workItem.url})`
    }`,
    "",
    description === "" ? "The Reviewer gave no description of the change." : `> ${description}`,
    "",
    "_The Reviewer's description of the change._",
    "",
    ...pullRequestLines(input),
    "**Preview:** the pull request preview link appears in this session's links when CI publishes it.",
    "",
    "### Needs your attention",
    "",
    ...(attention.length === 0 ? ["Nothing."] : attention.map((item) => `- ${line(item)}`)),
    "",
    "### Visual evidence",
    "",
    ...(visual.length === 0 ? ["None captured."] : visual),
    "",
    "### Checks",
    "",
    ...checkLines(input),
    "",
    ...(input.agentUsage === undefined || input.agentUsage.roles.length === 0 ? [] : [agentUsageLine(input.agentUsage, input.waitedMs ?? 0), ""]),
    ...(skillLines(input).length === 0 ? [] : [...skillLines(input), ""]),
    "---",
    "",
    footer(input, documentUrl),
    "",
  ].join("\n");
};

/** The identity of one Proof Pack body. The Run row records it, so its existence is provable. */
export const hashProofPack = (body: string): string =>
  createHash("sha256").update(body, "utf8").digest("hex");
