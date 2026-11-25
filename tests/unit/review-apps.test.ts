import { describe, expect, it } from "vitest";
import {
  actionsJobIdOf,
  failedCiChecks,
  logTailOf,
  reviewAppHolds,
  reviewAppsOf,
  reviewAppVerdict,
  unansweredThreadsOf,
  type CheckOnCommit,
  type PullRequestReviewOnGitHub,
  type ReviewThreadOnGitHub,
} from "~/domain/pull-requests/review-apps.js";

const run = (name: string, appSlug: string, conclusion: string | null, completed = true): CheckOnCommit => ({
  kind: "check_run",
  id: name.length,
  name,
  appSlug,
  creatorLogin: null,
  completed,
  conclusion,
  title: null,
  summary: null,
  text: null,
  detailsUrl: null,
});

const status = (context: string, creator: string, state: string): CheckOnCommit => ({
  kind: "status",
  id: null,
  name: context,
  appSlug: null,
  creatorLogin: creator,
  completed: state !== "pending",
  conclusion: state === "pending" ? null : state,
  title: null,
  summary: null,
  text: null,
  detailsUrl: null,
});

const review = (authorLogin: string, authorType = "Bot"): PullRequestReviewOnGitHub => ({
  reviewId: authorLogin.length,
  authorLogin,
  authorType,
  state: "COMMENTED",
  commitSha: "head",
  body: "",
});

// docs/specs/pr-feedback-loop.md, DI-21.206. Which apps are review apps, and what each verdict means.
describe("review apps", () => {
  it("are the bots that reviewed, without Factoree, humans or denied apps", () => {
    const reviews = [review("sayso[bot]"), review("dana", "User"), review("factoreetemp[bot]"), review("noisy[bot]"), review("Sayso[bot]")];
    expect(reviewAppsOf(reviews, "factoreetemp", ["noisy"])).toEqual(["sayso"]);
  });

  it("act on failure and neutral, pass on success, wait while pending, and have no verdict without a check", () => {
    expect(reviewAppVerdict([run("sayso", "sayso", "neutral")], "sayso")).toBe("acts");
    expect(reviewAppVerdict([run("sayso", "sayso", "failure")], "sayso")).toBe("acts");
    expect(reviewAppVerdict([run("sayso", "sayso", "success"), run("lint", "github-actions", "failure")], "sayso")).toBe("success");
    expect(reviewAppVerdict([run("sayso", "sayso", "skipped")], "sayso")).toBe("success");
    expect(reviewAppVerdict([run("sayso", "sayso", null, false)], "sayso")).toBe("pending");
    expect(reviewAppVerdict([run("lint", "github-actions", "failure")], "copilot-pull-request-reviewer")).toBe("none");
    expect(reviewAppVerdict([status("review", "bot-x[bot]", "error")], "bot-x")).toBe("acts");
  });
});

// DI-21.207. A thread Factoree answered last is not triaged again until it takes a new comment.
describe("unanswered threads", () => {
  const thread = (authors: string[], isResolved = false): ReviewThreadOnGitHub => ({
    isResolved,
    path: "src/a.ts",
    line: 3,
    comments: authors.map((authorLogin, index) => ({ commentId: index + 1, authorLogin, body: "text", url: null })),
  });

  it("keeps the open threads the app started that Factoree did not answer last", () => {
    const open = thread(["sayso[bot]"]);
    const answered = thread(["sayso[bot]", "factoreetemp[bot]"]);
    const answeredThenReplied = thread(["sayso[bot]", "factoreetemp[bot]", "sayso[bot]"]);
    const resolved = thread(["sayso[bot]"], true);
    const human = thread(["dana"]);
    expect(unansweredThreadsOf([open, answered, answeredThenReplied, resolved, human], "sayso", "factoreetemp")).toEqual([open, answeredThenReplied]);
  });
});

// docs/specs/pr-feedback-loop.md, DI-21.212. The L4 merge waits for every review app to pass.
describe("review app holds of an L4 merge", () => {
  const open = (author: string, answeredBy: string | null = null): ReviewThreadOnGitHub => ({
    isResolved: false,
    path: "src/a.ts",
    line: 3,
    comments: [
      { commentId: 1, authorLogin: author, body: "text", url: null },
      ...(answeredBy === null ? [] : [{ commentId: 2, authorLogin: answeredBy, body: "answer", url: null }]),
    ],
  });
  const holds = (checks: CheckOnCommit[], threads: ReviewThreadOnGitHub[] = []) =>
    reviewAppHolds({ apps: ["sayso", "copilot-pull-request-reviewer"], checks, threads, factoreeSlug: "factoreetemp" });

  it("holds while an app check runs or did not pass, and not once every check passed", () => {
    expect(holds([run("sayso", "sayso", null, false)])).toEqual([{ appSlug: "sayso", reason: "pending" }]);
    expect(holds([run("sayso", "sayso", "neutral")])).toEqual([{ appSlug: "sayso", reason: "not_passed" }]);
    expect(holds([run("sayso", "sayso", "success")])).toEqual([]);
  });

  it("holds for an app with no check only while one of its open threads has no answer from Factoree", () => {
    expect(holds([run("sayso", "sayso", "success")], [open("copilot-pull-request-reviewer[bot]")])).toEqual([
      { appSlug: "copilot-pull-request-reviewer", reason: "unanswered" },
    ]);
    expect(holds([run("sayso", "sayso", "success")], [open("copilot-pull-request-reviewer[bot]", "factoreetemp[bot]")])).toEqual([]);
  });

  it("does not let an answered thread of an app with a failing check release the merge", () => {
    expect(holds([run("sayso", "sayso", "failure")], [open("sayso[bot]", "factoreetemp[bot]")])).toEqual([{ appSlug: "sayso", reason: "not_passed" }]);
  });
});

// DI-21.208. A failed CI check acts, unless it failed on the base too or a review app owns it.
describe("failed CI checks", () => {
  it("skip a check that also fails on the base, a review app's check and Factoree's own status", () => {
    const head = [
      run("test", "github-actions", "failure"),
      run("lint", "github-actions", "failure"),
      run("build", "github-actions", "timed_out"),
      run("sayso", "sayso", "failure"),
      run("e2e", "github-actions", "success"),
      status("factoree/change-set", "factoreetemp[bot]", "failure"),
      status("ci/legacy", "jenkins[bot]", "error"),
    ];
    const base = [run("lint", "github-actions", "failure"), run("test", "github-actions", "success")];
    const failed = failedCiChecks({ head, base, reviewApps: ["sayso"], factoreeSlug: "factoreetemp" }).map((check) => check.name);
    expect(failed).toEqual(["test", "build", "ci/legacy"]);
  });

  it("reads the Actions job id from the details URL and keeps the log tail without timestamps", () => {
    expect(actionsJobIdOf("https://github.com/acme/api/actions/runs/123/job/456")).toBe(456);
    expect(actionsJobIdOf("https://ci.example.com/build/9")).toBeNull();
    const log = Array.from({ length: 300 }, (_, index) => `2026-11-24T10:00:00.0000000Z line ${String(index)}`).join("\n");
    const tail = logTailOf(log).split("\n");
    expect(tail).toHaveLength(200);
    expect(tail[199]).toBe("line 299");
  });
});
