import { describe, expect, it } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
import { ApplicationFailure } from "@temporalio/common";
import {
  createPublishingActivities,
  publishBranchName,
  type PublishActivityInput,
  type PublishActivityOutput,
  type PublishingActivityDependencies,
} from "~/activities/publishing.activities.js";
import type { RepositoryReader, TreeListing } from "~/adapters/github/git-repository-reader.js";
import type {
  CreatePullRequestInput,
  PullRequestPort,
  PullRequestRecord,
} from "~/domain/publishing/pull-request.js";
import { GitHubApiError } from "~/adapters/github/github-pull-requests.js";
import {
  TrustedCheckoutError,
  type TrustedCheckoutInput,
  type TrustedPublication,
} from "~/domain/publishing/trusted-checkout.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { Command, CommandResult, Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";

const TOKEN = "ghp_supersecrettokenvalue0123456789";
const BASE = "a".repeat(40);
const COMMIT = "c".repeat(40);
/** The staged tree the sandbox double reports. The review carried the same value. */
const TREE = "b".repeat(40);
const PATCH_TEXT = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+changed\n";

/** A `Sandbox` double that answers the five commands of `capturePatch`. */
const stubSandbox = (options: { changedFiles: string[]; patchText: string }): Sandbox => {
  const exec = (_ref: SandboxRef, command: Command): Promise<CommandResult> => {
    const line = [command.file, ...command.args].join(" ");
    let stdout = "";
    if (line.includes("--name-only")) stdout = options.changedFiles.join("\n");
    else if (line.includes("write-tree")) stdout = `${"b".repeat(40)}\n`;
    else if (command.args.includes('base64 < "$0"')) stdout = Buffer.from(options.patchText).toString("base64");
    return Promise.resolve({ exitCode: 0, stdout, stderr: "", timedOut: false, durationMs: 1 });
  };
  return {
    name: "stub",
    capabilities: {
      enforcesNetworkPolicy: true,
      supportsCheckpoints: false,
      supportsExposedServices: false,
    },
    exec,
  } as unknown as Sandbox;
};

interface RecordingReader extends RepositoryReader {
  readonly urls: string[];
}

/**
 * A `RepositoryReader` double for the base backstop of the `publish` activity. It records every
 * URL it received, so a test proves the activity passed the plain URL. SDD section 30 forbids a
 * credential on the process argument list, and `git ls-remote` puts its URL there.
 */
const recordingRepositoryReader = (targetSha: string): RecordingReader => {
  const urls: string[] = [];
  return {
    urls,
    resolveRef(url: string): Promise<string> {
      urls.push(url);
      return Promise.resolve(targetSha);
    },
    listTree(): Promise<TreeListing> {
      return Promise.resolve({ entries: [], truncated: false });
    },
    readBlob(): Promise<string | null> {
      return Promise.resolve(null);
    },
  };
};

interface MemoryPullRequests extends PullRequestPort {
  readonly created: CreatePullRequestInput[];
  readonly lookups: string[];
}

const memoryPullRequests = (existing: PullRequestRecord | null = null): MemoryPullRequests => {
  const created: CreatePullRequestInput[] = [];
  const lookups: string[] = [];
  return {
    created,
    lookups,
    findByHead(_slug: string, headBranch: string): Promise<PullRequestRecord | null> {
      lookups.push(headBranch);
      return Promise.resolve(existing !== null && existing.headBranch === headBranch ? existing : null);
    },
    create(input: CreatePullRequestInput): Promise<PullRequestRecord> {
      created.push(input);
      return Promise.resolve({
        number: 42,
        url: "https://github.com/acme/app/pull/42",
        headBranch: input.headBranch,
        headSha: COMMIT,
      });
    },
  };
};

interface PublicationRow {
  patchSha256: string;
  commitSha: string;
  pullRequestUrl: string;
}

const stubRuns = (): RunRepository & { publications: PublicationRow[] } => {
  const publications: PublicationRow[] = [];
  return {
    publications,
    setPublication(_tenantId: string, _runId: string, publication: PublicationRow): Promise<void> {
      publications.push(publication);
      return Promise.resolve();
    },
  } as unknown as RunRepository & { publications: PublicationRow[] };
};

const stubPublishToBranch = (
  failure?: Error,
): ((input: TrustedCheckoutInput) => Promise<TrustedPublication>) & {
  inputs: TrustedCheckoutInput[];
} => {
  const inputs: TrustedCheckoutInput[] = [];
  const fake = (input: TrustedCheckoutInput): Promise<TrustedPublication> => {
    inputs.push(input);
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve({
      commitSha: COMMIT,
      publishedPatchSha256: input.verifiedPatchSha256,
      treeSha: "b".repeat(40),
      branch: input.branch,
    });
  };
  fake.inputs = inputs;
  return fake;
};

const input: PublishActivityInput = {
  runId: "run-1",
  tenantId: "tenant-1",
  projectId: "project-1",
  spriteId: "sprite-1",
  adapter: "stub",
  workspacePath: "/workspace",
  primaryPath: "/workspace/primary",
  repositorySlug: "acme/app",
  repositoryBaseUrl: "https://github.com",
  baseBranch: "main",
  baseSha: BASE,
  reviewedChangedFiles: ["src/a.ts"],
  reviewedWorktreeSha: TREE,
  workItemTitle: "Rename a project",
  workItemUrl: "https://linear.app/acme/issue/ENG-1",
  verificationSummary: "every check passed",
  repairCount: 0,
};

const build = (options: {
  secrets?: MemorySecretStore;
  changedFiles?: string[];
  patchText?: string;
  existing?: PullRequestRecord | null;
  /** The SHA the target branch holds now. The default equals the Run base SHA, so it is fresh. */
  currentTargetSha?: string;
  /** The failure the trusted checkout double throws. */
  checkoutFailure?: Error;
  /** The failure every pull request call throws. */
  pullRequestFailure?: Error;
} = {}) => {
  const lines: string[] = [];
  const redactor = new Redactor([]);
  const secrets = options.secrets ?? new MemorySecretStore({ GITHUB_TOKEN: TOKEN });
  const pullRequests = memoryPullRequests(options.existing ?? null);
  if (options.pullRequestFailure !== undefined) {
    const failure = options.pullRequestFailure;
    pullRequests.findByHead = (): Promise<PullRequestRecord | null> => Promise.reject(failure);
    pullRequests.create = (): Promise<PullRequestRecord> => Promise.reject(failure);
  }
  const runs = stubRuns();
  const reader = recordingRepositoryReader(options.currentTargetSha ?? BASE);
  const publishToBranch = stubPublishToBranch(options.checkoutFailure);
  const dependencies: PublishingActivityDependencies = {
    sandbox: stubSandbox({
      changedFiles: options.changedFiles ?? ["src/a.ts"],
      patchText: options.patchText ?? PATCH_TEXT,
    }),
    secrets,
    redactor,
    runs,
    repositoryReader: reader,
    pullRequests: () => pullRequests,
    gitAuthor: { name: "Factoree", email: "factoree@users.noreply.github.com" },
    logger: createLogger({ level: "debug", redactor, sink: (line) => lines.push(line) }),
    publishToBranch,
  };
  return {
    activities: createPublishingActivities(dependencies),
    pullRequests,
    runs,
    reader,
    publishToBranch,
    lines,
  };
};

const environment = new MockActivityEnvironment();

describe("the publish activity", () => {
  it("refuses a Project without the GITHUB_TOKEN secret", async () => {
    const { activities, pullRequests } = build({ secrets: new MemorySecretStore({}) });
    await expect(environment.run((value: PublishActivityInput) => activities.publish(value), input)).rejects.toBeInstanceOf(RunConfigurationError);
    expect(pullRequests.lookups).toEqual([]);
  });

  it("refuses a GITHUB_TOKEN that carries the injection mark and names the rotation", async () => {
    const secrets = new MemorySecretStore({
      GITHUB_TOKEN: { value: TOKEN, injectIntoImplementer: true },
    });
    const { activities } = build({ secrets });
    await expect(environment.run((value: PublishActivityInput) => activities.publish(value), input)).rejects.toThrow(/Rotate the credential/);
  });

  it("refuses a patch that names a file the review never saw, before any pull request call", async () => {
    const { activities, pullRequests } = build({ changedFiles: ["src/a.ts", "src/b.ts"] });
    await expect(environment.run((value: PublishActivityInput) => activities.publish(value), input)).rejects.toThrow(/PUBLICATION_FAILED|does not name/);
    expect(pullRequests.lookups).toEqual([]);
    expect(pullRequests.created).toEqual([]);
  });

  it("refuses an empty patch, before any pull request call", async () => {
    const { activities, pullRequests } = build({ changedFiles: [], patchText: "" });
    const empty: PublishActivityInput = { ...input, reviewedChangedFiles: [] };
    await expect(environment.run((value: PublishActivityInput) => activities.publish(value), empty)).rejects.toThrow(/nothing to.*publish|EMPTY/s);
    expect(pullRequests.lookups).toEqual([]);
    expect(pullRequests.created).toEqual([]);
  });

  it("refuses a patch with no changed file but nonzero bytes", async () => {
    const { activities, pullRequests } = build({ changedFiles: [], patchText: PATCH_TEXT });
    const empty: PublishActivityInput = { ...input, reviewedChangedFiles: [] };
    await expect(
      environment.run((value: PublishActivityInput) => activities.publish(value), empty),
    ).rejects.toThrow(/nothing to.*publish/s);
    expect(pullRequests.lookups).toEqual([]);
  });

  it("returns created false and creates nothing when the head branch already holds a pull request", async () => {
    const existing = {
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      headBranch: publishBranchName(input.runId),
      headSha: COMMIT,
    };
    const { activities, pullRequests, runs, publishToBranch } = build({ existing });

    const output: PublishActivityOutput = await environment.run(
      (value: PublishActivityInput) => activities.publish(value),
      input,
    );

    expect(output.created).toBe(false);
    expect(output.pullRequestNumber).toBe(7);
    expect(pullRequests.created).toEqual([]);
    expect(publishToBranch.inputs).toEqual([]);
    // The commit SHA comes from the pull request answer. The reader would throw if it were
    // called, so this success proves the credential never reaches a git command line.
    expect(output.commitSha).toBe(COMMIT);
    expect(runs.publications).toHaveLength(1);
  });

  it("records the publication with the patch hash, the commit SHA, and the pull request URL", async () => {
    const { activities, runs, pullRequests } = build();

    const output: PublishActivityOutput = await environment.run(
      (value: PublishActivityInput) => activities.publish(value),
      input,
    );

    expect(output.created).toBe(true);
    expect(pullRequests.created).toHaveLength(1);
    expect(runs.publications).toEqual([
      {
        patchSha256: output.patchSha256,
        commitSha: COMMIT,
        pullRequestUrl: "https://github.com/acme/app/pull/42",
      },
    ]);
  });

  it("never puts the credential in a returned value, in a log line, or in a thrown message", async () => {
    const { activities, lines, publishToBranch } = build();

    const output: PublishActivityOutput = await environment.run(
      (value: PublishActivityInput) => activities.publish(value),
      input,
    );

    expect(JSON.stringify(output)).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain(TOKEN);
    // The trusted checkout is the one place the credential travels, and it never returns. This
    // positive assertion pins that place, so a stub that produced no token cannot pass.
    // The clone URL is plain. SDD section 30 forbids the credential on the process argument
    // list, so the trusted checkout receives it out of band instead.
    expect(publishToBranch.inputs[0]?.cloneUrl).toBe("https://github.com/acme/app.git");
    expect(publishToBranch.inputs[0]?.cloneUrl ?? "").not.toContain(TOKEN);
    expect(publishToBranch.inputs[0]?.token).toBe(TOKEN);

    const mismatch = build({ changedFiles: ["src/a.ts", "src/b.ts"] });
    const error = await mismatch.activities
      .publish(input)
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(String(error)).not.toContain(TOKEN);
  });

  it("converts a semantic publication failure into a non-retryable failure", async () => {
    const { activities } = build({ changedFiles: [], patchText: "" });
    const error = await activities
      .publish({ ...input, reviewedChangedFiles: [], reviewedWorktreeSha: TREE })
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).type).toBe("EMPTY_PATCH");
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
  });

  it("refuses a captured tree that differs from the reviewed tree, before any pull request call", async () => {
    const { activities, pullRequests, publishToBranch } = build();
    const moved: PublishActivityInput = { ...input, reviewedWorktreeSha: "9".repeat(40) };

    await expect(
      environment.run((value: PublishActivityInput) => activities.publish(value), moved),
    ).rejects.toThrow(/changed after the independent review/);

    expect(pullRequests.lookups).toEqual([]);
    expect(pullRequests.created).toEqual([]);
    expect(publishToBranch.inputs).toEqual([]);
  });

  it("refuses an empty reviewed tree, because the review produced no fingerprint", async () => {
    const { activities, pullRequests, publishToBranch } = build();
    const none: PublishActivityInput = { ...input, reviewedWorktreeSha: "" };

    await expect(
      environment.run((value: PublishActivityInput) => activities.publish(value), none),
    ).rejects.toThrow(/changed after the independent review/);

    expect(pullRequests.lookups).toEqual([]);
    expect(pullRequests.created).toEqual([]);
    expect(publishToBranch.inputs).toEqual([]);
  });

  it("refuses a repository base URL that is not https", async () => {
    const { activities } = build();
    await expect(
      environment.run((value: PublishActivityInput) => activities.publish(value), {
        ...input,
        repositoryBaseUrl: "file:///tmp/repos",
      }),
    ).rejects.toBeInstanceOf(RunConfigurationError);
  });
  it("refuses a base that moved, before any trusted checkout and before any pull request call", async () => {
    // SDD section 45. The workflow calls `checkBase` once. A Temporal retry of `publish` runs
    // minutes later, so `publish` must check the base itself. This case is that retry path.
    const { activities, pullRequests, publishToBranch, reader } = build({
      currentTargetSha: "d".repeat(40),
    });

    await expect(
      environment.run((value: PublishActivityInput) => activities.publish(value), input),
    ).rejects.toThrow(/target branch "main" moved after this Run started/);

    expect(publishToBranch.inputs).toEqual([]);
    expect(pullRequests.lookups).toEqual([]);
    expect(pullRequests.created).toEqual([]);
    // The base check reads the plain URL only. A credential must never reach a git argument list.
    expect(reader.urls).toEqual(["https://github.com/acme/app.git"]);
  });

  it("makes a moved base non-retryable, because a retry cannot repair it", async () => {
    const { activities } = build({ currentTargetSha: "d".repeat(40) });
    const error = await activities
      .publish(input)
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).type).toBe("PUBLICATION_FAILED");
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
  });

  it("passes the clone URL without the credential and supplies the credential apart from it", async () => {
    const { activities, publishToBranch } = build();

    await environment.run((value: PublishActivityInput) => activities.publish(value), input);

    const received = publishToBranch.inputs[0];
    expect(received?.cloneUrl).toBe("https://github.com/acme/app.git");
    expect(received?.cloneUrl ?? "").not.toContain(TOKEN);
    expect(received?.cloneUrl ?? "").not.toContain("x-access-token");
    expect(received?.token).toBe(TOKEN);
  });

  it("makes a rejected credential non-retryable", async () => {
    const failure = new TrustedCheckoutError(
      "a git command of the trusted checkout failed: fatal: Authentication failed for the remote",
      { deterministic: true },
    );
    const { activities } = build({ checkoutFailure: failure });
    const error = await activities
      .publish(input)
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).type).toBe("PUBLICATION_FAILED");
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
  });

  it("keeps a network timeout of the trusted checkout retryable", async () => {
    const failure = new TrustedCheckoutError(
      "a git command of the trusted checkout failed: Command failed: git clone, timed out",
      { deterministic: false },
    );
    const { activities } = build({ checkoutFailure: failure });
    const error = await activities
      .publish(input)
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TrustedCheckoutError);
    expect(error).not.toBeInstanceOf(ApplicationFailure);
  });

  it("makes a GitHub 404 non-retryable", async () => {
    const { activities } = build({
      pullRequestFailure: new GitHubApiError("the GitHub API answered 404 for the pull request", 404),
    });
    const error = await activities
      .publish(input)
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).type).toBe("PUBLICATION_FAILED");
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
  });

  it("keeps a GitHub 500 retryable", async () => {
    const { activities } = build({
      pullRequestFailure: new GitHubApiError("the GitHub API answered 500 for the pull request", 500),
    });
    const error = await activities
      .publish(input)
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).not.toBeInstanceOf(ApplicationFailure);
  });

  it("keeps a GitHub 429 and a GitHub 408 retryable, because the server asks for a later attempt", () => {
    expect(new GitHubApiError("answered 429", 429).deterministic).toBe(false);
    expect(new GitHubApiError("answered 408", 408).deterministic).toBe(false);
    expect(new GitHubApiError("answered 401", 401).deterministic).toBe(true);
    expect(new GitHubApiError("answered 403", 403).deterministic).toBe(true);
  });
});
