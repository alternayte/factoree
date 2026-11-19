import { describe, expect, it } from "vitest";
import { implementerResultPath } from "~/activities/agent.activities.js";
import {
  agentSessionKey,
  planCorrectionSessionKey,
  refinerLimitCorrectionSessionKey,
  refinerProposalName,
  reviewerReportName,
  selectorRecheckDirectoryName,
  selectorRecheckSessionKey,
  triageReportName,
  triageSessionKey,
  validatorPlanName,
} from "~/domain/runs/agent-session.js";

/**
 * docs/specs/provider-unreachable.md, plan section 8. Two sessions of one step never share a
 * session key, a result file or a directory, whatever the order of hangs and outages.
 */

const RUN = "run-1";
const WORKSPACE = "/workspace";

/** The (afterHang, unreachableRetry) pairs the issue names: retry 0, 1 and 2, with and without a hang. */
const PAIRS: Array<[boolean, number]> = [
  [false, 0],
  [false, 1],
  [false, 2],
  [true, 0],
  [true, 1],
  [true, 2],
];

describe("the session key functions", () => {
  const families: Array<[string, (afterHang: boolean, retry: number) => string]> = [
    ["agentSessionKey", (afterHang, retry) => agentSessionKey(RUN, "validator", 2, afterHang, retry)],
    ["planCorrectionSessionKey", (afterHang, retry) => planCorrectionSessionKey(RUN, 2, afterHang, retry)],
    ["selectorRecheckSessionKey", (afterHang, retry) => selectorRecheckSessionKey(RUN, 2, afterHang, retry)],
    ["refinerLimitCorrectionSessionKey", (afterHang, retry) => refinerLimitCorrectionSessionKey(RUN, afterHang, retry)],
    ["triageSessionKey", (afterHang, retry) => triageSessionKey(RUN, afterHang, retry)],
  ];

  it.each(families)("%s gives six distinct keys for retry 0, 1 and 2, with and without a hang", (_name, keyOf) => {
    const keys = PAIRS.map(([afterHang, retry]) => keyOf(afterHang, retry));
    expect(new Set(keys).size).toBe(6);
  });

  it.each(families)("%s gives distinct keys for the retries a hang adds (3 and 4)", (_name, keyOf) => {
    const keys = [...PAIRS, [true, 3] as [boolean, number], [true, 4] as [boolean, number]].map(([afterHang, retry]) => keyOf(afterHang, retry));
    expect(new Set(keys).size).toBe(8);
  });

  // Stored rows and replayed histories keep their keys, so retry 0 never changes shape.
  it("keeps the legacy key of retry 0, as a golden string", () => {
    expect(agentSessionKey(RUN, "implementer", 3, false)).toBe("run:run-1:implementer:3");
    expect(agentSessionKey(RUN, "validator", 2, false)).toBe("run:run-1:validator:2");
    expect(agentSessionKey(RUN, "validator", 2, true)).toBe("run:run-1:validator:2:after-hang");
    expect(agentSessionKey(RUN, "reviewer", 2, false, 0)).toBe("run:run-1:reviewer:2");
    expect(agentSessionKey(RUN, "refiner", null, false)).toBe("run:run-1:refiner");
    expect(agentSessionKey(RUN, "refiner", null, true)).toBe("run:run-1:refiner:after-hang");
    expect(planCorrectionSessionKey(RUN, 2, false)).toBe("run:run-1:validator:2:plan-correction");
    expect(planCorrectionSessionKey(RUN, 2, true)).toBe("run:run-1:validator:2:after-hang:plan-correction");
    expect(selectorRecheckSessionKey(RUN, 2, false)).toBe("run:run-1:validator:2:selector-recheck");
    expect(selectorRecheckSessionKey(RUN, 2, true)).toBe("run:run-1:validator:2:after-hang:selector-recheck");
    expect(refinerLimitCorrectionSessionKey(RUN, false)).toBe("run:run-1:refiner:limit-correction");
    expect(refinerLimitCorrectionSessionKey(RUN, true)).toBe("run:run-1:refiner:after-hang:limit-correction");
    expect(triageSessionKey(RUN, false)).toBe("run:run-1:reviewer:triage");
    expect(triageSessionKey(RUN, true)).toBe("run:run-1:reviewer:after-hang:triage");
  });

  it("names a retry in the key, after the hang marker", () => {
    expect(agentSessionKey(RUN, "validator", 2, true, 1)).toBe("run:run-1:validator:2:after-hang:unreachable-1");
    expect(planCorrectionSessionKey(RUN, 2, true, 2)).toBe("run:run-1:validator:2:after-hang:unreachable-2:plan-correction");
    expect(selectorRecheckSessionKey(RUN, 2, true, 1)).toBe("run:run-1:validator:2:after-hang:unreachable-1:selector-recheck");
    expect(refinerLimitCorrectionSessionKey(RUN, true, 1)).toBe("run:run-1:refiner:after-hang:unreachable-1:limit-correction");
    expect(triageSessionKey(RUN, true, 3)).toBe("run:run-1:reviewer:after-hang:unreachable-3:triage");
  });
});

describe("the file and directory names a retry writes", () => {
  it("keeps the legacy name of retry 0, as golden strings", () => {
    expect(implementerResultPath(WORKSPACE, 2, 0)).toBe("/workspace/implementer/result-2.json");
    expect(implementerResultPath(WORKSPACE, 2)).toBe("/workspace/implementer/result-2.json");
    expect(refinerProposalName(false, 0)).toBe("proposal");
    expect(refinerProposalName(true, 0)).toBe("proposal-after-hang");
    expect(validatorPlanName(false, 0)).toBe("plan");
    expect(validatorPlanName(true, 0)).toBe("plan-after-hang");
    expect(selectorRecheckDirectoryName(false, 0)).toBe("selector-recheck");
    expect(selectorRecheckDirectoryName(true, 0)).toBe("selector-recheck-after-hang");
    expect(reviewerReportName(2, false, 0)).toBe("report-2.json");
    expect(reviewerReportName(2, true, 0)).toBe("report-2-after-hang.json");
    expect(triageReportName(false, 0)).toBe("report.json");
    expect(triageReportName(true, 0)).toBe("report-after-hang.json");
  });

  it("gives implementerResultPath a different file for retry 0, 1 and 2", () => {
    const paths = [0, 1, 2].map((retry) => implementerResultPath(WORKSPACE, 2, retry));
    expect(new Set(paths).size).toBe(3);
    expect(paths[1]).toBe("/workspace/implementer/result-2-unreachable-1.json");
  });

  it("gives implementerResultPath a different file for each attempt", () => {
    expect(implementerResultPath(WORKSPACE, 1, 1)).not.toBe(implementerResultPath(WORKSPACE, 2, 1));
  });

  it.each([
    ["refinerProposalName", (afterHang: boolean, retry: number) => refinerProposalName(afterHang, retry)],
    ["validatorPlanName", (afterHang: boolean, retry: number) => validatorPlanName(afterHang, retry)],
    ["selectorRecheckDirectoryName", (afterHang: boolean, retry: number) => selectorRecheckDirectoryName(afterHang, retry)],
    ["reviewerReportName", (afterHang: boolean, retry: number) => reviewerReportName(2, afterHang, retry)],
    ["triageReportName", (afterHang: boolean, retry: number) => triageReportName(afterHang, retry)],
  ])("%s gives six distinct names for retry 0, 1 and 2, with and without a hang", (_name, nameOf) => {
    expect(new Set(PAIRS.map(([afterHang, retry]) => nameOf(afterHang, retry))).size).toBe(6);
  });
});

// ---------------------------------------------------------------------------------------------
// Every reachable sequence of sessions of one step, with the real key functions and path builders.
// ---------------------------------------------------------------------------------------------

type Outcome = "ok" | "outage" | "hang";
type Start = { afterHang: boolean; retry: number };

/** The activity turns a retry into a fresh session: `afterHang = input.afterHang || unreachableRetry > 0`. */
const start = (afterHang: boolean, retry: number): Start => ({ afterHang: afterHang || retry > 0, retry });

/** Raised when a script has no outcome left for the next session. */
class NeedMoreOutcomes extends Error {}

/**
 * The sessions one step of the refiner, the validator, the reviewer or the triage starts, for a
 * script of outcomes, one per session. It follows `retryWhileUnreachable` of the workflow: the
 * first series passes retry 1 and 2, a hang starts one fresh session with no retry number, and
 * the series after the hang passes `PROVIDER_UNREACHABLE_ATTEMPTS - 1 + retry`, which is 3 and 4.
 */
const seriesStep = (script: Outcome[]): Start[] => {
  const starts: Start[] = [];
  let index = 0;
  const launch = (afterHang: boolean, retry: number): Outcome => {
    starts.push(start(afterHang, retry));
    const outcome = script[index];
    if (outcome === undefined) throw new NeedMoreOutcomes("the script has no outcome left");
    index += 1;
    return outcome;
  };
  const series = (first: Outcome, afterHang: boolean, offset: number): Outcome => {
    let outcome = first;
    for (let retry = 1; retry < 3 && outcome === "outage"; retry += 1) outcome = launch(afterHang, offset + retry);
    return outcome;
  };
  const first = series(launch(false, 0), false, 0);
  // A second series, after a hang. An outage that outlasts a series ends the Run, and so does a second hang.
  if (first === "hang") series(launch(true, 0), true, 2);
  return starts;
};

type Move = Outcome | "repair";

/**
 * The sessions of the Implementer for a script of outcomes. It follows the main loop of the
 * workflow: an outage retries the same attempt (at most 2 retries, then the Run ends), a hang
 * resumes the session as the next attempt with retry 0 and uses the repair budget, and a failed
 * check is a repair with the next attempt. A resume reuses the hung session, so it writes the
 * row of the new attempt. `maxRepairs` bounds the sequences.
 */
const implementerStep = (script: Move[], maxRepairs = 2): Array<{ attempt: number; retry: number }> => {
  const starts: Array<{ attempt: number; retry: number }> = [];
  let index = 0;
  let attempt = 1;
  let retry = 0;
  let repairs = 0;
  let resumedAfterHang = false;
  for (;;) {
    starts.push({ attempt, retry });
    const move = script[index];
    if (move === undefined) throw new NeedMoreOutcomes("the script has no outcome left");
    index += 1;
    if (move === "outage") {
      if (retry >= 2) return starts;
      retry += 1;
      continue;
    }
    retry = 0;
    if (move === "ok") return starts;
    if (repairs >= maxRepairs) return starts;
    if (move === "hang") {
      if (resumedAfterHang) return starts;
      resumedAfterHang = true;
    } else {
      resumedAfterHang = false;
    }
    repairs += 1;
    attempt += 1;
  }
};

/** Every complete script of `moves`, found by extending the script that ran out of outcomes. */
const enumerate = <T, R>(moves: T[], run: (script: T[]) => R): Array<{ script: T[]; result: R }> => {
  const complete: Array<{ script: T[]; result: R }> = [];
  const pending: T[][] = [[]];
  while (pending.length > 0) {
    const script = pending.pop()!;
    try {
      complete.push({ script, result: run(script) });
    } catch (error) {
      if (!(error instanceof NeedMoreOutcomes)) throw error;
      for (const move of moves) pending.push([...script, move]);
    }
  }
  return complete;
};

const expectUnique = (values: string[], context: string): void => {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  expect(duplicates, context).toEqual([]);
};

describe("every reachable sequence of sessions of one step", () => {
  const outcomes: Outcome[] = ["ok", "outage", "hang"];
  const sequences = enumerate(outcomes, seriesStep);

  it("covers the sequences the workflow can reach", () => {
    const shapes = new Set(sequences.map(({ result }) => result.map((entry) => `${entry.afterHang ? "h" : "f"}${String(entry.retry)}`).join(" ")));
    // outage only (and its exhaustion), hang only, hang then outage, outage then hang, outage twice then hang.
    expect(shapes).toContain("f0 h1 h2");
    expect(shapes).toContain("f0 h0");
    expect(shapes).toContain("f0 h0 h3 h4");
    expect(shapes).toContain("f0 h1 h0 h3 h4");
    expect(shapes).toContain("f0 h1 h2 h0 h3 h4");
    expect(shapes).toContain("f0");
    expect(sequences.length).toBeGreaterThan(10);
  });

  it("gives the refiner a distinct session key, correction key and file for every session", () => {
    for (const { script, result } of sequences) {
      const keys = result.flatMap(({ afterHang, retry }) => [
        agentSessionKey(RUN, "refiner", null, afterHang, retry),
        refinerLimitCorrectionSessionKey(RUN, afterHang, retry),
      ]);
      const files = result.flatMap(({ afterHang, retry }) => {
        const base = refinerProposalName(afterHang, retry);
        return [`${WORKSPACE}/refinement/${base}.json`, `${WORKSPACE}/refinement/${base}-corrected.json`];
      });
      expectUnique(keys, `refiner keys, script ${script.join(",")}`);
      expectUnique(files, `refiner files, script ${script.join(",")}`);
    }
  });

  it("gives the validator a distinct session key, correction key, re-check key, file and directory for every session", () => {
    for (const { script, result } of sequences) {
      for (const attempt of [1, 2]) {
        const keys = result.flatMap(({ afterHang, retry }) => [
          agentSessionKey(RUN, "validator", attempt, afterHang, retry),
          planCorrectionSessionKey(RUN, attempt, afterHang, retry),
          selectorRecheckSessionKey(RUN, attempt, afterHang, retry),
        ]);
        const files = result.flatMap(({ afterHang, retry }) => {
          const plan = validatorPlanName(afterHang, retry);
          return [
            `${WORKSPACE}/validation/${plan}.json`,
            `${WORKSPACE}/validation/${plan}-corrected.json`,
            `${WORKSPACE}/validation/${selectorRecheckDirectoryName(afterHang, retry)}/corrected-entries.json`,
          ];
        });
        expectUnique(keys, `validator keys, attempt ${String(attempt)}, script ${script.join(",")}`);
        expectUnique(files, `validator files, attempt ${String(attempt)}, script ${script.join(",")}`);
      }
    }
  });

  it("gives the reviewer a distinct session key and report for every session", () => {
    for (const { script, result } of sequences) {
      const keys = result.map(({ afterHang, retry }) => agentSessionKey(RUN, "reviewer", 2, afterHang, retry));
      const files = result.map(({ afterHang, retry }) => `${WORKSPACE}/review/${reviewerReportName(2, afterHang, retry)}`);
      expectUnique(keys, `reviewer keys, script ${script.join(",")}`);
      expectUnique(files, `reviewer files, script ${script.join(",")}`);
    }
  });

  it("gives the triage a distinct session key and report for every session, apart from every reviewer pass", () => {
    for (const { script, result } of sequences) {
      const keys = result.map(({ afterHang, retry }) => triageSessionKey(RUN, afterHang, retry));
      const reviewerKeys = result.map(({ afterHang, retry }) => agentSessionKey(RUN, "reviewer", 1, afterHang, retry));
      const files = result.map(({ afterHang, retry }) => `${WORKSPACE}/triage/${triageReportName(afterHang, retry)}`);
      expectUnique([...keys, ...reviewerKeys], `triage keys, script ${script.join(",")}`);
      expectUnique(files, `triage files, script ${script.join(",")}`);
    }
  });
});

describe("every reachable sequence of Implementer sessions", () => {
  const moves: Move[] = ["ok", "outage", "hang", "repair"];
  const sequences = enumerate(moves, (script) => implementerStep(script));

  it("covers outage then hang, hang then outage, and a repair after an outage", () => {
    const shapes = new Set(sequences.map(({ result }) => result.map((entry) => `${String(entry.attempt)}.${String(entry.retry)}`).join(" ")));
    expect(shapes).toContain("1.0 1.1 1.2");
    expect(shapes).toContain("1.0 1.1 2.0");
    expect(shapes).toContain("1.0 2.0 2.1 2.2");
    expect(shapes).toContain("1.0 1.1 2.0 2.1");
  });

  it("gives every session a distinct key and result file", () => {
    for (const { script, result } of sequences) {
      const sessionKeys = result.map(({ attempt, retry }) => agentSessionKey(RUN, "implementer", attempt, false, retry));
      const files = result.map(({ attempt, retry }) => implementerResultPath(WORKSPACE, attempt, retry));
      expectUnique(sessionKeys, `implementer keys, script ${script.join(",")}`);
      expectUnique(files, `implementer files, script ${script.join(",")}`);
    }
  });

  it("counts a real attempt only: a retry keeps the attempt and changes the retry number", () => {
    for (const { script, result } of sequences) {
      result.forEach((entry, index) => {
        const previous = result[index - 1];
        if (previous === undefined || entry.retry === 0) return;
        expect(entry.attempt, `script ${script.join(",")}`).toBe(previous.attempt);
        expect(entry.retry, `script ${script.join(",")}`).toBe(previous.retry + 1);
      });
    }
  });
});
