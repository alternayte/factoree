import { describe, expect, it } from "vitest";
import {
  decideAutoMerge,
  gateGaps,
  mergeMethodOf,
  openChangeRequests,
  unmetConditions,
  type AutoMergeGate,
  type PullRequestOnGitHub,
} from "~/domain/pull-requests/auto-merge.js";
import { graphqlUrlOf } from "~/adapters/github/github-auto-merge.js";

const pullRequest = (overrides: Partial<PullRequestOnGitHub> = {}): PullRequestOnGitHub => ({
  nodeId: "PR_1",
  headSha: "head-1",
  open: true,
  draft: false,
  mergeableState: "blocked",
  mergeable: true,
  autoMergeEnabled: false,
  baseBranch: "main",
  ...overrides,
});

const gate = (overrides: Partial<AutoMergeGate["settings"]> = {}, baseRequirements = ["pull_request"]): AutoMergeGate => ({
  settings: { allowAutoMerge: true, allowSquash: true, allowMergeCommit: true, allowRebase: true, ...overrides },
  baseRequirements,
  requiresUpToDate: false,
});

const holding = {
  level: "L4",
  verifiedHeadSha: "head-1",
  pullRequest: pullRequest(),
  reviewAppHolds: [],
  changeRequests: [],
};

/** docs/specs/pr-review-merge-and-deploy.md, D5, DI-21.104 to DI-21.107. */
describe("the L4 merge", () => {
  it("names each setting the gate misses", () => {
    expect(gateGaps(gate(), "acme/api", "main")).toEqual([]);
    const gaps = gateGaps(gate({ allowAutoMerge: false }, []), "acme/api", "main");
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toContain("Allow auto-merge");
    expect(gaps[1]).toContain("main");
    expect(gateGaps(gate({ allowAutoMerge: null }), "acme/api", "main")[0]).toContain("could not read");
  });

  it("merges with squash, else the first method the repository allows", () => {
    expect(mergeMethodOf(gate().settings)).toBe("squash");
    expect(mergeMethodOf(gate({ allowSquash: false }).settings)).toBe("merge");
    expect(mergeMethodOf(gate({ allowSquash: false, allowMergeCommit: false }).settings)).toBe("rebase");
    expect(mergeMethodOf(gate({ allowSquash: false, allowMergeCommit: false, allowRebase: false }).settings)).toBeNull();
  });

  it("keeps a request-changes review open until the same reviewer approves or it is dismissed", () => {
    expect(
      openChangeRequests([
        { reviewerLogin: "dana", state: "CHANGES_REQUESTED" },
        { reviewerLogin: "dana", state: "COMMENTED" },
        { reviewerLogin: "lee", state: "CHANGES_REQUESTED" },
        { reviewerLogin: "lee", state: "APPROVED" },
        { reviewerLogin: "kim", state: "CHANGES_REQUESTED" },
        { reviewerLogin: "kim", state: "DISMISSED" },
      ]),
    ).toEqual(["dana"]);
  });

  it("holds every condition only for an L4 head that Factoree verified and every reviewer passed", () => {
    expect(unmetConditions(holding)).toEqual([]);
    expect(unmetConditions({ ...holding, level: "L3" })).toHaveLength(1);
    expect(unmetConditions({ ...holding, pullRequest: pullRequest({ headSha: "head-2" }) })[0]).toContain("did not verify");
    expect(unmetConditions({ ...holding, reviewAppHolds: [{ appSlug: "sayso", reason: "not_passed" }] })[0]).toContain("sayso did not pass");
    expect(unmetConditions({ ...holding, changeRequests: ["dana"] })[0]).toContain("dana");
  });

  it("turns off only an auto-merge it turned on, and never turns it on after a human stop", () => {
    const on = pullRequest({ autoMergeEnabled: true });
    expect(decideAutoMerge({ state: "enabled", unmet: ["x"], pullRequest: on }).kind).toBe("disable");
    expect(decideAutoMerge({ state: "off", unmet: ["x"], pullRequest: on }).kind).toBe("none");
    expect(decideAutoMerge({ state: "stopped", unmet: [], pullRequest: pullRequest() }).kind).toBe("none");
    expect(decideAutoMerge({ state: "unavailable", unmet: [], pullRequest: pullRequest() }).kind).toBe("none");
    expect(decideAutoMerge({ state: "off", unmet: [], pullRequest: pullRequest() }).kind).toBe("enable");
    // GitHub refuses auto-merge on a pull request it can merge at once.
    expect(decideAutoMerge({ state: "off", unmet: [], pullRequest: pullRequest({ mergeableState: "clean" }) }).kind).toBe("merge");
  });

  it("reaches GraphQL on github.com and on GitHub Enterprise Server", () => {
    expect(graphqlUrlOf("https://api.github.com")).toBe("https://api.github.com/graphql");
    expect(graphqlUrlOf("https://git.example.com/api/v3")).toBe("https://git.example.com/api/graphql");
  });
});
