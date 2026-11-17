import type { Command, CommandResult, Sandbox, SandboxRef } from "./sandbox.js";
import { RunConfigurationError } from "./run-configuration-error.js";
import { credentialEnvironment } from "~/domain/security/git-credential-environment.js";

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
 * Removes the userinfo of every URL in a text. The clone URL of a private repository holds an
 * access token there. That token is not a Project secret, so the redactor holds no copy of it, and only this
 * function can keep it out of an error message. SDD section 60 requires the removal before the
 * error reaches Temporal history.
 */
export const withoutUrlCredentials = (text: string): string =>
  text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/g, "$1");

/**
 * The safe form of one URL for an error message. SDD section 60. A credential can sit in the
 * userinfo, but it can also sit in a query parameter or in a fragment, and an error message
 * reaches the Context Contract and Linear. Only the scheme, the host, and the path survive. A
 * text that is not a URL degrades to a fixed placeholder rather than being echoed raw.
 */
export const safeUrlForMessage = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "the configured URL";
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
};

// The command line of a clone holds the repository URL, and that URL can carry an access
// token. Every message therefore passes through `withoutUrlCredentials`.
const run = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  command: Command,
  configurationFault = false,
): Promise<CommandResult> => {
  const result = await sandbox.exec(ref, command);
  if (result.exitCode !== 0) {
    const line = withoutUrlCredentials([command.file, ...command.args].join(" "));
    const message =
      `the command "${line}" failed with exit code ${result.exitCode}: ` +
      withoutUrlCredentials(result.stderr.trim());
    throw configurationFault ? new RunConfigurationError(message) : new Error(message);
  }
  return result;
};

/**
 * The read-only repository credential of the Run, or undefined when the repository is public.
 * SDD section 30 forbids a GitHub write credential in an agent session, so this token must never
 * be able to push.
 */
export type RepositoryCredential = string | undefined;

/**
 * Clones one repository at one ref. It reports the commit it landed on. `checkoutPrimary`,
 * `checkoutReferences`, `checkoutOrganizationSkills`, and `cloneSibling` all share this
 * function, so every checkout disables the push URL and captures the base SHA the same way.
 */
export const cloneRepository = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  spec: RepositorySpec,
  path: string,
  credential: RepositoryCredential,
): Promise<string> => {
  // `--no-hardlinks` stops a clone of a local path from hardlinking object files into the
  // checkout. Without it, the read-only control on a reference checkout, and the permission
  // repair when the sandbox is destroyed, both change the mode of an inode the source
  // repository still shares. A sandbox must never change anything outside itself. Git applies
  // the local optimization only to a clone of a local path, so the option costs a remote
  // clone nothing.
  //
  // `--no-tags` was removed. `RepositorySpec.ref` allows a tag, and a clone that fetches no
  // tag leaves the later checkout of that tag with nothing to resolve. Git then reads the tag
  // as a path and the command fails.
  // The credential reaches git through the environment of this one command. It is absent from
  // the command line, so `ps` and `/proc/<pid>/cmdline` never hold it, and it is absent from
  // `.git/config`, so the agent that works in this checkout later cannot read it. SDD section 30.
  const credentialEnv = credentialEnvironment(spec.url, credential);
  await run(sandbox, ref, {
    file: "git",
    args: ["clone", "--no-hardlinks", spec.url, path],
    ...(Object.keys(credentialEnv).length === 0 ? {} : { env: credentialEnv }),
  });
  // A reference that does not exist is a configuration fault. A retry repeats it.
  await run(sandbox, ref, { file: "git", args: ["-C", path, "checkout", "--detach", spec.ref] }, true);
  // SDD section 29 denies git remote write from an agent.
  await run(sandbox, ref, {
    file: "git",
    args: ["-C", path, "remote", "set-url", "--push", "origin", "DISABLED_BY_FACTOREE"],
  });
  const head = await run(sandbox, ref, { file: "git", args: ["-C", path, "rev-parse", "HEAD"] });
  const baseSha = head.stdout.trim();
  if (!SHA.test(baseSha)) {
    throw new Error(
      `the base SHA of ${withoutUrlCredentials(spec.url)} is not forty hexadecimal characters: "${baseSha}"`,
    );
  }
  return baseSha;
};

/** SDD section 32. Checks out the primary repository. The worktree is writable. */
export const checkoutPrimary = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  spec: RepositorySpec,
  credential?: RepositoryCredential,
): Promise<CheckedOutRepository> => {
  const path = `${ref.workspacePath}/primary`;
  const baseSha = await cloneRepository(sandbox, ref, spec, path, credential);
  return { url: spec.url, path, baseSha, readOnly: false };
};

/**
 * docs/specs/change-sets.md. The checkout of one target of a change set:
 * `<workspace>/targets/<owner>/<repo>`. A run with one target keeps `<workspace>/primary`, so its
 * warm snapshots stay valid. Each segment must be one safe path segment, so no name escapes the
 * `targets/` directory.
 */
export const targetPathOf = (workspacePath: string, repository: string): string => {
  const parts = repository.split("/");
  const safe = (segment: string | undefined): segment is string =>
    segment !== undefined && segment !== "." && segment !== ".." && /^[A-Za-z0-9._-]+$/.test(segment);
  const [owner, name] = parts;
  if (parts.length !== 2 || !safe(owner) || !safe(name)) {
    throw new RunConfigurationError(`the target repository name "${repository}" is not one owner and one repository name`);
  }
  return `${workspacePath}/targets/${owner}/${name}`;
};

/** docs/specs/change-sets.md. Checks out one target of a change set. The worktree is writable. */
export const checkoutTarget = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  spec: RepositorySpec & { repository: string },
  credential?: RepositoryCredential,
): Promise<CheckedOutRepository> => {
  const path = targetPathOf(ref.workspacePath, spec.repository);
  // `git clone` makes the leading directories of its target.
  const baseSha = await cloneRepository(sandbox, ref, spec, path, credential);
  return { url: spec.url, path, baseSha, readOnly: false };
};

/**
 * docs/specs/kiln-sandbox-provider.md. Moves the primary checkout of a sandbox restored from a warm
 * snapshot to the ref of this Run. `git clean` keeps ignored files, so the dependencies the
 * bootstrap installed stay, and the bootstrap that follows only updates them.
 */
export const refreshPrimary = (
  sandbox: Sandbox,
  ref: SandboxRef,
  spec: RepositorySpec,
  credential?: RepositoryCredential,
): Promise<CheckedOutRepository> => refreshCheckout(sandbox, ref, spec, `${ref.workspacePath}/primary`, credential);

/**
 * docs/specs/change-sets.md, DI-21.136. Moves one target checkout of a sandbox restored from a set
 * snapshot to the ref of this Run, as `refreshPrimary` does for the primary checkout.
 */
export const refreshTarget = (
  sandbox: Sandbox,
  ref: SandboxRef,
  spec: RepositorySpec & { repository: string },
  credential?: RepositoryCredential,
): Promise<CheckedOutRepository> =>
  refreshCheckout(sandbox, ref, spec, targetPathOf(ref.workspacePath, spec.repository), credential);

/**
 * docs/specs/change-sets.md, DI-21.136. Moves the primary checkout of a snapshot of one repository
 * to the target folder of that repository, so a change set starts its first target from it.
 */
export const movePrimaryToTarget = async (sandbox: Sandbox, ref: SandboxRef, repository: string): Promise<string> => {
  const path = targetPathOf(ref.workspacePath, repository);
  await run(sandbox, ref, {
    file: "sh",
    args: ["-c", 'mkdir -p -- "$(dirname -- "$1")" && mv -- "$0" "$1"', `${ref.workspacePath}/primary`, path],
  });
  return path;
};

const refreshCheckout = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  spec: RepositorySpec,
  path: string,
  credential?: RepositoryCredential,
): Promise<CheckedOutRepository> => {
  const credentialEnv = credentialEnvironment(spec.url, credential);
  await run(sandbox, ref, {
    file: "git",
    args: ["-C", path, "fetch", "--no-tags", "origin", spec.ref],
    ...(Object.keys(credentialEnv).length === 0 ? {} : { env: credentialEnv }),
  });
  await run(sandbox, ref, { file: "git", args: ["-C", path, "checkout", "--force", "--detach", "FETCH_HEAD"] });
  await run(sandbox, ref, { file: "git", args: ["-C", path, "clean", "-ffd"] });
  const head = await run(sandbox, ref, { file: "git", args: ["-C", path, "rev-parse", "HEAD"] });
  const baseSha = head.stdout.trim();
  if (!SHA.test(baseSha)) {
    throw new Error(`the base SHA of ${withoutUrlCredentials(spec.url)} is not forty hexadecimal characters: "${baseSha}"`);
  }
  return { url: spec.url, path, baseSha, readOnly: false };
};

/**
 * docs/specs/pr-review-merge-and-deploy.md, D2. A PR follow-up run works on the full change of its
 * pull request. The primary checkout stays at the verified base, which the configuration was read
 * from, and the diff from the base to the pull request head lands in the worktree as uncommitted
 * change. The captured patch is then the full change against the base, so every check and the
 * reviewer see all of it. This runs in a fresh sandbox, before the bootstrap and before any agent.
 */
export const overlayPullRequestHead = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  primary: CheckedOutRepository,
  headSha: string,
  credential?: RepositoryCredential,
  /**
   * docs/specs/pr-review-merge-and-deploy.md, slice 4, DI-21.119. True when the base is a new base:
   * the worktree takes the merge of the head into it, as `git merge-tree` writes it. A conflicting
   * file holds its conflict markers. False keeps the diff from the base to the head (D2).
   */
  merge = false,
): Promise<void> => {
  if (!SHA.test(headSha)) throw new Error(`the pull request head is not forty hexadecimal characters: "${headSha}"`);
  const credentialEnv = credentialEnvironment(primary.url, credential);
  // GitHub serves a commit that a branch reaches by its SHA. A head that no branch reaches any more
  // was force-pushed away, and a retry cannot bring it back.
  await run(
    sandbox,
    ref,
    {
      file: "git",
      args: ["-C", primary.path, "fetch", "--no-tags", "origin", headSha],
      ...(Object.keys(credentialEnv).length === 0 ? {} : { env: credentialEnv }),
    },
    true,
  );
  const patchPath = `${ref.workspacePath}/pull-request.diff`;
  // The merge tree is the first line of `git merge-tree`. Exit code 1 is a conflict, whose tree holds
  // the conflict markers, and any other code is a fault.
  const target = merge
    ? 'tree=$(git -C "$0" merge-tree --write-tree --no-messages "$2" "$1" | head -n 1); ' +
      '[ -n "$tree" ] || exit 2; git -C "$0" -c core.quotePath=true -c diff.external= diff --binary --no-renames --no-ext-diff --no-textconv --no-color "$1" "$tree" > "$3"'
    : 'git -C "$0" -c core.quotePath=true -c diff.external= diff --binary --no-renames --no-ext-diff --no-textconv --no-color "$1" "$2" > "$3"';
  await run(sandbox, ref, {
    file: "sh",
    args: ["-c", target, primary.path, primary.baseSha, headSha, patchPath],
  });
  await run(sandbox, ref, { file: "git", args: ["-C", primary.path, "apply", "--binary", "--whitespace=nowarn", patchPath] }, true);
  await run(sandbox, ref, { file: "rm", args: ["-f", patchPath] });
};

/**
 * Removes the reference checkouts a warm snapshot holds. They are read-only, so the write bit
 * comes back first. `checkoutReferences` then clones each one at the ref of this Run.
 */
export const removeReferences = async (sandbox: Sandbox, ref: SandboxRef): Promise<void> => {
  const path = `${ref.workspacePath}/reference`;
  await run(sandbox, ref, { file: "sh", args: ["-c", `if [ -e "$1" ]; then chmod -R u+w "$1" && rm -rf "$1"; fi`, "sh", path] });
};

/**
 * SDD section 32. Checks out every reference repository and makes it read-only. SDD section 29
 * denies writing a reference repository and denies git remote write from an agent.
 */
export const checkoutReferences = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  specs: RepositorySpec[],
  credential?: RepositoryCredential,
): Promise<CheckedOutRepository[]> => {
  // Every reference name must resolve to its own directory, one level below `reference/`. This
  // check runs before the first reference clone, so a collision fails with a clear message
  // instead of a confusing git error about a non-empty directory.
  const namesByUrl = new Map<string, string>();
  const urlsByName = new Map<string, string>();
  const seenUrls = new Set<string>();
  for (const spec of specs) {
    // The same URL twice resolves to the same directory, and the second clone then fails with a
    // git message about a directory that exists. A reference repository gives read-only context,
    // and one ref of it is enough, so the duplicate is refused here with a clear message. A
    // second directory for a second ref would invent a naming rule that no section of the SDD
    // defines.
    if (seenUrls.has(spec.url)) {
      throw new RunConfigurationError(
        `the reference repository "${withoutUrlCredentials(spec.url)}" appears more than once. ` +
          "Every reference repository must appear once, at one ref.",
      );
    }
    seenUrls.add(spec.url);
    const name = repositoryName(spec.url);
    const existingUrl = urlsByName.get(name);
    if (existingUrl !== undefined && existingUrl !== spec.url) {
      throw new RunConfigurationError(
        `the reference repository URLs "${withoutUrlCredentials(existingUrl)}" and ` +
          `"${withoutUrlCredentials(spec.url)}" both derive the directory name ` +
          `"${name}". Every reference repository must derive a unique directory name.`,
      );
    }
    urlsByName.set(name, spec.url);
    namesByUrl.set(spec.url, name);
  }

  const references: CheckedOutRepository[] = [];
  for (const spec of specs) {
    const name = namesByUrl.get(spec.url) ?? repositoryName(spec.url);
    const path = `${ref.workspacePath}/reference/${name}`;
    const baseSha = await cloneRepository(sandbox, ref, spec, path, credential);
    // SDD section 29 denies writing a reference repository. This is a file mode, not a prompt.
    await run(sandbox, ref, { file: "chmod", args: ["-R", "a-w", path] });
    references.push({ url: spec.url, path, baseSha, readOnly: true });
  }

  return references;
};

/**
 * SDD section 16 and section 32. Checks out the organization skills repository and makes it
 * read-only. It lives in its own directory, not under `reference/`, so it can never collide with
 * a reference repository name, and it never appears in the reference path list of the prompt.
 */
export const checkoutOrganizationSkills = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  spec: RepositorySpec,
  credential?: RepositoryCredential,
): Promise<CheckedOutRepository> => {
  const path = `${ref.workspacePath}/organization-skills`;
  const baseSha = await cloneRepository(sandbox, ref, spec, path, credential);
  // SDD section 29 denies writing a repository the agent must only read. This is a file mode.
  await run(sandbox, ref, { file: "chmod", args: ["-R", "a-w", path] });
  return { url: spec.url, path, baseSha, readOnly: true };
};

/** The whole SDD section 32 checkout, for a caller that needs no step between the two halves. */
export const checkoutRepositories = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  input: CheckoutInput,
  credential?: RepositoryCredential,
): Promise<CheckoutResult> => ({
  primary: await checkoutPrimary(sandbox, ref, input.primary, credential),
  references: await checkoutReferences(sandbox, ref, input.references, credential),
});

/**
 * Derives a directory name from the last path segment of a repository URL. The derived name must
 * not be empty, must not be the current directory or the parent directory, and must contain only
 * characters that are safe as one path segment. This denies a path that escapes the
 * `reference/` directory.
 */
const repositoryName = (url: string): string => {
  const last = url.split("/").at(-1) ?? url;
  const name = last.replace(/\.git$/, "");
  if (name === "." || name === "..") {
    throw new RunConfigurationError(
      `the repository URL "${withoutUrlCredentials(url)}" derives the directory name "${name}", ` +
        "which is not allowed",
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new RunConfigurationError(
      `the repository URL "${withoutUrlCredentials(url)}" does not end in a usable directory name`,
    );
  }
  return name;
};
