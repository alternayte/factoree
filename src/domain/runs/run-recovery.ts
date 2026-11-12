import type { RunDetail } from "./run-view.js";

/**
 * docs/specs/run-recovery.md. A failed run tells the human what blocked it, from recorded facts,
 * and a reply in the same agent session starts a follow-up run.
 */

/**
 * The run statuses a reply turns into a follow-up run. DI-21.32: a configuration failure takes one
 * too, because Factoree cannot tell a repository fault from a sandbox fault in a failed compose
 * start or bootstrap, and the human repairs either one before the reply.
 */
export const FOLLOW_UP_STATUSES = ["FAILED", "FAILED_REVIEW", "STALE_BASE", "FAILED_CONFIGURATION"] as const;

export const takesFollowUp = (status: string): boolean => (FOLLOW_UP_STATUSES as readonly string[]).includes(status);

/** The one line Factoree answers a reply with when the run takes no follow-up. */
export const noFollowUpLine = (status: string, pullRequestUrl: string | null): string => {
  if (status === "READY_FOR_HUMAN" || status === "REPORTED") {
    return (
      "This run is complete, so Factoree starts no new run here. " +
      (pullRequestUrl === null
        ? "Put a further change in a new issue."
        : `Comment on the pull request (${pullRequestUrl}) or put a further change in a new issue.`)
    );
  }
  // docs/specs/draft-of-failed-run.md. The draft pull request has its own review loop.
  if (status === "DRAFT_PUBLISHED") {
    return pullRequestUrl === null
      ? "Put a further change in a new issue."
      : `Comment on the pull request (${pullRequestUrl}) or put a further change in a new issue.`;
  }
  if (status === "CANCELLED") return "This run was stopped, so Factoree starts no new run here. Delegate the issue again to start one.";
  if (status.startsWith("BLOCKED")) {
    return "This run failed on its configuration, so a new run would fail the same way. Repair the configuration, then delegate the issue again.";
  }
  return "Factoree starts no new run for this run.";
};

/** The largest number of facts a failure post lists, so one Linear post stays readable. */
export const MAX_FAILURE_FACTS = 10;

const oneLine = (text: string, limit = 300): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
};

/** The path of a finding's evidence, such as `components/Nav.tsx` from `components/Nav.tsx:12`. */
const fileOf = (evidence: string): string | null => {
  const match = /^([\w./-]+\.[A-Za-z0-9]+)(?::\d+)?/.exec(evidence.trim());
  return match?.[1] ?? null;
};

/**
 * DI-21.33. The facts of a run whose newest attempt failed a check, or no facts when the newest
 * attempt passed every assertion and has no blocking finding. Such a run failed after its checks,
 * at publication for example, and an earlier failure that a repair fixed did not block it. A run
 * whose newest attempt failed keeps every attempt, because a result that flips between attempts
 * is itself a fact (FAC-73).
 */
const blockingAttempts = (run: Pick<RunDetail, "assertions" | "findings">): Pick<RunDetail, "assertions" | "findings"> => {
  const attempt = Math.max(0, ...run.assertions.map((a) => a.attempt), ...run.findings.map((f) => f.attempt));
  const newestFailed =
    run.assertions.some((assertion) => assertion.attempt === attempt && assertion.result !== "PASS") ||
    run.findings.some((finding) => finding.attempt === attempt && finding.blocking);
  return newestFailed ? run : { assertions: [], findings: [] };
};

/** Each recorded fact that blocked the run, newest attempt first. */
export const failureFacts = (all: Pick<RunDetail, "assertions" | "findings">): string[] => {
  const run = blockingAttempts(all);
  const facts: Array<{ attempt: number; text: string }> = [];
  for (const assertion of run.assertions) {
    if (assertion.result === "PASS") continue;
    facts.push({
      attempt: assertion.attempt,
      text: `Attempt ${assertion.attempt}: ${assertion.key} is ${assertion.result} (${assertion.method}). ${oneLine(assertion.statement, 160)} ${oneLine(assertion.reason, 200)}`,
    });
  }
  for (const finding of run.findings) {
    if (!finding.blocking) continue;
    facts.push({
      attempt: finding.attempt,
      text: `Attempt ${finding.attempt}: review finding ${finding.key} (${finding.severity}) at ${oneLine(finding.evidence, 120)} blocks the change. ${oneLine(finding.description, 200)}`,
    });
  }
  return facts.sort((left, right) => right.attempt - left.attempt).map((fact) => fact.text);
};

/** Example replies built from the facts, so the human sees what a useful reply looks like. */
export const exampleReplies = (all: Pick<RunDetail, "assertions" | "findings">): string[] => {
  const run = blockingAttempts(all);
  const replies: string[] = [];
  const keys = [...new Set(run.assertions.filter((assertion) => assertion.result !== "PASS").map((assertion) => assertion.key))];
  for (const key of keys.slice(0, 2)) {
    replies.push(`Drop ${key}.`);
    replies.push(`Replace ${key}: check the change in the source, not in a browser.`);
  }
  const files = [
    ...new Set(
      run.findings.filter((finding) => finding.blocking).flatMap((finding) => {
        const file = fileOf(finding.evidence);
        return file === null ? [] : [file];
      }),
    ),
  ];
  for (const file of files.slice(0, 2)) replies.push(`Do not change ${file}.`);
  if (replies.length === 0) replies.push("Say what the run must do differently, for example a file to change or a criterion to drop.");
  return replies;
};

/**
 * The failure post of a run that can take a follow-up: what blocked it, and how to reply. A
 * configuration failure asks for the repair first, because a follow-up on the same configuration
 * and the same sandbox fails the same way (DI-21.32).
 */
export const renderFailurePost = (
  message: string,
  run: Pick<RunDetail, "assertions" | "findings">,
  kind: "run" | "configuration" = "run",
): string => {
  if (kind === "configuration") {
    return [
      message,
      "",
      "**Repair the configuration or the sandbox, then reply here to start a follow-up run.** " +
        "The follow-up run starts a new sandbox and refines the issue again with your reply as a decision.",
    ].join("\n");
  }
  const facts = failureFacts(run);
  return [
    message,
    "",
    ...(facts.length === 0
      ? []
      : [
          "**What blocked the run**",
          ...facts.slice(0, MAX_FAILURE_FACTS).map((fact) => `- ${fact}`),
          ...(facts.length > MAX_FAILURE_FACTS ? [`- ${facts.length - MAX_FAILURE_FACTS} more on the run page.`] : []),
          "",
        ]),
    "**Reply here with guidance to start a follow-up run.** It refines the issue again with your reply as a decision, so your reply can drop or change a criterion. For example:",
    ...exampleReplies(run).map((reply) => `- "${reply}"`),
  ].join("\n");
};

/** The largest previous patch a follow-up run carries in full. A larger one names its files only. */
export const MAX_REFERENCE_PATCH_BYTES = 32_768;

/**
 * The work item text of a follow-up run. The reply ranks above every other sentence, and the
 * facts and the previous patch are reference only: the run starts from the base.
 */
export const renderFollowUpDescription = (input: {
  description: string;
  reply: string;
  failedRunId: string;
  run: Pick<RunDetail, "assertions" | "findings">;
  previousPatch: string | null;
}): string => {
  const frozen = [...new Map(input.run.assertions.map((assertion) => [assertion.key, assertion])).values()];
  const patch = input.previousPatch;
  return [
    input.description,
    "",
    "## Follow-up guidance from a human",
    "",
    "This guidance outranks every other sentence of this issue. Follow it.",
    "",
    input.reply.trim(),
    "",
    `## The failed run this follows up (${input.failedRunId})`,
    "",
    "The criteria it froze:",
    ...(frozen.length === 0 ? ["- none recorded"] : frozen.map((assertion) => `- ${assertion.key}: ${oneLine(assertion.statement, 200)}`)),
    "",
    "What blocked it:",
    ...(failureFacts(input.run).length === 0 ? ["- nothing recorded"] : failureFacts(input.run).slice(0, MAX_FAILURE_FACTS).map((fact) => `- ${fact}`)),
    "",
    ...(patch === null
      ? []
      : patch.length <= MAX_REFERENCE_PATCH_BYTES
        ? ["Its last patch, for reference only. Start from the base, not from this patch:", "", "```diff", patch.trimEnd(), "```"]
        : ["Its last patch was too large to repeat here. Start from the base."]),
  ].join("\n");
};
