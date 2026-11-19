import type { Run } from "../run.js";
import type { Verified } from "./attempts.js";
import type { ResolvedContext } from "./context.js";
import type { Refined } from "./refinement.js";

/** One sentence that names the level rules that applied, or none. */
const autonomyNote = (reasons: string[]): string => (reasons.length === 0 ? "The Product default level applies." : reasons.join(" "));

/** docs/specs/autonomy-levels.md. L0 reads and reports. The Context Contract is the report, and no sandbox starts. */
export const reportL0 = (run: Run, refined: Refined, context: ResolvedContext): Promise<never> =>
  run.report(
    [
      "## Factoree report",
      "",
      `Status: REPORTED at L0. ${autonomyNote(refined.autonomyReasons)}`,
      "",
      "### Context",
      "",
      context.summary,
      "",
      "### Risks",
      "",
      refined.risks.length === 0 ? "None." : refined.risks.map((risk) => `- ${risk}`).join("\n"),
      "",
      "Factoree changed nothing and opened no pull request.",
    ].join("\n"),
  );

/** docs/specs/autonomy-levels.md. L1 implements and checks, and returns the evidence with no pull request. */
export const reportL1 = (run: Run, refined: Refined, verified: Verified): Promise<never> =>
  run.report(
    [
      "## Factoree report",
      "",
      `Status: REPORTED at L1. ${autonomyNote(refined.autonomyReasons)}`,
      "",
      "### Deterministic verification",
      "",
      verified.verificationSummary,
      "",
      "### Independent review",
      "",
      `Verdict: ${verified.reviewVerdict}. Blocking findings: ${String(verified.blockingCount)}.`,
      "",
      "### Change",
      "",
      verified.changedFiles.length === 0 ? "No file changed." : verified.changedFiles.map((file) => `- ${file}`).join("\n"),
      "",
      "Every check passed. By its level, this Run opens no pull request.",
    ].join("\n"),
  );
