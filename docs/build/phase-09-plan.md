# Phase 9 — Trusted publishing implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only the exact verified patch can reach GitHub.

**Architecture:** After the independent review passes, Factoree captures the change as one patch inside the sandbox, hashes it, and proves the target branch has not moved. Factoree then builds a clean trusted checkout on the control plane, outside the sandbox and outside every agent session, applies the patch, recalculates the hash, and refuses to publish on any mismatch. Only after that assertion does Factoree create a branch, a commit, a push, and one pull request. No agent session ever holds the GitHub write credential.

**Tech Stack:** TypeScript, Node 24, Temporal, Prisma, PostgreSQL, `git` through `node:child_process` on the control plane and through the `Sandbox` port inside the sandbox, the GitHub REST API through `fetch`, Vitest.

**Spec:** `docs/sdd.md`, version 2.0, SHA-256 `fb4039f687bec41f66cc6e053c13cd526a0823c3e16c78a802ebd43c80d36c7a`. The specification is immutable and authoritative. The sections this phase implements are 29, 30, 44, 45, 46, 48, 49, 63, 64, and 68.

**Phase exit condition (SDD section 69):** only the exact verified patch can reach GitHub.

---

## Global constraints

- Every English sentence in code comments, commit messages, and documentation follows ASD-STE100. Active voice. One instruction per sentence. No contraction. No `-ing` form outside a technical name.
- `docs/sdd.md` is immutable. No task edits it.
- Node 24 lives at `/opt/homebrew/opt/node@24/bin`. Prefix `PATH` with that directory in every shell.
- The shell alias `cat` points at a broken `bat`. Use `/bin/cat`. Never write a file through a `cat` heredoc. Build a commit message in a file and use `git commit -F`.
- `timeout` and `gtimeout` are not installed.
- `npm run verify` takes longer than a two-minute foreground tool call. Run it in stages in the background and poll the output file. Never wait on a foreground suite.
- Run the whole-repository `npm run lint` and `npm run typecheck` at every task gate.
- Run the whole integration suite before a task is complete, not one file. Run the whole workflow suite as well when a task changes an activity, and run it twice.
- The acceptance tests run under `vitest.integration.config.ts`.
- Docker is required for the integration and the workflow suites.
- A new activity must be added by hand to `tests/workflow/at-35-worker-restart.test.ts`, because that file hand-builds its own activity map and `npm run typecheck` cannot catch a missing entry.
- `tests/workflow/at-16-deterministic-failure.test.ts` asserts an exact activity-name list on two failure paths. Those paths must still call no publishing activity.
- SDD section 30 forbids a GitHub write credential in any agent session. No task places `GITHUB_TOKEN` in a sandbox environment, in a prompt, or in a log line.
- Every error message that can quote a URL passes through `withoutUrlCredentials` from `src/domain/runs/checkout.ts`. Every error message that can quote repository content passes through the `Redactor`.

---

## Controller decisions for this phase

These decisions resolve every question the specification leaves open. An executing agent must not revisit them.

1. **The published patch carries `--binary`, and it is not the Reviewer diff.** SDD section 44 fixes the command pair `git add -A` then `git diff --cached --binary <base_sha>`. `docs/build/STATUS.md` said Phase 9 must hash the output of `captureSourceDiff`. That note conflicts with SDD section 44, and the SDD wins. `captureSourceDiff` redacts and truncates its text, so its output cannot be applied and must never be hashed as a patch. `src/domain/publishing/patch.ts` owns the SDD section 44 pair.
2. **The "cannot differ" guarantee comes from a changed-file agreement check, not from a shared hash.** The review activity returns the changed-file list it showed the Reviewer. The publish path compares that list with the changed-file list of the verified patch and refuses to publish on any difference. This keeps the intent of the STATUS note and obeys SDD section 44.
3. **One constant fixes every diff option, and both the sandbox capture and the control-plane recomputation use it.** Rename detection, the diff algorithm, colour, the external diff driver, the abbreviation length, and the prefix mode are pinned. Without the pin, one git configuration can change the bytes and break the assertion for the wrong reason.
4. **The patch travels as base64.** `Sandbox.exec` decodes stdout as UTF-8, so a binary hunk would be corrupted. The sandbox writes the patch to a file and Factoree reads it with `base64`. The SHA-256 is taken over the decoded bytes, never over the base64 text.
5. **The patch is never redacted.** A redacted patch does not apply, and its hash does not match. SDD section 60 governs logs, evidence, and the Proof Pack. The patch is the artifact under publication, not an evidence record. Every error message about the patch is still redacted.
6. **The trusted checkout runs on the control plane, in a fresh temporary directory, and never inside the sandbox.** SDD section 46 requires a clean trusted checkout, and SDD section 29 denies git remote write from an agent. The temporary directory is removed in a `finally` block, which satisfies SDD section 46 step 10.
7. **The GitHub write credential is the Project secret named `GITHUB_TOKEN`.** `tests/unit/implement-activity.test.ts` already fixes that name with `injectIntoImplementer: false`. The publish path refuses to start when that secret carries `injectIntoImplementer: true`, because such a Project has already leaked it into an agent session.
8. **The branch name is `factoree/run-<runId>`, and it is deterministic.** A Temporal activity retry, and a worker restart under AT-35, must not create a second branch or a second pull request. The publish path finds an existing pull request for that head branch and returns it rather than creating another.
9. **A hash mismatch, an empty patch, and a stale base each have their own failure identity.** `PATCH_HASH_MISMATCH`, `EMPTY_PATCH`, and `PUBLICATION_FAILED` join `RUN_FAILURE_REASONS`. `STALE_BASE` is a Run status of SDD section 48, so it ends the Run through a status and carries no failure reason.
10. **Phase 9 creates no success terminal state.** SDD section 68 forbids `READY_FOR_HUMAN` without a Proof Pack, and Phase 10 builds it. After a successful publication the Run keeps the existing residual wait.
11. **The Action Policy gains its first enforcement point in the review activity.** The carried finding says `assertAllowed` is never called. The reviewer role denies `writePrimaryWorktree`, and `git add -A` inside the patch capture would stage a reviewer write into the published patch. Factoree fingerprints the primary worktree before and after the Reviewer session and refuses the review when the fingerprint changed. This is a file check, not a prompt.
12. **A tree-hash comparison is recorded beside the patch-hash assertion, and it never replaces it.** SDD section 46 step 5 requires the patch-hash assertion, so that assertion is the gate. The tree hash is extra evidence for a human who must diagnose a mismatch.

---

## File structure

**Create:**

- `src/domain/publishing/patch.ts` — the SDD section 44 command pair, the pinned diff options, the base64 transport, the SHA-256, and the changed-file agreement check.
- `src/domain/publishing/stale-base.ts` — the SDD section 45 comparison.
- `src/domain/publishing/trusted-checkout.ts` — the SDD section 46 control-plane steps 1 to 8 and step 10.
- `src/domain/publishing/pull-request.ts` — the pull request port and the SDD section 64 AT-29 body builder.
- `src/adapters/github/github-pull-requests.ts` — the GitHub REST implementation of that port.
- `src/activities/publishing.activities.ts` — the `capturePatch`, `checkBase`, and `publish` activities.
- `tests/unit/publishing-patch.test.ts`
- `tests/unit/publishing-stale-base.test.ts`
- `tests/unit/publishing-pull-request.test.ts`
- `tests/unit/github-pull-requests.test.ts`
- `tests/unit/publish-activity.test.ts`
- `tests/unit/review-worktree-guard.test.ts`
- `tests/integration/trusted-checkout.test.ts`
- `tests/workflow/at-27-exact-patch.test.ts`
- `tests/workflow/at-28-stale-base.test.ts`
- `tests/acceptance/at-29-pull-request.test.ts`
- `tests/acceptance/phase-09-exit.test.ts`
- `tests/acceptance/support/github-fixture-api.ts` — a local HTTP double of the GitHub pull request API.
- `tests/acceptance/support/bare-remote.ts` — a local bare git repository that stands in for GitHub.

**Modify:**

- `src/domain/runs/run-status.ts` — three new failure reasons.
- `src/domain/runs/run-repository.ts` and `src/persistence/prisma/run-repository.prisma.ts` — `setPublication`.
- `src/domain/review/source-diff.ts` — export the worktree fingerprint helper it already needs.
- `src/activities/review.activities.ts` — the Action Policy enforcement point and `changedFiles` on the output.
- `src/activities/index.ts` — register the publishing activities.
- `src/bin/worker.ts` — wire the new dependencies.
- `src/config/env.ts` — `GITHUB_API_BASE_URL`, `FACTOREE_GIT_AUTHOR_NAME`, `FACTOREE_GIT_AUTHOR_EMAIL`.
- `src/workflows/agent-run.workflow.ts` — the SDD section 49 publication path.
- `tests/workflow/support/harness.ts` — doubles for the three new activities.
- `tests/workflow/at-35-worker-restart.test.ts` — the hand-built activity map.
- `docs/build/STATUS.md` — the final task only.

---

### Task 1: Patch capture, hash, and changed-file agreement

**Files:**
- Create: `src/domain/publishing/patch.ts`
- Create: `tests/unit/publishing-patch.test.ts`

**Interfaces:**
- Consumes: `Sandbox`, `SandboxRef` from `~/domain/runs/sandbox.js`; `Redactor` from `~/telemetry/redaction.js`.
- Produces:
  - `export const PATCH_GIT_OPTIONS: string[]`
  - `export const PATCH_DIFF_ARGS: string[]`
  - `export class PatchError extends Error`
  - `export interface VerifiedPatch { patchBase64: string; patchSha256: string; changedFiles: string[]; treeSha: string; byteLength: number }`
  - `export const capturePatch: (dependencies: { sandbox: Sandbox; redactor: Redactor }, input: { ref: SandboxRef; primaryPath: string; baseSha: string }) => Promise<VerifiedPatch>`
  - `export const sha256OfBase64: (base64: string) => string`
  - `export const assertSameChangedFiles: (reviewed: string[], published: string[]) => void`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/publishing-patch.test.ts
import { describe, expect, it } from "vitest";
import {
  assertSameChangedFiles,
  capturePatch,
  PatchError,
  PATCH_DIFF_ARGS,
  sha256OfBase64,
} from "~/domain/publishing/patch.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { Command, CommandResult, Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";

const REF: SandboxRef = { id: "sprite-1", adapter: "local", workspacePath: "/w" };
const BASE = "a".repeat(40);

const stubSandbox = (script: (command: Command) => Partial<CommandResult>): { sandbox: Sandbox; calls: Command[] } => {
  const calls: Command[] = [];
  const sandbox = {
    name: "stub",
    capabilities: { enforcesNetworkPolicy: true, supportsCheckpoints: false, supportsExposedServices: false },
    exec: (_ref: SandboxRef, command: Command): Promise<CommandResult> => {
      calls.push(command);
      return Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        durationMs: 1,
        ...script(command),
      });
    },
  } as unknown as Sandbox;
  return { sandbox, calls };
};

describe("capturePatch", () => {
  it("runs the SDD section 44 command pair with --binary and hashes the decoded bytes", async () => {
    const patch = "diff --git a/src/a.ts b/src/a.ts\n";
    const { sandbox, calls } = stubSandbox((command) => {
      if (command.args.includes("--name-only")) return { stdout: "src/a.ts\n" };
      if (command.file === "base64") return { stdout: Buffer.from(patch).toString("base64") };
      if (command.args.includes("write-tree")) return { stdout: `${"b".repeat(40)}\n` };
      return { stdout: "" };
    });

    const result = await capturePatch(
      { sandbox, redactor: new Redactor([]) },
      { ref: REF, primaryPath: "/w/primary", baseSha: BASE },
    );

    expect(Buffer.from(result.patchBase64, "base64").toString("utf8")).toBe(patch);
    expect(result.patchSha256).toBe(sha256OfBase64(Buffer.from(patch).toString("base64")));
    expect(result.changedFiles).toEqual(["src/a.ts"]);
    expect(result.treeSha).toBe("b".repeat(40));
    // SDD section 44 fixes `git add -A` first.
    expect(calls[0]?.args).toEqual(["-C", "/w/primary", "add", "-A"]);
    // The patch command carries --binary. Controller decision 1.
    const patchCall = calls.find((call) => call.args.includes("--binary"));
    expect(patchCall).toBeDefined();
    expect(PATCH_DIFF_ARGS).toContain("--binary");
    expect(PATCH_DIFF_ARGS).toContain("--no-renames");
  });

  it("refuses a base SHA that is not forty hexadecimal characters", async () => {
    const { sandbox } = stubSandbox(() => ({}));
    await expect(
      capturePatch({ sandbox, redactor: new Redactor([]) }, { ref: REF, primaryPath: "/w/primary", baseSha: "HEAD" }),
    ).rejects.toBeInstanceOf(PatchError);
  });

  it("redacts a Project secret out of a git failure message", async () => {
    const { sandbox } = stubSandbox((command) =>
      command.args.includes("add") ? { exitCode: 1, stderr: "fatal: token s3cret-value leaked" } : {},
    );
    await expect(
      capturePatch({ sandbox, redactor: new Redactor(["s3cret-value"]) }, { ref: REF, primaryPath: "/w/primary", baseSha: BASE }),
    ).rejects.toThrow(/\[redacted\]/);
  });

  it("reports an empty change with no changed file and an empty patch", async () => {
    const { sandbox } = stubSandbox((command) => (command.args.includes("write-tree") ? { stdout: `${"c".repeat(40)}\n` } : { stdout: "" }));
    const result = await capturePatch(
      { sandbox, redactor: new Redactor([]) },
      { ref: REF, primaryPath: "/w/primary", baseSha: BASE },
    );
    expect(result.changedFiles).toEqual([]);
    expect(result.byteLength).toBe(0);
  });
});

describe("assertSameChangedFiles", () => {
  it("accepts the same set in a different order", () => {
    expect(() => assertSameChangedFiles(["b.ts", "a.ts"], ["a.ts", "b.ts"])).not.toThrow();
  });

  it("refuses a file the Reviewer never saw", () => {
    expect(() => assertSameChangedFiles(["a.ts"], ["a.ts", "b.ts"])).toThrow(PatchError);
  });

  it("refuses a file the Reviewer saw and the patch dropped", () => {
    expect(() => assertSameChangedFiles(["a.ts", "b.ts"], ["a.ts"])).toThrow(PatchError);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/unit/publishing-patch.test.ts`
Expected: FAIL, because `src/domain/publishing/patch.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/publishing/patch.ts
import { createHash } from "node:crypto";
import type { Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import type { Redactor } from "~/telemetry/redaction.js";

/**
 * Every git configuration value that can change the bytes of a diff. Controller decision 3. The
 * sandbox capture and the control-plane recomputation both use this list, so a git configuration
 * on either machine cannot break the SDD section 46 hash assertion for the wrong reason.
 */
export const PATCH_GIT_OPTIONS = [
  "-c", "core.abbrev=40",
  "-c", "core.quotePath=true",
  "-c", "core.autocrlf=false",
  "-c", "diff.algorithm=myers",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.noprefix=false",
  "-c", "diff.renames=false",
  "-c", "diff.external=",
];

/** SDD section 44. The diff of the staged tree against the base SHA, in an applicable form. */
export const PATCH_DIFF_ARGS = [
  "diff",
  "--cached",
  "--binary",
  "--no-renames",
  "--no-ext-diff",
  "--no-color",
  "--unified=3",
];

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

const SHA = /^[0-9a-f]{40}$/;

export interface VerifiedPatch {
  /** The patch bytes, base64 encoded. Controller decision 4 explains the encoding. */
  patchBase64: string;
  /** The SHA-256 of the decoded patch bytes. SDD section 44 names this value `patch_sha256`. */
  patchSha256: string;
  changedFiles: string[];
  /** The git tree object of the staged worktree. Controller decision 12. */
  treeSha: string;
  byteLength: number;
}

export const sha256OfBase64 = (base64: string): string =>
  createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");

export interface PatchDependencies {
  sandbox: Sandbox;
  redactor: Redactor;
}

export interface PatchInput {
  ref: SandboxRef;
  primaryPath: string;
  baseSha: string;
}

const git = async (
  dependencies: PatchDependencies,
  input: PatchInput,
  args: string[],
): Promise<string> => {
  const result = await dependencies.sandbox.exec(input.ref, { file: "git", args });
  if (result.exitCode !== 0) {
    throw new PatchError(
      `git ${args.join(" ")} failed with exit code ${result.exitCode}: ` +
        dependencies.redactor.redactText(result.stderr.trim()),
    );
  }
  return result.stdout;
};

/**
 * SDD section 44. Captures the verified implementation artifact of one Run.
 *
 * The patch is never redacted. Controller decision 5. A redacted patch does not apply and its
 * hash does not match, so redaction here would break the SDD section 46 assertion.
 */
export const capturePatch = async (
  dependencies: PatchDependencies,
  input: PatchInput,
): Promise<VerifiedPatch> => {
  if (!SHA.test(input.baseSha)) {
    throw new PatchError(`the base SHA is not forty hexadecimal characters: "${input.baseSha}"`);
  }
  const at = ["-C", input.primaryPath];

  // SDD section 44 step 1. Staging changes no source file. It records what the worktree holds,
  // so a new file reaches the patch as well as a changed file.
  await git(dependencies, input, [...at, "add", "-A"]);

  const names = await git(dependencies, input, [
    ...at,
    ...PATCH_GIT_OPTIONS,
    ...PATCH_DIFF_ARGS,
    "--name-only",
    input.baseSha,
  ]);
  const changedFiles = names
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .sort();

  // Controller decision 12. The tree object of the staged worktree. It is recorded beside the
  // patch hash, and it never replaces the SDD section 46 assertion.
  const treeSha = (await git(dependencies, input, [...at, "write-tree"])).trim();

  // Controller decision 4. `Sandbox.exec` decodes stdout as UTF-8, so a binary hunk cannot
  // travel through stdout. The patch goes to a file, and `base64` carries it back intact.
  const patchPath = `${input.ref.workspacePath}/patch.diff`;
  const written = await dependencies.sandbox.exec(input.ref, {
    file: "sh",
    args: [
      "-c",
      `git "$@" > "$0"`,
      patchPath,
      ...at,
      ...PATCH_GIT_OPTIONS,
      ...PATCH_DIFF_ARGS,
      input.baseSha,
    ],
  });
  if (written.exitCode !== 0) {
    throw new PatchError(
      `the patch capture failed with exit code ${written.exitCode}: ` +
        dependencies.redactor.redactText(written.stderr.trim()),
    );
  }

  const encoded = await dependencies.sandbox.exec(input.ref, { file: "base64", args: [patchPath] });
  if (encoded.exitCode !== 0) {
    throw new PatchError(
      `the patch could not be read with exit code ${encoded.exitCode}: ` +
        dependencies.redactor.redactText(encoded.stderr.trim()),
    );
  }
  const patchBase64 = encoded.stdout.replace(/\s+/g, "");

  return {
    patchBase64,
    patchSha256: sha256OfBase64(patchBase64),
    changedFiles,
    treeSha,
    byteLength: Buffer.from(patchBase64, "base64").byteLength,
  };
};

/**
 * Controller decision 2. The change under review and the change under publication must name the
 * same files. This check fails closed, so an extra file or a missing file stops the publication.
 */
export const assertSameChangedFiles = (reviewed: string[], published: string[]): void => {
  const left = [...new Set(reviewed)].sort();
  const right = [...new Set(published)].sort();
  if (left.length === right.length && left.every((value, index) => value === right[index])) return;
  const added = right.filter((value) => !left.includes(value));
  const removed = left.filter((value) => !right.includes(value));
  throw new PatchError(
    "the verified patch does not name the files the independent review examined. " +
      `Files only in the patch: ${added.join(", ") || "none"}. ` +
      `Files only in the review: ${removed.join(", ") || "none"}.`,
  );
};
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/publishing-patch.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gate**

Run: `npm run lint && npm run typecheck`
Expected: exit 0 for both.

- [ ] **Step 6: Commit**

```bash
git add src/domain/publishing/patch.ts tests/unit/publishing-patch.test.ts
git commit -F .git/COMMIT_PHASE9_T1
```

The message file holds: `feat(publishing): capture and hash the verified patch (SDD section 44)`.

---

### Task 2: Stale base guard

**Files:**
- Create: `src/domain/publishing/stale-base.ts`
- Create: `tests/unit/publishing-stale-base.test.ts`

**Interfaces:**
- Consumes: `RepositoryReader` from `~/adapters/github/git-repository-reader.js`.
- Produces:
  - `export interface BaseCheck { fresh: boolean; runBaseSha: string; currentTargetSha: string }`
  - `export const checkBase: (reader: RepositoryReader, input: { url: string; branch: string; runBaseSha: string }) => Promise<BaseCheck>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/publishing-stale-base.test.ts
import { describe, expect, it } from "vitest";
import { checkBase } from "~/domain/publishing/stale-base.js";
import type { RepositoryReader } from "~/adapters/github/git-repository-reader.js";

const reader = (sha: string): RepositoryReader =>
  ({
    resolveRef: () => Promise.resolve(sha),
    listTree: () => Promise.resolve({ entries: [], truncated: false }),
    readBlob: () => Promise.resolve(null),
  }) as unknown as RepositoryReader;

describe("checkBase", () => {
  it("is fresh when the target head equals the Run base SHA (SDD section 45)", async () => {
    const sha = "a".repeat(40);
    const result = await checkBase(reader(sha), { url: "https://github.com/o/r.git", branch: "main", runBaseSha: sha });
    expect(result.fresh).toBe(true);
    expect(result.currentTargetSha).toBe(sha);
  });

  it("is stale when the target head moved", async () => {
    const result = await checkBase(reader("b".repeat(40)), {
      url: "https://github.com/o/r.git",
      branch: "main",
      runBaseSha: "a".repeat(40),
    });
    expect(result.fresh).toBe(false);
  });

  it("refuses a Run base SHA that is not forty hexadecimal characters", async () => {
    await expect(
      checkBase(reader("a".repeat(40)), { url: "https://github.com/o/r.git", branch: "main", runBaseSha: "main" }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/unit/publishing-stale-base.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/publishing/stale-base.ts
import type { RepositoryReader } from "~/adapters/github/git-repository-reader.js";
import { safeUrlForMessage } from "~/domain/runs/checkout.js";

const SHA = /^[0-9a-f]{40}$/;

export interface BaseCheck {
  /** True only when `current_target_sha == run_base_sha`. SDD section 45. */
  fresh: boolean;
  runBaseSha: string;
  currentTargetSha: string;
}

/**
 * SDD section 45. Version 1 must not rebase automatically, so a moved target branch ends the Run
 * in `STALE_BASE` and publishes nothing. The comparison happens before publication, never after.
 */
export const checkBase = async (
  reader: RepositoryReader,
  input: { url: string; branch: string; runBaseSha: string },
): Promise<BaseCheck> => {
  if (!SHA.test(input.runBaseSha)) {
    throw new Error(`the Run base SHA is not forty hexadecimal characters: "${input.runBaseSha}"`);
  }
  const currentTargetSha = await reader.resolveRef(input.url, input.branch);
  if (!SHA.test(currentTargetSha)) {
    throw new Error(
      `the branch "${input.branch}" of ${safeUrlForMessage(input.url)} resolved to no commit SHA`,
    );
  }
  return { fresh: currentTargetSha === input.runBaseSha, runBaseSha: input.runBaseSha, currentTargetSha };
};
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/publishing-stale-base.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

Run `npm run lint && npm run typecheck`, then commit `src/domain/publishing/stale-base.ts` and its test with the message `feat(publishing): guard a stale base before publication (SDD section 45)`.

---

### Task 3: The pull request port and the AT-29 body

**Files:**
- Create: `src/domain/publishing/pull-request.ts`
- Create: `tests/unit/publishing-pull-request.test.ts`

**Interfaces:**
- Produces:
  - `export interface PullRequestRecord { number: number; url: string; headBranch: string }`
  - `export interface CreatePullRequestInput { slug: string; headBranch: string; baseBranch: string; title: string; body: string }`
  - `export interface PullRequestPort { findByHead(slug: string, headBranch: string): Promise<PullRequestRecord | null>; create(input: CreatePullRequestInput): Promise<PullRequestRecord> }`
  - `export const buildPullRequestTitle: (input: { workItemTitle: string }) => string`
  - `export const buildPullRequestBody: (input: PullRequestBodyInput) => string`
  - `export interface PullRequestBodyInput { workItemTitle: string; workItemUrl: string | null; runId: string; baseSha: string; patchSha256: string; verificationSummary: string; changedFileCount: number; repairCount: number }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/publishing-pull-request.test.ts
import { describe, expect, it } from "vitest";
import { buildPullRequestBody, buildPullRequestTitle } from "~/domain/publishing/pull-request.js";

const input = {
  workItemTitle: "Add a health endpoint",
  workItemUrl: "https://linear.app/acme/issue/ACME-1",
  runId: "run-1",
  baseSha: "a".repeat(40),
  patchSha256: "b".repeat(64),
  verificationSummary: "Every verification command passed.",
  changedFileCount: 2,
  repairCount: 1,
};

describe("the pull request body (AT-29)", () => {
  it("names the Work Item, the Run identifier, the base SHA, the patch hash, and the verification summary", () => {
    const body = buildPullRequestBody(input);
    expect(body).toContain("https://linear.app/acme/issue/ACME-1");
    expect(body).toContain("run-1");
    expect(body).toContain("a".repeat(40));
    expect(body).toContain("b".repeat(64));
    expect(body).toContain("Every verification command passed.");
  });

  it("states that no Work Item URL exists rather than printing an empty link", () => {
    expect(buildPullRequestBody({ ...input, workItemUrl: null })).toContain("no Work Item URL");
  });

  it("keeps the title short and carries the Work Item title", () => {
    const title = buildPullRequestTitle({ workItemTitle: "x".repeat(300) });
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.startsWith("Factoree: ")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/unit/publishing-pull-request.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/publishing/pull-request.ts

/** One pull request of the primary repository. */
export interface PullRequestRecord {
  number: number;
  url: string;
  headBranch: string;
}

export interface CreatePullRequestInput {
  /** The `owner/repo` slug of the primary repository. */
  slug: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
}

/**
 * The write port of SDD section 46 step 9. Only the control plane holds an implementation of it.
 * SDD section 30 denies a GitHub write credential to every agent session.
 */
export interface PullRequestPort {
  /** The open pull request for that head branch, or null. Controller decision 8 needs it. */
  findByHead(slug: string, headBranch: string): Promise<PullRequestRecord | null>;
  create(input: CreatePullRequestInput): Promise<PullRequestRecord>;
}

const MAX_TITLE = 120;

export const buildPullRequestTitle = (input: { workItemTitle: string }): string => {
  const prefix = "Factoree: ";
  const room = MAX_TITLE - prefix.length;
  const title = input.workItemTitle.trim().replace(/\s+/g, " ");
  return prefix + (title.length <= room ? title : `${title.slice(0, room - 1)}…`);
};

export interface PullRequestBodyInput {
  workItemTitle: string;
  workItemUrl: string | null;
  runId: string;
  baseSha: string;
  patchSha256: string;
  verificationSummary: string;
  changedFileCount: number;
  repairCount: number;
}

/**
 * AT-29. One pull request must name the Work Item, the Run identifier, the base SHA, the patch
 * hash, and the verification summary. The body carries no raw log, because SDD section 47 forbids
 * a log dump in the human-facing record, and the same restraint applies here.
 */
export const buildPullRequestBody = (input: PullRequestBodyInput): string =>
  [
    "## Factoree change",
    "",
    `Work Item: ${input.workItemTitle}`,
    `Work Item link: ${input.workItemUrl ?? "no Work Item URL"}`,
    `Run ID: ${input.runId}`,
    `Base SHA: ${input.baseSha}`,
    `Patch SHA-256: ${input.patchSha256}`,
    `Changed files: ${input.changedFileCount}`,
    `Repair count: ${input.repairCount}`,
    "",
    "### Deterministic verification",
    "",
    input.verificationSummary,
    "",
    "Factoree applied the verified patch to a clean trusted checkout and proved the patch hash",
    "again before it created this pull request.",
  ].join("\n");
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/publishing-pull-request.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gate and commit** with the message `feat(publishing): add the pull request port and the AT-29 body`.

---

### Task 4: The GitHub pull request adapter

**Files:**
- Create: `src/adapters/github/github-pull-requests.ts`
- Create: `tests/unit/github-pull-requests.test.ts`
- Modify: `src/config/env.ts`
- Modify: `tests/unit/env.test.ts`

**Interfaces:**
- Consumes: `PullRequestPort`, `PullRequestRecord`, `CreatePullRequestInput` from `~/domain/publishing/pull-request.js`.
- Produces: `export class GitHubPullRequests implements PullRequestPort`, constructed with `{ apiBaseUrl: string; token: string; fetch?: typeof fetch }`.

- [ ] **Step 1: Add the environment values**

In `src/config/env.ts` add to the schema:

```ts
  GITHUB_API_BASE_URL: z.string().url().default("https://api.github.com"),
  FACTOREE_GIT_AUTHOR_NAME: z.string().min(1).default("Factoree"),
  FACTOREE_GIT_AUTHOR_EMAIL: z.string().email().default("factoree@users.noreply.github.com"),
```

In `tests/unit/env.test.ts` add one case that asserts the three defaults, and one case that rejects `GITHUB_API_BASE_URL: "not-a-url"`.

- [ ] **Step 2: Write the failing adapter test**

```ts
// tests/unit/github-pull-requests.test.ts
import { describe, expect, it } from "vitest";
import { GitHubPullRequests } from "~/adapters/github/github-pull-requests.js";

interface Call { url: string; init: RequestInit }

const client = (respond: (call: Call) => Response): { port: GitHubPullRequests; calls: Call[] } => {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(respond({ url: String(url), init }));
  }) as unknown as typeof fetch;
  return {
    port: new GitHubPullRequests({ apiBaseUrl: "https://api.example.test", token: "ghp_x", fetch: fetchImpl }),
    calls,
  };
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("GitHubPullRequests", () => {
  it("creates one pull request and returns its number and URL", async () => {
    const { port, calls } = client(() => json(201, { number: 7, html_url: "https://github.com/o/r/pull/7" }));
    const record = await port.create({
      slug: "o/r",
      headBranch: "factoree/run-1",
      baseBranch: "main",
      title: "Factoree: x",
      body: "body",
    });
    expect(record).toEqual({ number: 7, url: "https://github.com/o/r/pull/7", headBranch: "factoree/run-1" });
    expect(calls[0]?.url).toBe("https://api.example.test/repos/o/r/pulls");
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("finds an existing pull request for the head branch", async () => {
    const { port, calls } = client(() => json(200, [{ number: 9, html_url: "https://github.com/o/r/pull/9" }]));
    const record = await port.findByHead("o/r", "factoree/run-1");
    expect(record?.number).toBe(9);
    expect(calls[0]?.url).toContain("head=o%3Afactoree%2Frun-1");
  });

  it("returns null when no pull request exists for the head branch", async () => {
    const { port } = client(() => json(200, []));
    expect(await port.findByHead("o/r", "factoree/run-1")).toBeNull();
  });

  it("never places the token in an error message", async () => {
    const { port } = client(() => json(422, { message: "Validation failed" }));
    await expect(
      port.create({ slug: "o/r", headBranch: "h", baseBranch: "main", title: "t", body: "b" }),
    ).rejects.toThrow(/422/);
    await expect(
      port.create({ slug: "o/r", headBranch: "h", baseBranch: "main", title: "t", body: "b" }),
    ).rejects.not.toThrow(/ghp_x/);
  });

  it("refuses a slug that is not owner/repo", async () => {
    const { port } = client(() => json(200, []));
    await expect(port.findByHead("../evil", "h")).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run tests/unit/github-pull-requests.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Write the implementation**

```ts
// src/adapters/github/github-pull-requests.ts
import { assertRepositorySlug } from "~/domain/projects/repository-url.js";
import type {
  CreatePullRequestInput,
  PullRequestPort,
  PullRequestRecord,
} from "~/domain/publishing/pull-request.js";

/** One GitHub call must not hang a Run. */
export const GITHUB_API_TIMEOUT_MS = 30_000;

interface GitHubPullRequestBody {
  number?: unknown;
  html_url?: unknown;
  message?: unknown;
}

export interface GitHubPullRequestsOptions {
  apiBaseUrl: string;
  /** The GitHub write credential. SDD section 30 keeps it on the control plane only. */
  token: string;
  fetch?: typeof fetch;
}

/**
 * SDD section 46 step 9. The only implementation of `PullRequestPort`. It runs on the control
 * plane, never inside a sandbox, and no agent session reaches it.
 */
export class GitHubPullRequests implements PullRequestPort {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubPullRequestsOptions) {
    this.base = options.apiBaseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async findByHead(slug: string, headBranch: string): Promise<PullRequestRecord | null> {
    assertRepositorySlug(slug);
    const owner = slug.split("/")[0] ?? "";
    const query = new URLSearchParams({ head: `${owner}:${headBranch}`, state: "all", per_page: "1" });
    const body = await this.call(`${this.base}/repos/${slug}/pulls?${query.toString()}`, { method: "GET" });
    if (!Array.isArray(body) || body.length === 0) return null;
    return this.toRecord(body[0] as GitHubPullRequestBody, headBranch);
  }

  async create(input: CreatePullRequestInput): Promise<PullRequestRecord> {
    assertRepositorySlug(input.slug);
    const body = await this.call(`${this.base}/repos/${input.slug}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.headBranch,
        base: input.baseBranch,
      }),
    });
    return this.toRecord(body as GitHubPullRequestBody, input.headBranch);
  }

  private toRecord(body: GitHubPullRequestBody, headBranch: string): PullRequestRecord {
    const number = body.number;
    const url = body.html_url;
    if (typeof number !== "number" || typeof url !== "string") {
      throw new Error("GitHub returned a pull request without a number or without a URL");
    }
    return { number, url, headBranch };
  }

  private async call(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
    timer.unref();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "factoree",
          // The credential appears here and nowhere else. It never reaches a message below.
          authorization: `Bearer ${this.token}`,
        },
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (!response.ok) {
      let message = "";
      try {
        const parsed = JSON.parse(text) as GitHubPullRequestBody;
        message = typeof parsed.message === "string" ? parsed.message : "";
      } catch {
        message = "";
      }
      throw new Error(
        `the GitHub API answered ${response.status} for ${url}${message === "" ? "" : `: ${message}`}`,
      );
    }
    return text === "" ? null : (JSON.parse(text) as unknown);
  }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run tests/unit/github-pull-requests.test.ts tests/unit/env.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the gate and commit** with the message `feat(github): add the pull request adapter of SDD section 46`.

---

### Task 5: The trusted checkout

**Files:**
- Create: `src/domain/publishing/trusted-checkout.ts`
- Create: `tests/integration/trusted-checkout.test.ts`

**Interfaces:**
- Consumes: `PATCH_GIT_OPTIONS`, `PATCH_DIFF_ARGS`, `PatchError`, `sha256OfBase64` from `~/domain/publishing/patch.js`; `withoutUrlCredentials` from `~/domain/runs/checkout.js`.
- Produces:
  - `export class PatchHashMismatchError extends Error` with `readonly verified: string` and `readonly published: string`
  - `export interface TrustedPublication { commitSha: string; publishedPatchSha256: string; treeSha: string; branch: string }`
  - `export interface TrustedCheckoutInput { cloneUrl: string; baseSha: string; branch: string; patchBase64: string; verifiedPatchSha256: string; commitMessage: string; authorName: string; authorEmail: string }`
  - `export const publishToBranch: (input: TrustedCheckoutInput) => Promise<TrustedPublication>`

- [ ] **Step 1: Write the failing integration test**

The test builds a real bare repository on disk, so it needs no network. It proves the applied patch reproduces the verified hash, and it proves a tampered patch is refused.

```ts
// tests/integration/trusted-checkout.test.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishToBranch, PatchHashMismatchError } from "~/domain/publishing/trusted-checkout.js";
import { PATCH_DIFF_ARGS, PATCH_GIT_OPTIONS, sha256OfBase64 } from "~/domain/publishing/patch.js";

let root: string;
let bare: string;
let work: string;
let baseSha: string;
let patchBase64: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "factoree-trusted-"));
  bare = join(root, "remote.git");
  work = join(root, "work");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare]);
  execFileSync("git", ["clone", bare, work]);
  git(work, "config", "user.email", "fixture@example.test");
  git(work, "config", "user.name", "Fixture");
  writeFileSync(join(work, "README.md"), "base\n");
  git(work, "add", "-A");
  git(work, "commit", "-m", "base");
  git(work, "push", "origin", "main");
  baseSha = git(work, "rev-parse", "HEAD").trim();

  // The change under publication, captured exactly as the sandbox captures it.
  writeFileSync(join(work, "README.md"), "base\nchanged\n");
  writeFileSync(join(work, "new.txt"), "new file\n");
  git(work, "add", "-A");
  const patch = execFileSync("git", [...PATCH_GIT_OPTIONS, ...PATCH_DIFF_ARGS, baseSha], {
    cwd: work,
    encoding: "buffer",
  });
  patchBase64 = Buffer.from(patch).toString("base64");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("publishToBranch", () => {
  it("applies the patch, proves the hash again, and pushes one branch (AT-27)", async () => {
    const result = await publishToBranch({
      cloneUrl: bare,
      baseSha,
      branch: "factoree/run-1",
      patchBase64,
      verifiedPatchSha256: sha256OfBase64(patchBase64),
      commitMessage: "Factoree change\n",
      authorName: "Factoree",
      authorEmail: "factoree@example.test",
    });

    expect(result.publishedPatchSha256).toBe(sha256OfBase64(patchBase64));
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const remoteHead = execFileSync("git", ["rev-parse", "factoree/run-1"], { cwd: bare, encoding: "utf8" }).trim();
    expect(remoteHead).toBe(result.commitSha);
  });

  it("refuses to publish when the patch does not reproduce the verified hash (AT-27)", async () => {
    await expect(
      publishToBranch({
        cloneUrl: bare,
        baseSha,
        branch: "factoree/run-2",
        patchBase64,
        verifiedPatchSha256: "f".repeat(64),
        commitMessage: "Factoree change\n",
        authorName: "Factoree",
        authorEmail: "factoree@example.test",
      }),
    ).rejects.toBeInstanceOf(PatchHashMismatchError);

    // Nothing reached the remote.
    expect(() => execFileSync("git", ["rev-parse", "factoree/run-2"], { cwd: bare })).toThrow();
  });

  it("removes its temporary directory on both paths (SDD section 46 step 10)", async () => {
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("factoree-publish-"));
    await publishToBranch({
      cloneUrl: bare,
      baseSha,
      branch: "factoree/run-3",
      patchBase64,
      verifiedPatchSha256: sha256OfBase64(patchBase64),
      commitMessage: "Factoree change\n",
      authorName: "Factoree",
      authorEmail: "factoree@example.test",
    }).catch(() => undefined);
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("factoree-publish-"));
    expect(after.length).toBe(before.length);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/trusted-checkout.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/domain/publishing/trusted-checkout.ts
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { withoutUrlCredentials } from "~/domain/runs/checkout.js";
import { PATCH_DIFF_ARGS, PATCH_GIT_OPTIONS, sha256OfBase64 } from "./patch.js";

const run = promisify(execFile);

/** One publication must not hang a Run. */
export const PUBLISH_GIT_TIMEOUT_MS = 300_000;

/** The largest output one git command of the publication may produce. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const SHA = /^[0-9a-f]{40}$/;

export class PatchHashMismatchError extends Error {
  constructor(
    readonly verified: string,
    readonly published: string,
  ) {
    super(
      "the patch hash of the trusted checkout does not equal the verified patch hash. " +
        `Verified: ${verified}. Published: ${published}. Factoree published nothing.`,
    );
    this.name = "PatchHashMismatchError";
  }
}

export class TrustedCheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustedCheckoutError";
  }
}

export interface TrustedPublication {
  commitSha: string;
  publishedPatchSha256: string;
  treeSha: string;
  branch: string;
}

export interface TrustedCheckoutInput {
  /** The clone URL. It can carry a credential in its userinfo, so no message quotes it raw. */
  cloneUrl: string;
  baseSha: string;
  branch: string;
  patchBase64: string;
  verifiedPatchSha256: string;
  commitMessage: string;
  authorName: string;
  authorEmail: string;
}

/**
 * SDD section 46 steps 1 to 8 and step 10. The clean trusted checkout runs on the control plane,
 * outside the sandbox and outside every agent session. SDD section 29 denies git remote write
 * from an agent, so only this function pushes.
 *
 * Step 5 is the gate. A hash mismatch throws before any branch, any commit, and any push, so a
 * patch that is not the verified patch can never reach GitHub.
 */
export const publishToBranch = async (input: TrustedCheckoutInput): Promise<TrustedPublication> => {
  if (!SHA.test(input.baseSha)) {
    throw new TrustedCheckoutError(
      `the base SHA is not forty hexadecimal characters: "${input.baseSha}"`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.verifiedPatchSha256)) {
    throw new TrustedCheckoutError("the verified patch hash is not sixty-four hexadecimal characters");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.branch) || input.branch.includes("..")) {
    throw new TrustedCheckoutError(`the branch name "${input.branch}" is not usable`);
  }

  const directory = await mkdtemp(join(tmpdir(), "factoree-publish-"));
  const checkout = join(directory, "checkout");
  const patchFile = join(directory, "verified.patch");

  const git = async (cwd: string, args: string[]): Promise<string> => {
    try {
      const result = await run("git", args, {
        cwd,
        timeout: PUBLISH_GIT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return result.stdout;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TrustedCheckoutError(
        `a git command of the trusted checkout failed: ${withoutUrlCredentials(detail)}`,
      );
    }
  };

  try {
    await writeFile(patchFile, Buffer.from(input.patchBase64, "base64"));

    // Step 1 and step 2. A clean trusted checkout at the original base SHA.
    await git(directory, ["clone", "--no-hardlinks", input.cloneUrl, checkout]);
    await git(checkout, ["checkout", "--detach", input.baseSha]);

    // Step 3. Apply the verified patch. `--index` stages exactly what the patch carries, so the
    // recomputation below reads the same staged tree the sandbox produced.
    await git(checkout, ["apply", "--binary", "--index", "--whitespace=nowarn", patchFile]);

    // Step 4. Recalculate the patch hash from the applied tree. Controller decision 3 pins every
    // option, so a git configuration cannot change the bytes.
    const recomputed = await run("git", [...PATCH_GIT_OPTIONS, ...PATCH_DIFF_ARGS, input.baseSha], {
      cwd: checkout,
      timeout: PUBLISH_GIT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "buffer",
    });
    const publishedPatchSha256 = sha256OfBase64(Buffer.from(recomputed.stdout).toString("base64"));

    // Step 5. The gate. Nothing below runs when the two hashes differ.
    if (publishedPatchSha256 !== input.verifiedPatchSha256) {
      throw new PatchHashMismatchError(input.verifiedPatchSha256, publishedPatchSha256);
    }

    const treeSha = (await git(checkout, ["write-tree"])).trim();

    // Step 6, step 7, and step 8.
    await git(checkout, ["checkout", "-b", input.branch]);
    const messageFile = join(directory, "commit-message.txt");
    await writeFile(messageFile, input.commitMessage, "utf8");
    await git(checkout, [
      "-c", `user.name=${input.authorName}`,
      "-c", `user.email=${input.authorEmail}`,
      "commit",
      "--no-verify",
      "--no-gpg-sign",
      "-F", messageFile,
    ]);
    const commitSha = (await git(checkout, ["rev-parse", "HEAD"])).trim();
    if (!SHA.test(commitSha)) {
      throw new TrustedCheckoutError("the trusted commit produced no commit SHA");
    }
    await git(checkout, ["push", "origin", `${input.branch}:refs/heads/${input.branch}`]);

    return { commitSha, publishedPatchSha256, treeSha, branch: input.branch };
  } finally {
    // Step 10. The temporary files hold a clone and a credentialed remote, so they go on every
    // path, including the failure paths above.
    await rm(directory, { recursive: true, force: true });
  }
};
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/trusted-checkout.test.ts`
Expected: PASS, three cases.

- [ ] **Step 5: Run the gate**

Run `npm run lint && npm run typecheck`, then the whole integration suite in the background and read the output file.

- [ ] **Step 6: Commit** with the message `feat(publishing): apply the verified patch in a clean trusted checkout (SDD section 46)`.

---

### Task 6: Enforce the Action Policy on the primary worktree during review

This task closes the carried finding that says the Action Policy is never enforced. `git add -A` in the patch capture would stage a Reviewer write, so a Reviewer write would reach the published patch.

**Files:**
- Modify: `src/domain/review/source-diff.ts`
- Modify: `src/activities/review.activities.ts`
- Create: `tests/unit/review-worktree-guard.test.ts`
- Modify: `tests/unit/review-activity.test.ts` if it exists, otherwise leave it

**Interfaces:**
- Produces in `src/domain/review/source-diff.ts`:
  - `export const worktreeFingerprint: (dependencies: SourceDiffDependencies, input: { ref: SandboxRef; primaryPath: string }) => Promise<string>`
- Produces on `ReviewActivityOutput`: `changedFiles: string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/review-worktree-guard.test.ts
import { describe, expect, it } from "vitest";
import { worktreeFingerprint } from "~/domain/review/source-diff.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { Command, CommandResult, Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";

const REF: SandboxRef = { id: "s", adapter: "local", workspacePath: "/w" };

const sandboxOf = (trees: string[]): Sandbox => {
  let index = 0;
  return {
    name: "stub",
    capabilities: { enforcesNetworkPolicy: true, supportsCheckpoints: false, supportsExposedServices: false },
    exec: (_ref: SandboxRef, command: Command): Promise<CommandResult> =>
      Promise.resolve({
        exitCode: 0,
        stdout: command.args.includes("write-tree") ? `${trees[index++] ?? ""}\n` : "",
        stderr: "",
        timedOut: false,
        durationMs: 1,
      }),
  } as unknown as Sandbox;
};

describe("worktreeFingerprint", () => {
  it("returns the staged tree object of the primary worktree", async () => {
    const sandbox = sandboxOf(["a".repeat(40)]);
    const value = await worktreeFingerprint(
      { sandbox, redactor: new Redactor([]) },
      { ref: REF, primaryPath: "/w/primary" },
    );
    expect(value).toBe("a".repeat(40));
  });

  it("changes when the worktree content changes", async () => {
    const sandbox = sandboxOf(["a".repeat(40), "b".repeat(40)]);
    const first = await worktreeFingerprint({ sandbox, redactor: new Redactor([]) }, { ref: REF, primaryPath: "/w/primary" });
    const second = await worktreeFingerprint({ sandbox, redactor: new Redactor([]) }, { ref: REF, primaryPath: "/w/primary" });
    expect(first).not.toBe(second);
  });
});
```

Add one case to the review activity unit test file that proves the policy point. Find the existing review activity unit test with `ls tests/unit | grep -i review`. If none exists, create `tests/unit/review-activity-policy.test.ts` with a scripted runner double whose `run` writes into the primary worktree, and assert the activity returns `reportUsable: false` with a problem text that names the Action Policy.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/unit/review-worktree-guard.test.ts`
Expected: FAIL, `worktreeFingerprint` is not exported.

- [ ] **Step 3: Add the fingerprint helper**

Append to `src/domain/review/source-diff.ts`:

```ts
/**
 * The git tree object of the primary worktree, staged. Two equal fingerprints prove the tracked
 * content did not change between two moments.
 *
 * SDD section 29 denies `writePrimaryWorktree` to every role except the Implementer. The review
 * activity takes this value before and after the Reviewer session, so a Reviewer write is a fact
 * on disk that Factoree can see, and not a promise in a prompt.
 */
export const worktreeFingerprint = async (
  dependencies: SourceDiffDependencies,
  input: { ref: SandboxRef; primaryPath: string },
): Promise<string> => {
  const at = { ...input, baseSha: "0".repeat(40) };
  await git(dependencies, at, ["add", "-A"]);
  return (await git(dependencies, at, ["write-tree"])).trim();
};
```

Note for the implementer: the local `git` helper takes `SourceDiffInput`, which requires `baseSha`. The value is unused by these two commands. If that reads poorly, widen the helper signature to take `{ ref, primaryPath }` instead and update `captureSourceDiff` accordingly. Prefer the widened signature.

- [ ] **Step 4: Enforce it in the review activity**

In `src/activities/review.activities.ts`:

1. Import `worktreeFingerprint` and `buildActionPolicy` is already imported.
2. Take `const beforeFingerprint = await worktreeFingerprint(...)` immediately after step 5, the diff capture.
3. After the runner session returns, and before the report is read, take `const afterFingerprint = await worktreeFingerprint(...)`.
4. When the two differ, return the unusable-report shape with:

```ts
        reportProblem:
          "The Reviewer session changed the primary worktree. The Action Policy of SDD section 29 " +
          "denies that action to the reviewer role, so Factoree refused this review and published " +
          "nothing.",
```

5. Add `changedFiles: diff.changedFiles` to every returned object of the activity, and add `changedFiles: string[]` to `ReviewActivityOutput`. The unusable paths that return before the diff exists return `[]`.

Place the fingerprint check before the report read, so a Reviewer write can never decide the Run.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run tests/unit`
Expected: PASS. Fix any test that constructs a `ReviewActivityOutput` literal and now misses `changedFiles`.

- [ ] **Step 6: Update the workflow harness double**

In `tests/workflow/support/harness.ts` add `changedFiles` to every `ReviewActivityOutput` the review double returns. Use the changed-file list the scripted report carries where one exists, and `["src/app.ts"]` otherwise.

- [ ] **Step 7: Run the gate**

Run `npm run lint && npm run typecheck`, then the whole workflow suite twice in the background.

- [ ] **Step 8: Commit** with the message `feat(review): enforce the Action Policy on the primary worktree`.

---

### Task 7: The publication record on the Run

**Files:**
- Modify: `src/domain/runs/run-status.ts`
- Modify: `src/domain/runs/run-repository.ts`
- Modify: `src/persistence/prisma/run-repository.prisma.ts`
- Modify: `tests/integration/run-repository.test.ts`
- Modify: `tests/unit/run-status.test.ts`

**Interfaces:**
- Produces on `RunRepository`:

```ts
  /**
   * SDD section 44 and section 46. Records the immutable publication facts of one Run. The method
   * throws when it reaches no Run of that tenant, because a silent success hides a caller defect.
   */
  setPublication(
    tenantId: string,
    runId: string,
    publication: { patchSha256: string; commitSha: string; pullRequestUrl: string },
  ): Promise<void>;
```

- Produces in `RUN_FAILURE_REASONS`: `"PATCH_HASH_MISMATCH"`, `"EMPTY_PATCH"`, `"PUBLICATION_FAILED"`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/run-status.test.ts` add:

```ts
  it("names the three publication failure reasons of Phase 9", () => {
    expect(RUN_FAILURE_REASONS).toContain("PATCH_HASH_MISMATCH");
    expect(RUN_FAILURE_REASONS).toContain("EMPTY_PATCH");
    expect(RUN_FAILURE_REASONS).toContain("PUBLICATION_FAILED");
  });

  it("keeps STALE_BASE a terminal status and not a failure reason", () => {
    expect(isTerminalRunStatus("STALE_BASE")).toBe(true);
    expect(RUN_FAILURE_REASONS).not.toContain("STALE_BASE");
  });
```

In `tests/integration/run-repository.test.ts` add a case that creates a Run, calls `setPublication`, reads the row back, and asserts the three columns hold the written values. Add a second case that asserts `setPublication` rejects for an unknown Run of that tenant.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/unit/run-status.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Add the three reasons to `RUN_FAILURE_REASONS` with a comment each:

```ts
  // SDD section 46 step 5. The patch of the trusted checkout did not reproduce the verified
  // hash, so publication is blocked. A repair cannot help.
  "PATCH_HASH_MISMATCH",
  // SDD section 44. Every check passed and the worktree holds no change against the base SHA,
  // so there is no verified artifact to publish.
  "EMPTY_PATCH",
  // SDD section 46. The trusted checkout, the push, or the pull request creation failed.
  "PUBLICATION_FAILED",
```

Add `setPublication` to the interface and implement it in `src/persistence/prisma/run-repository.prisma.ts` with an `updateMany` scoped by `{ id, tenantId }`, then throw when `count === 0`. Follow the exact shape of `setValidationContractVersion` in the same file.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run tests/unit/run-status.test.ts` and the whole integration suite in the background.

- [ ] **Step 5: Run the gate and commit** with the message `feat(runs): record the publication facts of a Run`.

---

### Task 8: The publishing activities

**Files:**
- Create: `src/activities/publishing.activities.ts`
- Create: `tests/unit/publish-activity.test.ts`
- Modify: `src/activities/index.ts`
- Modify: `src/bin/worker.ts`

**Interfaces:**
- Produces three activities:

```ts
export interface CapturePatchActivityInput {
  runId: string; tenantId: string; projectId: string;
  spriteId: string; adapter: string; workspacePath: string; primaryPath: string;
  baseSha: string;
  /** The changed-file list the independent review examined. Controller decision 2. */
  reviewedChangedFiles: string[];
}
export interface CapturePatchActivityOutput {
  patchSha256: string; changedFiles: string[]; byteLength: number; treeSha: string;
}

export interface CheckBaseActivityInput {
  runId: string; tenantId: string; projectId: string;
  repositorySlug: string; repositoryBaseUrl: string; branch: string; baseSha: string;
}
export interface CheckBaseActivityOutput { fresh: boolean; currentTargetSha: string }

export interface PublishActivityInput {
  runId: string; tenantId: string; projectId: string;
  spriteId: string; adapter: string; workspacePath: string; primaryPath: string;
  repositorySlug: string; repositoryBaseUrl: string; baseBranch: string; baseSha: string;
  reviewedChangedFiles: string[];
  workItemTitle: string; workItemUrl: string | null;
  verificationSummary: string; repairCount: number;
}
export interface PublishActivityOutput {
  patchSha256: string; commitSha: string; pullRequestUrl: string; pullRequestNumber: number;
  branch: string; created: boolean;
}
```

- Produces `export const createPublishingActivities: (dependencies: PublishingActivityDependencies) => { capturePatch; checkBase; publish }` where `PublishingActivityDependencies` is `{ sandbox: Sandbox; secrets: SecretStore; redactor: Redactor; runs: RunRepository; repositoryReader: RepositoryReader; pullRequests: (token: string) => PullRequestPort; gitAuthor: { name: string; email: string }; logger: Logger }`.

**Design notes the implementer must follow:**

- `publish` reads the Project secret `GITHUB_TOKEN`. When the secret is absent, throw `RunConfigurationError`, because an operator must add it. When the descriptor for it carries `injectIntoImplementer: true`, throw `RunConfigurationError` as well, with a message that says the credential already reached an agent session and must be rotated. Controller decision 7.
- `publish` builds the authenticated clone URL as `https://x-access-token:<token>@<host>/<slug>.git` from `repositoryBaseUrl`. Build it with `new URL`, set `username` and `password`, and never log the result. Pass the plain URL, without the credential, to every message.
- `publish` registers every Project secret with the redactor first, then registers the GitHub token with the redactor as well, so no later message can echo it.
- `publish` captures the patch itself rather than trusting the earlier `capturePatch` output, and it runs `assertSameChangedFiles(input.reviewedChangedFiles, patch.changedFiles)` before any network call. A Temporal retry of `publish` therefore recaptures and rehashes, which keeps the activity self-contained.
- `publish` refuses an empty patch by throwing an error whose `name` is `"EmptyPatchError"`, declared in `src/domain/publishing/patch.ts`. The workflow maps it to `EMPTY_PATCH`.
- `publish` finds an existing pull request for the head branch before it touches the trusted checkout. When one exists, it records the publication again and returns `created: false`. Controller decision 8 and AT-35.
- `publish` calls `dependencies.runs.setPublication` after the pull request exists, and it returns the values it wrote.
- `PatchHashMismatchError` propagates unchanged, so the workflow can map it to `PATCH_HASH_MISMATCH`. Wrap it in nothing.
- Every activity records a metric. Add `publishDuration` to `src/telemetry/metrics.ts` following the shape of `reviewDuration`.

- [ ] **Step 1: Write the failing unit test**

`tests/unit/publish-activity.test.ts` uses a stub `Sandbox` that answers the four patch commands, a stub `SecretStore`, a stub `RepositoryReader`, an in-memory `PullRequestPort`, and a stub `RunRepository`. It asserts:

1. `publish` throws `RunConfigurationError` when `GITHUB_TOKEN` is absent.
2. `publish` throws `RunConfigurationError` when `GITHUB_TOKEN` carries `injectIntoImplementer: true`, and the message names rotation.
3. `publish` throws `PatchError` when the patch names a file the review never saw, and it makes no call on the pull request port.
4. `publish` throws `EmptyPatchError` for an empty patch, and it makes no call on the pull request port.
5. `publish` returns `created: false` and makes no `create` call when the port already holds a pull request for `factoree/run-<runId>`.
6. `publish` calls `runs.setPublication` with the patch hash, the commit SHA, and the pull request URL.
7. No returned value and no thrown message holds the token string.

For case 5 and 6 the test injects a `publishToBranch` double. Declare the function on the dependencies as an optional `publishToBranch?: typeof publishToBranch` and default it to the real one, so the unit test needs no network and the integration test still proves the real path.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run tests/unit/publish-activity.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation and register it**

Write `src/activities/publishing.activities.ts` as described. Then:

- In `src/activities/index.ts` add `pullRequests`, `gitAuthor`, and the existing `repositoryReader`, `runs`, `sandbox`, `secrets`, `redactor`, `logger` to a `...createPublishingActivities({ ... })` spread.
- In `src/bin/worker.ts` pass `pullRequests: (token) => new GitHubPullRequests({ apiBaseUrl: env.GITHUB_API_BASE_URL, token })` and `gitAuthor: { name: env.FACTOREE_GIT_AUTHOR_NAME, email: env.FACTOREE_GIT_AUTHOR_EMAIL }`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run tests/unit`
Expected: PASS.

- [ ] **Step 5: Run the gate and commit** with the message `feat(publishing): add the capture, base check, and publish activities`.

---

### Task 9: The workflow publication path

**Files:**
- Modify: `src/workflows/agent-run.workflow.ts`
- Modify: `tests/workflow/support/harness.ts`
- Modify: `tests/workflow/at-35-worker-restart.test.ts`
- Create: `tests/workflow/at-27-exact-patch.test.ts`
- Create: `tests/workflow/at-28-stale-base.test.ts`

**Interfaces:**
- Consumes the three activities of Task 8.
- Produces no new exported symbol.

**The path, in order, exactly as SDD section 49 fixes it:**

```
review passes
  ↓
status = PUBLISHING
  ↓
checkBase
  ├─ not fresh → status STALE_BASE, terminal, no failure reason, no PR
  ↓
publish
  ├─ PatchHashMismatchError   → FAILED, PATCH_HASH_MISMATCH
  ├─ EmptyPatchError          → FAILED, EMPTY_PATCH
  ├─ PatchError               → FAILED, PUBLICATION_FAILED
  ├─ RunConfigurationError    → FAILED_CONFIGURATION, CONFIGURATION_INVALID
  ├─ any other error          → FAILED, PUBLICATION_FAILED
  ↓
post the pull request URL to Linear
  ↓
the existing residual wait, because SDD section 68 forbids READY_FOR_HUMAN without a Proof Pack
```

- [ ] **Step 1: Write the failing workflow tests**

`tests/workflow/at-27-exact-patch.test.ts` proves two things through the harness:

1. A Run whose `publish` double throws `PatchHashMismatchError` ends `FAILED` with `PATCH_HASH_MISMATCH`, and the harness recorded no pull request creation.
2. A Run whose `publish` double succeeds records the pull request URL in a `postProgress` call, and the recorded activity order ends `... review, checkBase, publish`.

`tests/workflow/at-28-stale-base.test.ts` proves that a Run whose `checkBase` double returns `fresh: false` ends with status `STALE_BASE`, carries no failure reason, and never calls `publish`.

Both tests must add the new doubles to the harness first. In `tests/workflow/support/harness.ts` add:

```ts
    checkBase: async (activityInput: CheckBaseActivityInput): Promise<CheckBaseActivityOutput> => {
      activityOrder.push("checkBase");
      const override = baseChecks.get(activityInput.runId);
      return override === undefined
        ? { fresh: true, currentTargetSha: activityInput.baseSha }
        : override();
    },
    publish: async (activityInput: PublishActivityInput): Promise<PublishActivityOutput> => {
      activityOrder.push("publish");
      publishCalls.push(activityInput);
      const override = publishOutcomes.get(activityInput.runId);
      if (override !== undefined) return override();
      return {
        patchSha256: "d".repeat(64),
        commitSha: "e".repeat(40),
        pullRequestUrl: "https://github.com/acme/fixture/pull/1",
        pullRequestNumber: 1,
        branch: `factoree/${activityInput.runId}`,
        created: true,
      };
    },
```

Expose `baseChecks`, `publishOutcomes`, and `publishCalls` on the harness handle, in the same way `reviewReports` and `reviewCalls` are exposed. Add a `capturePatch` double too, only if the workflow calls it; the plan calls `publish` alone, which captures the patch itself, so `capturePatch` stays an activity the workflow does not call. Register it in the harness anyway so the activity map stays complete.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run --config vitest.workflow.config.ts tests/workflow/at-27-exact-patch.test.ts tests/workflow/at-28-stale-base.test.ts`
Expected: FAIL, because the workflow never calls `checkBase` or `publish`.

- [ ] **Step 3: Write the workflow change**

Add a proxy with a longer timeout, beside `reviewActivities`:

```ts
/**
 * SDD section 46. The publication clones the repository, applies the patch, pushes, and calls
 * GitHub. A slow network must not fail it, and every step of it is idempotent, so a retry is
 * safe. Controller decision 8 keeps the branch name and the pull request lookup deterministic.
 */
const publishingActivities = proxyActivities<Activities>({
  startToCloseTimeout: "15 minutes",
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 3, initialInterval: "2 seconds", backoffCoefficient: 2 },
});
```

Extend the `failRun` reason union with the three new reasons. `PATCH_HASH_MISMATCH`, `EMPTY_PATCH`, and `PUBLICATION_FAILED` all end in `FAILED`, so the existing status mapping needs no change.

Add a terminal helper for the stale base, beside `failRun`:

```ts
  /**
   * SDD section 45 and section 48. A moved target branch is not a failure of the change, so it
   * carries no failure reason. Version 1 must not rebase automatically, so the Run ends here and
   * publishes nothing.
   */
  const endStale = async (currentTargetSha: string): Promise<AgentRunWorkflowResult> => {
    status = "STALE_BASE";
    await activities.completeRun({
      tenantId: input.tenantId,
      runId: id,
      status,
      completedAt: new Date(Date.now()).toISOString(),
    });
    await notify(() =>
      activities.postError({
        sessionId: input.agentSessionId,
        message:
          "The target branch moved while Factoree worked, so the verified change no longer " +
          `applies to it. The Run started at ${preparedSandbox.checkout.primary.baseSha} and the ` +
          `branch now points at ${currentTargetSha}. Factoree published nothing, and it did not ` +
          "rebase. Delegate the Work Item again to rerun it against the new base.",
      }),
    );
    return { runId: id, status };
  };
```

Replace the comment block above the residual wait with the publication path. The exact insertion point is the line `// User validation passed, and the independent review passed as well.` after the loop. Write:

```ts
    // SDD section 49. The independent review passed, so Factoree captures the verified patch,
    // proves the target branch has not moved, and publishes. SDD section 46 keeps every step of
    // the publication on the control plane, because SDD section 29 denies git remote write from
    // an agent.
    if (remainingMs() === 0) return await failRun("RUN_TIMEOUT", timeoutMessage);
    if (stopRequested) return await cancelRun();

    status = "PUBLISHING";
    await activities.setRunStatus({ runId: id, status });

    const publishInput = {
      runId: id,
      tenantId: input.tenantId,
      projectId: input.projectId,
      spriteId: preparedSandbox.sprite.spriteId,
      adapter: preparedSandbox.sprite.adapter,
      workspacePath: preparedSandbox.sprite.workspacePath,
      primaryPath: preparedSandbox.checkout.primary.path,
      repositorySlug: resolvedContext.primary.slug,
      repositoryBaseUrl: input.project.repositoryBaseUrl,
      baseBranch: input.project.defaultBranch,
      baseSha: preparedSandbox.checkout.primary.baseSha,
      reviewedChangedFiles: review.changedFiles,
      workItemTitle: input.workItem.title,
      workItemUrl: input.workItem.url,
      verificationSummary: verification.summary,
      repairCount,
    };

    // SDD section 45. The stale-base check runs before any write, so a moved branch reaches no
    // remote.
    const baseCheck = await publishingActivities.checkBase({
      runId: id,
      tenantId: input.tenantId,
      projectId: input.projectId,
      repositorySlug: publishInput.repositorySlug,
      repositoryBaseUrl: publishInput.repositoryBaseUrl,
      branch: publishInput.baseBranch,
      baseSha: publishInput.baseSha,
    });
    if (!baseCheck.fresh) return await endStale(baseCheck.currentTargetSha);

    if (stopRequested) return await cancelRun();

    let publication: PublishActivityOutput;
    try {
      publication = await publishingActivities.publish(publishInput);
    } catch (error) {
      if (isCancellation(error)) throw error;
      if (isConfigurationFault(error)) {
        return await failRun(
          "CONFIGURATION_INVALID",
          "Factoree could not publish, because the Run configuration is invalid. Add a " +
            "`GITHUB_TOKEN` Project secret that carries write access and that no agent session " +
            "receives.",
        );
      }
      const reason = publicationFailureReasonOf(error);
      return await failRun(
        reason,
        reason === "PATCH_HASH_MISMATCH"
          ? "The patch of the trusted checkout did not equal the verified patch, so Factoree " +
              "published nothing. SDD section 46 blocks publication on a hash mismatch."
          : reason === "EMPTY_PATCH"
            ? "Every check passed and the change holds no file, so Factoree had nothing to " +
                "publish."
            : "Factoree could not publish the verified change. Factoree created no pull request " +
                "for it.",
      );
    }

    await notify(() =>
      activities.postProgress({
        sessionId: input.agentSessionId,
        message:
          `Factoree published the verified change. Pull request: ${publication.pullRequestUrl}. ` +
          `Base SHA: ${publishInput.baseSha}. Patch SHA-256: ${publication.patchSha256}.`,
      }),
    );

    // SDD section 68 forbids `READY_FOR_HUMAN` without a Proof Pack, and Phase 10 builds it. The
    // Run therefore keeps the residual wait rather than invent a success terminal state.
```

Add the small classifier beside `isConfigurationFault`:

```ts
/**
 * Maps a publication failure to its SDD failure reason. The error crosses the activity boundary,
 * so the workflow sees the Temporal `ApplicationFailure` shape and must read the type name.
 */
const publicationFailureReasonOf = (
  error: unknown,
): "PATCH_HASH_MISMATCH" | "EMPTY_PATCH" | "PUBLICATION_FAILED" => {
  const name = errorTypeOf(error);
  if (name === "PatchHashMismatchError") return "PATCH_HASH_MISMATCH";
  if (name === "EmptyPatchError") return "EMPTY_PATCH";
  return "PUBLICATION_FAILED";
};
```

Read the existing `isConfigurationFault` helper in the same file and follow exactly how it reads the error type across the activity boundary. Write `errorTypeOf` in the same style, or reuse whatever that helper already uses.

- [ ] **Step 4: Update the hand-built activity map**

In `tests/workflow/at-35-worker-restart.test.ts` add `checkBase`, `capturePatch`, and `publish` entries to the object literal. Add one assertion that a worker restart during the publication does not create a second pull request: the `publish` double counts its calls per Run, returns the same pull request record every time, and the test asserts exactly one `created: true` result reached the workflow.

- [ ] **Step 5: Update the AT-16 assertion**

`tests/workflow/at-16-deterministic-failure.test.ts` asserts an exact activity-name list on two failure paths. Neither path reaches publication, so both lists stay unchanged and both `isPublishingName` assertions must still pass. Run the file and confirm.

- [ ] **Step 6: Run the tests and confirm they pass**

Run the whole workflow suite twice in the background, then read the output file.
Expected: every file passes, including `at-16`, `at-20`, `at-22`, `at-23`, `at-24`, and `at-35`.

- [ ] **Step 7: Run the gate and commit** with the message `feat(workflow): publish the verified patch after the review passes`.

---

### Task 10: AT-29 and the phase exit test

**Files:**
- Create: `tests/acceptance/support/bare-remote.ts`
- Create: `tests/acceptance/support/github-fixture-api.ts`
- Create: `tests/acceptance/at-29-pull-request.test.ts`
- Create: `tests/acceptance/phase-09-exit.test.ts`

**Interfaces:**
- `bare-remote.ts` produces `export const createBareRemote: (options: { files: Record<string, string> }) => Promise<{ cloneUrl: string; baseSha: string; destroy: () => Promise<void>; refSha: (ref: string) => string; advanceHead: (content: string) => string }>`.
- `github-fixture-api.ts` produces `export const startGitHubFixtureApi: () => Promise<{ baseUrl: string; created: CreatePullRequestInput[]; stop: () => Promise<void> }>`, an HTTP server that answers `GET /repos/:owner/:repo/pulls` with the list it holds and `POST /repos/:owner/:repo/pulls` by appending one record and answering 201. Follow the shape of `tests/acceptance/support/mcp-fixture-server.ts`.

- [ ] **Step 1: Write the failing AT-29 test**

`tests/acceptance/at-29-pull-request.test.ts` drives the real publishing activity against a real bare repository and the fixture API. It asserts:

1. Exactly one pull request exists after `publish`, and `created.length === 1`.
2. Its body names the Work Item, the Run identifier, the base SHA, the patch hash, and the verification summary.
3. Its head branch is `factoree/<runId>` and its base branch is the Project default branch.
4. A second call of `publish` with the same input creates no second pull request, and it returns `created: false`. That is the AT-35 guarantee at the activity level.
5. The published commit of the bare repository holds exactly the file content the sandbox worktree held.

- [ ] **Step 2: Write the failing phase exit test**

`tests/acceptance/phase-09-exit.test.ts` proves the phase exit condition, "only the exact verified patch can reach GitHub", four ways. Every case drives the real `capturePatch` against a real local sandbox worktree and the real `publishToBranch` against a real bare repository.

1. **The honest path.** The verified hash equals the recomputed hash, the branch reaches the remote, and the commit tree equals the sandbox tree.
2. **A tampered patch.** The test flips one byte of the patch body after the hash is taken. `publishToBranch` throws `PatchHashMismatchError`, the remote holds no new branch, and no temporary directory survives.
3. **A tampered verified hash.** The test passes a hash that no patch produces. The result is the same refusal, so the assertion is sensitive to both sides of the comparison, and neither case alone proves the rule.
4. **A stale base.** The test advances the bare repository head after the base SHA is captured. `checkBase` reports `fresh: false`, and the test asserts the remote gained no `factoree/` branch.

Add a fifth case that proves the changed-file agreement: a patch that touches a file the review never saw is refused by `assertSameChangedFiles` before any remote call.

- [ ] **Step 3: Run the tests and confirm they fail, then pass**

Run: `npx vitest run --config vitest.integration.config.ts tests/acceptance/at-29-pull-request.test.ts tests/acceptance/phase-09-exit.test.ts`
Expected: FAIL first, then PASS after the support files exist.

- [ ] **Step 4: Run the full verification**

Run `npm run verify` in stages in the background. Write the whole output to `docs/build/evidence/phase-09-verify.txt`. The last line must read `exit=0`.

- [ ] **Step 5: Commit** with the message `test(publishing): prove the Phase 9 exit condition`.

---

## Self-review of this plan against the SDD

**Section 44, patch integrity.** Task 1 runs the exact command pair and calculates `patch_sha256`. Controller decision 1 records why `--binary` is present here and absent in the Reviewer diff.

**Section 45, stale base protection.** Task 2 implements the comparison. Task 9 places it before publication and ends the Run in `STALE_BASE`. Task 10 case 4 proves no branch reaches the remote. Version 1 performs no rebase anywhere in this plan.

**Section 46, trusted publishing.** Task 5 implements steps 1 to 8 and step 10 in one function, in the specified order, with step 5 as a hard gate. Task 8 supplies step 9. The coding agent publishes nothing, because the publication runs on the control plane and reads a credential no agent session receives.

**Section 29, Action Policy.** Task 6 adds the first enforcement point outside a prompt. Task 5 keeps the push on the control plane.

**Section 30, credentials.** Task 8 refuses a `GITHUB_TOKEN` marked for injection, and it registers the token with the redactor. No task places it in a sandbox environment.

**Section 48, Run states.** Task 7 adds three failure reasons and adds no state. `PUBLISHING` and `STALE_BASE` already exist in `RUN_STATUSES`.

**Section 49, workflow.** Task 9 follows the specified order: review, capture patch, check base, publish. The Proof Pack step and `READY_FOR_HUMAN` stay in Phase 10, as SDD section 68 requires.

**Section 63, source structure.** Every new file lands in `src/domain/publishing/`, `src/adapters/github/`, or `src/activities/`, all of which the specification names.

**Section 64.** AT-27 is proved by Task 10 case 1 to case 3 and by Task 9. AT-28 is proved by Task 10 case 4 and by the workflow test of Task 9. AT-29 is proved by Task 10 step 1. AT-35 gains its publication case in Task 9 step 4 and Task 10 case 4 of AT-29.

**Section 68.** No task creates `READY_FOR_HUMAN`. The invariant stays unsatisfiable until the Proof Pack exists.

**Known limitation to carry forward.** The SDD section 46 step 5 assertion compares two diff texts that two different git binaries produce. Controller decision 3 pins every configuration value that can change those bytes, and the two sides can still differ if the sandbox git version and the control-plane git version format a diff differently. The failure is closed, so such a Run publishes nothing and reports `PATCH_HASH_MISMATCH`. Record this in `docs/build/STATUS.md` as a carried finding for Phase 12.
