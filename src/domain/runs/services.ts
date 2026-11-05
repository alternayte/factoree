import { RunConfigurationError } from "./run-configuration-error.js";
import type { ServicesConfig } from "./project-runtime-config.js";
import type { Sandbox, SandboxRef } from "./sandbox.js";
import type { RepositoryFileEntry } from "./warm-snapshot.js";
import { withoutUrlCredentials } from "./checkout.js";

/**
 * docs/specs/repository-setup-and-services.md. Rootless Docker runs as the sandbox user, so its
 * socket lives in that user's runtime directory. The sandbox image fixes the user and its home.
 */
export const DOCKER_RUNTIME_DIR = "/home/agent/.docker/run";

/**
 * The environment every process on the sandbox image receives. Testcontainers reads
 * `DOCKER_HOST`, and Ryuk adds nothing in a sandbox that is destroyed.
 */
export const DOCKER_ENVIRONMENT: Readonly<Record<string, string>> = {
  XDG_RUNTIME_DIR: DOCKER_RUNTIME_DIR,
  DOCKER_HOST: `unix://${DOCKER_RUNTIME_DIR}/docker.sock`,
  TESTCONTAINERS_RYUK_DISABLED: "true",
  // mise reads a repository mise.toml only from a trusted path, and must never prompt.
  MISE_TRUSTED_CONFIG_PATHS: "/home/agent/workspace",
  MISE_YES: "1",
  // DI-21.10. NuGet checks the revocation of each package signature over plain HTTP on port 80,
  // which the Kiln egress filter drops, so each check waits for the TCP timeout. Offline mode
  // still verifies every signature and skips only the online revocation lookup.
  NUGET_CERT_REVOCATION_MODE: "offline",
};

/** The root-owned script in the sandbox image that starts rootless Docker, or does nothing when it runs. */
export const DOCKER_START_SCRIPT = "/opt/factoree/bin/factoree-docker-start";

/** docs/specs/repository-setup-and-services.md. The compose file Factoree passes after the repository's own. */
export const FACTOREE_COMPOSE_OVERLAY = ".factoree/compose.yaml";

const tail = (stdout: string, stderr: string): string =>
  withoutUrlCredentials(`${stdout}\n${stderr}`.trim().split("\n").slice(-20).join("\n")).slice(-2000);

/**
 * Lists every tracked file of a checkout with its git blob SHA, the same SHA the GitHub tree API
 * reports, so the run and the build-ahead trigger compute one bootstrap key.
 */
export const listRepositoryFiles = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  primaryPath: string,
): Promise<RepositoryFileEntry[]> => {
  const result = await sandbox.exec(ref, { file: "git", args: ["-C", primaryPath, "ls-files", "-s", "-z"], cwd: "/" });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed with exit code ${result.exitCode}: ${tail(result.stdout, result.stderr)}`);
  }
  const files: RepositoryFileEntry[] = [];
  for (const record of result.stdout.split("\0")) {
    // "<mode> <sha> <stage>\t<path>"
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [, sha] = record.slice(0, tab).split(" ");
    if (sha === undefined) continue;
    files.push({ path: record.slice(tab + 1), sha });
  }
  return files;
};

/** Starts rootless Docker in the sandbox. A sandbox where it already runs starts nothing. */
export const ensureDocker = async (sandbox: Sandbox, ref: SandboxRef): Promise<void> => {
  if (!sandbox.capabilities.supportsDocker) {
    throw new RunConfigurationError(
      `.factoree/config.yaml asks for Docker or a services block, but the sandbox provider "${sandbox.name}" ` +
        "runs no Docker. Use the Kiln or the E2B provider, or remove services and docker from the config.",
    );
  }
  const result = await sandbox.exec(ref, { file: "sh", args: [DOCKER_START_SCRIPT], cwd: "/" });
  if (result.exitCode !== 0) {
    throw new Error(`rootless Docker did not start, exit code ${result.exitCode}: ${tail(result.stdout, result.stderr)}`);
  }
};

const composeArguments = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  primaryPath: string,
  services: ServicesConfig,
): Promise<string[]> => {
  const files = [services.compose];
  if (services.compose !== FACTOREE_COMPOSE_OVERLAY) {
    const overlay = await sandbox.exec(ref, { file: "test", args: ["-f", FACTOREE_COMPOSE_OVERLAY], cwd: primaryPath });
    if (overlay.exitCode === 0) files.push(FACTOREE_COMPOSE_OVERLAY);
  }
  return [
    "compose",
    ...files.flatMap((file) => ["-f", file]),
    ...services.profiles.flatMap((profile) => ["--profile", profile]),
  ];
};

/**
 * Starts the compose stack and waits for its healthchecks. It is idempotent: on a stack that runs
 * and is healthy it changes nothing, and it restarts a container that stopped.
 */
export const startServices = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  primaryPath: string,
  services: ServicesConfig,
): Promise<void> => {
  const args = [
    ...(await composeArguments(sandbox, ref, primaryPath, services)),
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    String(services.waitTimeoutSeconds),
  ];
  const result = await sandbox.exec(ref, {
    file: "docker",
    args,
    cwd: primaryPath,
    timeoutMs: (services.waitTimeoutSeconds + 600) * 1000,
  });
  if (result.exitCode !== 0) {
    throw new RunConfigurationError(
      `the compose stack did not become healthy, exit code ${result.exitCode}: ${tail(result.stdout, result.stderr)}`,
    );
  }
};

/** Runs the seed command once, after the bootstrap, so the stack holds the data the app needs. */
export const seedServices = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  primaryPath: string,
  services: ServicesConfig,
): Promise<void> => {
  if (services.seed === null) return;
  const result = await sandbox.exec(ref, { file: "sh", args: ["-c", services.seed], cwd: primaryPath });
  if (result.exitCode !== 0) {
    throw new RunConfigurationError(`the seed command failed with exit code ${result.exitCode}: ${tail(result.stdout, result.stderr)}`);
  }
};

/** docs/specs/repository-setup-and-services.md. One compose service that answers for an external API. */
export interface FakeService {
  /** The compose service name. */
  service: string;
  /** The API it answers for, from the `factoree.fake` label. */
  name: string;
}

/** The compose label that marks a fake. */
export const FAKE_LABEL = "factoree.fake";

/**
 * Reads the fakes of the stack from the merged compose configuration, the repository file and the
 * Factoree overlay together, so a fake the overlay adds counts.
 */
export const listFakes = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  primaryPath: string,
  services: ServicesConfig,
): Promise<FakeService[]> => {
  const args = [...(await composeArguments(sandbox, ref, primaryPath, services)), "config", "--format", "json"];
  const result = await sandbox.exec(ref, { file: "docker", args, cwd: primaryPath });
  if (result.exitCode !== 0) {
    throw new RunConfigurationError(`docker compose config failed with exit code ${result.exitCode}: ${tail(result.stdout, result.stderr)}`);
  }
  const document = JSON.parse(result.stdout) as { services?: Record<string, { labels?: unknown }> };
  const fakes: FakeService[] = [];
  for (const [service, definition] of Object.entries(document.services ?? {})) {
    const labels = definition.labels;
    let name: unknown;
    if (Array.isArray(labels)) {
      const entry = labels.find((label): label is string => typeof label === "string" && label.startsWith(`${FAKE_LABEL}=`));
      name = entry?.slice(FAKE_LABEL.length + 1);
    } else if (typeof labels === "object" && labels !== null) {
      name = (labels as Record<string, unknown>)[FAKE_LABEL];
    }
    if (typeof name === "string" && name.trim() !== "") fakes.push({ service, name: name.trim() });
  }
  return fakes.sort((left, right) => (left.service < right.service ? -1 : 1));
};
