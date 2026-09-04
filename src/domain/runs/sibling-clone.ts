import type { AgentRunProductRepositoryInput } from "~/workflows/agent-run.workflow.js";
import type { EvidenceStore } from "~/domain/evidence/evidence.js";
import { canonicalEvidenceHash } from "~/domain/evidence/evidence.js";
import { decideSiblingAction, SiblingActionDeniedError } from "~/domain/policy/action-policy.js";
import { buildRepositoryUrl } from "~/domain/projects/repository-url.js";
import type { RepositoryCredential } from "./checkout.js";
import { cloneRepository, withoutUrlCredentials } from "./checkout.js";
import type { Sandbox, SandboxRef } from "./sandbox.js";

/** Reported by `buildSiblingCloner` when the Action Policy denies the clone. */
export class SiblingCloneDeniedError extends SiblingActionDeniedError {}

export interface CloneSiblingInput {
  /** The `owner/repo` full name of the sibling repository. */
  fullName: string;
  runId: string;
  /** The role of the requesting session, for example `implementer`. It reaches the evidence row. */
  role: string;
}

export interface CloneSiblingResult {
  /** The absolute path inside the sandbox, outside the target working tree. */
  path: string;
  commitSha: string;
}

export interface SiblingClonerOptions {
  sandbox: Sandbox;
  ref: SandboxRef;
  evidence: EvidenceStore;
  tenantId: string;
  /** Every repository the Run's Product owns. Membership is checked against this list alone. */
  repositories: AgentRunProductRepositoryInput[];
  repositoryBaseUrl: string;
  /** A read-only repository credential, for a private sibling. SDD section 30. */
  credential?: RepositoryCredential;
}

export interface SiblingCloner {
  cloneSibling(input: CloneSiblingInput): Promise<CloneSiblingResult>;
}

/**
 * Builds the gate a session uses to read a sibling repository of the Run's Product. Task 14.
 *
 * The clone lands in `siblings/<owner>/<repo>`, outside `primary/`. A commit to `primary/` can
 * never include a sibling by accident. `chmod -R a-w` denies a write to the clone after it
 * completes, so the read-only rule is a file mode, not a prompt. Every clone writes one
 * immutable evidence row, so the Reviewer can see which sibling the requesting role read.
 */
export const buildSiblingCloner = (options: SiblingClonerOptions): SiblingCloner => {
  const members = options.repositories.map((repository) => repository.fullName);

  return {
    cloneSibling: async (input: CloneSiblingInput): Promise<CloneSiblingResult> => {
      const decision = decideSiblingAction({ action: "clone_sibling", fullName: input.fullName, members });
      if (decision === "deny") throw new SiblingCloneDeniedError("clone_sibling", input.fullName);

      const repository = options.repositories.find((entry) => entry.fullName === input.fullName);
      // `decideSiblingAction` already confirmed membership from the same list, so this branch is
      // unreachable. It guards the lookup below against a future change to either list.
      if (repository === undefined) {
        throw new SiblingCloneDeniedError("clone_sibling", input.fullName);
      }

      const url = buildRepositoryUrl(options.repositoryBaseUrl, repository.fullName);
      const path = `${options.ref.workspacePath}/siblings/${repository.fullName}`;
      const commitSha = await cloneRepository(
        options.sandbox,
        options.ref,
        { url, ref: repository.defaultBranch },
        path,
        options.credential,
      );
      // The clone is read-only. This is a file mode, not a prompt. `checkoutReferences` uses
      // the same control on a reference repository.
      const chmod = await options.sandbox.exec(options.ref, { file: "chmod", args: ["-R", "a-w", path] });
      if (chmod.exitCode !== 0) {
        throw new Error(
          `the command "chmod -R a-w ${path}" failed with exit code ${chmod.exitCode}: ` +
            withoutUrlCredentials(chmod.stderr.trim()),
        );
      }

      const metadata = { fullName: repository.fullName, commitSha, role: input.role };
      await options.evidence.record({
        tenantId: options.tenantId,
        runId: input.runId,
        validationAssertionId: null,
        kind: "sibling_read",
        source: "sibling_clone",
        sha256: canonicalEvidenceHash(metadata),
        metadata,
        idempotencyKey: `sibling-read:${input.runId}:${repository.fullName}:${input.role}`,
      });

      return { path, commitSha };
    },
  };
};
