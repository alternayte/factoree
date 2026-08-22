import type { Command, CommandResult, Sandbox, SandboxRef } from "./sandbox.js";

export interface RepositorySpec {
  url: string;
  /** A branch, a tag, or a commit SHA. */
  ref: string;
}

export interface CheckedOutRepository {
  url: string;
  /** The absolute path inside the sandbox. */
  path: string;
  /** The commit the checkout landed on. SDD section 55 requires the recorded SHA. */
  baseSha: string;
  readOnly: boolean;
}

export interface CheckoutInput {
  primary: RepositorySpec;
  references: RepositorySpec[];
}

export interface CheckoutResult {
  primary: CheckedOutRepository;
  references: CheckedOutRepository[];
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * SDD section 32. Checks out the primary repository, then the reference repositories.
 *
 * The primary worktree is writable. Every reference repository is made read-only. SDD section 29
 * denies writing a reference repository. The checkout removes the push URL of every clone. SDD
 * section 29 denies git remote write from an agent. Neither control is a prompt.
 */
export const checkoutRepositories = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  input: CheckoutInput,
): Promise<CheckoutResult> => {
  const run = async (command: Command): Promise<CommandResult> => {
    const result = await sandbox.exec(ref, command);
    if (result.exitCode !== 0) {
      throw new Error(
        `the command "${[command.file, ...command.args].join(" ")}" failed with exit code ` +
          `${result.exitCode}: ${result.stderr.trim()}`,
      );
    }
    return result;
  };

  const clone = async (spec: RepositorySpec, path: string): Promise<string> => {
    await run({ file: "git", args: ["clone", "--no-tags", spec.url, path] });
    await run({ file: "git", args: ["-C", path, "checkout", "--detach", spec.ref] });
    // SDD section 29 denies git remote write from an agent.
    await run({ file: "git", args: ["-C", path, "remote", "set-url", "--push", "origin", "DISABLED_BY_FACTOREE"] });
    const head = await run({ file: "git", args: ["-C", path, "rev-parse", "HEAD"] });
    const baseSha = head.stdout.trim();
    if (!SHA.test(baseSha)) {
      throw new Error(`the base SHA of ${spec.url} is not forty hexadecimal characters: "${baseSha}"`);
    }
    return baseSha;
  };

  const primaryPath = `${ref.workspacePath}/primary`;
  const primaryBaseSha = await clone(input.primary, primaryPath);

  const references: CheckedOutRepository[] = [];
  for (const spec of input.references) {
    const name = repositoryName(spec.url);
    const path = `${ref.workspacePath}/reference/${name}`;
    const baseSha = await clone(spec, path);
    // SDD section 29 denies writing a reference repository. This is a file mode, not a prompt.
    await run({ file: "chmod", args: ["-R", "a-w", path] });
    references.push({ url: spec.url, path, baseSha, readOnly: true });
  }

  return {
    primary: { url: input.primary.url, path: primaryPath, baseSha: primaryBaseSha, readOnly: false },
    references,
  };
};

const repositoryName = (url: string): string => {
  const last = url.split("/").at(-1) ?? url;
  const name = last.replace(/\.git$/, "");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`the repository URL "${url}" does not end in a usable directory name`);
  }
  return name;
};
