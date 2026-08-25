import { describe, expect, it } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
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
import type { TrustedCheckoutInput, TrustedPublication } from "~/domain/publishing/trusted-checkout.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { Command, CommandResult, Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";

const TOKEN = "ghp_supersecrettokenvalue0123456789";
const BASE = "a".repeat(40);
const COMMIT = "c".repeat(40);
const PATCH_TEXT = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+changed\n";

/** A `Sandbox` double that answers the five commands of `capturePatch`. */
const stubSandbox = (options: { changedFiles: string[]; patchText: string }): Sandbox => {
  const exec = (_ref: SandboxRef, command: Command): Promise<CommandResult> => {
    const line = [command.file, ...command.args].join(" ");
    let stdout = "";
    if (line.includes("--name-only")) stdout = options.changedFiles.join("\n");
    else if (line.includes("write-tree")) stdout = `${"b".repeat(40)}\n`;
    else if (command.file === "base64") stdout = Buffer.from(options.patchText).toString("base64");
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

/** A `RepositoryReader` double. Only `resolveRef` is reached by this activity. */
const stubRepositoryReader = (): RepositoryReader & { urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    resolveRef(url: string): Promise<string> {
      urls.push(url);
      return Promise.resolve(COMMIT);
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
      return Promise.resolve({ number: 42, url: "https://github.com/acme/app/pull/42", headBranch: input.headBranch });
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

const stubPublishToBranch = (): ((input: TrustedCheckoutInput) => Promise<TrustedPublication>) & {
  inputs: TrustedCheckoutInput[];
} => {
  const inputs: TrustedCheckoutInput[] = [];
  const fake = (input: TrustedCheckoutInput): Promise<TrustedPublication> => {
    inputs.push(input);
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
} = {}) => {
  const lines: string[] = [];
  const redactor = new Redactor([]);
  const secrets = options.secrets ?? new MemorySecretStore({ GITHUB_TOKEN: TOKEN });
  const pullRequests = memoryPullRequests(options.existing ?? null);
  const runs = stubRuns();
  const reader = stubRepositoryReader();
  const publishToBranch = stubPublishToBranch();
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

  it("returns created false and creates nothing when the head branch already holds a pull request", async () => {
    const existing = {
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      headBranch: publishBranchName(input.runId),
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
    // The trusted checkout is the one place the credential travels, and it never returns.
    expect(publishToBranch.inputs[0]?.cloneUrl).toContain("x-access-token");

    const mismatch = build({ changedFiles: ["src/a.ts", "src/b.ts"] });
    const error = await mismatch.activities
      .publish(input)
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(String(error)).not.toContain(TOKEN);
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
});
