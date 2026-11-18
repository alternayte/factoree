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
  // DI-21.15. mise reads `.factoree/mise.toml` as its global config, in every command. The sixth
  // anthology setup proved nothing: its agent had run `mise use --global` in its own sandbox, and
  // in the fresh proof sandbox `mise install` found no tool and `dotnet` was not found. A missing
  // file is no error, and a repository mise.toml is still read beside it.
  MISE_CONFIG_FILE: "/home/agent/workspace/primary/.factoree/mise.toml",
  // DI-21.10, DI-21.11. NuGet checks the revocation of each package signature over plain HTTP
  // on port 80, and no allow list of a run holds those hosts, so each online check fails with a
  // warning per package. Offline mode still verifies every signature and skips only the lookup.
  NUGET_CERT_REVOCATION_MODE: "offline",
  // DI-21.12. The .NET CLI sends telemetry to a host no allow list holds, and prints a first-run
  // banner into every captured output.
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_NOLOGO: "1",
};

/**
 * docs/specs/change-sets.md. The environment of a command that Factoree runs in one target of a
 * change set: mise reads the `.factoree/mise.toml` of that target.
 */
export const targetEnvironmentOf = (targetPath: string): Record<string, string> => ({
  MISE_CONFIG_FILE: `${targetPath}/.factoree/mise.toml`,
});

/**
 * docs/specs/change-sets.md. The compose project name of one target of a change set: its
 * `owner-repo` name in lower case, with every character compose refuses as `-`.
 */
export const composeProjectOf = (repository: string): string =>
  repository.toLowerCase().replace(/[^a-z0-9_-]/g, "-");

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
  extraFiles: readonly string[] = [],
): Promise<string[]> => {
  const files = [services.compose];
  if (services.compose !== FACTOREE_COMPOSE_OVERLAY) {
    const overlay = await sandbox.exec(ref, { file: "test", args: ["-f", FACTOREE_COMPOSE_OVERLAY], cwd: primaryPath });
    if (overlay.exitCode === 0) files.push(FACTOREE_COMPOSE_OVERLAY);
  }
  files.push(...extraFiles);
  return [
    "compose",
    ...(services.project === undefined ? [] : ["-p", services.project]),
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
  /**
   * docs/specs/change-sets.md, DI-21.146. The compose services that do not run: the fakes a wired
   * provider answers for. `--scale 0` removes a running one, so its published port is free.
   */
  without: readonly string[] = [],
  /**
   * docs/specs/change-sets.md, DI-21.150. Host names each listed service resolves in its
   * `/etc/hosts`: a wired consumer reaches the provider under the name of the fake it replaces.
   */
  hosts?: StackHosts,
): Promise<void> => {
  const extraFiles: string[] = [];
  if (hosts !== undefined && hosts.services.length > 0 && hosts.entries.length > 0) {
    const file = `/tmp/factoree-hosts-${composeProjectOf(services.project ?? primaryPath)}.json`;
    await sandbox.writeFile(ref, file, hostsOverlayOf(hosts));
    extraFiles.push(file);
  }
  const args = [
    ...(await composeArguments(sandbox, ref, primaryPath, services, extraFiles)),
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    String(services.waitTimeoutSeconds),
    ...without.flatMap((service) => ["--scale", `${service}=0`]),
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

/**
 * docs/specs/change-sets.md, DI-21.136. Stops the compose stack of a checkout and drops its
 * containers and volumes. The images stay, so a stack that starts again pulls nothing.
 */
export const stopServices = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  primaryPath: string,
  services: ServicesConfig,
): Promise<void> => {
  const args = [...(await composeArguments(sandbox, ref, primaryPath, services)), "down", "--volumes", "--remove-orphans"];
  const result = await sandbox.exec(ref, { file: "docker", args, cwd: primaryPath, timeoutMs: 600_000 });
  if (result.exitCode !== 0) {
    throw new Error(`the compose stack did not stop, exit code ${result.exitCode}: ${tail(result.stdout, result.stderr)}`);
  }
};

/**
 * docs/specs/change-sets.md, DI-21.146. Stops the containers of a stack and keeps them, their
 * volumes and their data, so the next `startServices` resumes the seeded stack. A check sprite of a
 * change set runs one stack, or the stacks of one wired group, at a time.
 */
export const pauseServices = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  primaryPath: string,
  services: ServicesConfig,
): Promise<void> => {
  const args = [...(await composeArguments(sandbox, ref, primaryPath, services)), "stop"];
  const result = await sandbox.exec(ref, { file: "docker", args, cwd: primaryPath, timeoutMs: 600_000 });
  if (result.exitCode !== 0) {
    throw new Error(`the compose stack did not stop, exit code ${result.exitCode}: ${tail(result.stdout, result.stderr)}`);
  }
};

/** Runs the seed command once, after the bootstrap, so the stack holds the data the app needs. */
export const seedServices = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  primaryPath: string,
  services: ServicesConfig,
  /** docs/specs/change-sets.md. The environment of a target of a change set, its MISE_CONFIG_FILE. */
  env?: Record<string, string>,
): Promise<void> => {
  if (services.seed === null) return;
  const result = await sandbox.exec(ref, { file: "sh", args: ["-c", services.seed], cwd: primaryPath, ...(env === undefined ? {} : { env }) });
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
  /**
   * docs/specs/change-sets.md, DI-21.145. The `owner/repo` of the product repository that serves the
   * API, from the `factoree.fake.repository` label. Absent when the label is absent.
   */
  repository?: string;
  /** DI-21.146. The host ports the service publishes, in order. Empty when it publishes none. */
  ports?: number[];
  /**
   * DI-21.150. The container ports of the service, from `ports` and `expose`, in order: the ports
   * another container of the stack calls under the service name. Absent when it declares none.
   */
  containerPorts?: number[];
}

/** docs/specs/change-sets.md, DI-21.150. The `/etc/hosts` entries of the services of one stack. */
export interface StackHosts {
  /** The compose services that get the entries. */
  services: string[];
  /** `<host name>:<address>`, the compose `extra_hosts` form. */
  entries: string[];
}

/** DI-21.150. The compose file, in JSON, that gives each listed service the host entries. */
export const hostsOverlayOf = (hosts: StackHosts): string =>
  JSON.stringify({ services: Object.fromEntries(hosts.services.map((service) => [service, { extra_hosts: hosts.entries }])) });

/** The compose label that marks a fake. */
export const FAKE_LABEL = "factoree.fake";

/** docs/specs/change-sets.md. The compose label that names the product repository that serves a fake. */
export const FAKE_REPOSITORY_LABEL = "factoree.fake.repository";

/** The value of one compose label, from the list form or the map form of `labels`. */
const labelOf = (labels: unknown, name: string): string | null => {
  let value: unknown;
  if (Array.isArray(labels)) {
    const entry = labels.find((label): label is string => typeof label === "string" && label.startsWith(`${name}=`));
    value = entry?.slice(name.length + 1);
  } else if (typeof labels === "object" && labels !== null) {
    value = (labels as Record<string, unknown>)[name];
  }
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

/** The host ports of one service in `docker compose config --format json`, which writes the long form. */
const publishedPortsOf = (ports: unknown): number[] => {
  if (!Array.isArray(ports)) return [];
  const published: number[] = [];
  for (const port of ports) {
    if (typeof port !== "object" || port === null) continue;
    const value = Number((port as { published?: unknown }).published);
    if (Number.isInteger(value) && value > 0 && value < 65536) published.push(value);
  }
  return published;
};

/** DI-21.150. The container ports of one service: each `target` of `ports`, then each `expose`. */
const containerPortsOf = (ports: unknown, expose: unknown): number[] => {
  const found: number[] = [];
  const add = (value: unknown): void => {
    const port = Number(typeof value === "string" ? value.split("/")[0] : value);
    if (Number.isInteger(port) && port > 0 && port < 65536 && !found.includes(port)) found.push(port);
  };
  if (Array.isArray(ports)) {
    for (const port of ports) if (typeof port === "object" && port !== null) add((port as { target?: unknown }).target);
  }
  if (Array.isArray(expose)) for (const port of expose) add(port);
  return found;
};

/** A compose service as `docker compose config --format json` writes it. */
interface ComposeServiceDefinition {
  labels?: unknown;
  ports?: unknown;
  expose?: unknown;
  network_mode?: unknown;
}

/** One stack: its fakes, and the services that can take `/etc/hosts` entries. */
export interface ComposeStack {
  fakes: FakeService[];
  /**
   * DI-21.150. The services, sorted, without one that shares the network of another service or
   * container (`network_mode: service:` or `container:`), which Docker gives no host entry.
   */
  hostServices: string[];
}

/**
 * Reads the fakes of the stack from the merged compose configuration, the repository file and the
 * Factoree overlay together, so a fake the overlay adds counts.
 */
export const listFakes = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  primaryPath: string,
  services: ServicesConfig,
): Promise<FakeService[]> => (await listStack(sandbox, ref, primaryPath, services)).fakes;

/** The fakes and the host-entry services of the stack, from the merged compose configuration. */
export const listStack = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  primaryPath: string,
  services: ServicesConfig,
): Promise<ComposeStack> => {
  const args = [...(await composeArguments(sandbox, ref, primaryPath, services)), "config", "--format", "json"];
  const result = await sandbox.exec(ref, { file: "docker", args, cwd: primaryPath });
  if (result.exitCode !== 0) {
    throw new RunConfigurationError(`docker compose config failed with exit code ${result.exitCode}: ${tail(result.stdout, result.stderr)}`);
  }
  return stackOfComposeConfig(result.stdout);
};

/** The fakes of one merged compose configuration, sorted by service name. */
export const fakesOfComposeConfig = (json: string): FakeService[] => stackOfComposeConfig(json).fakes;

/** The stack of one merged compose configuration. */
export const stackOfComposeConfig = (json: string): ComposeStack => {
  const document = JSON.parse(json) as { services?: Record<string, ComposeServiceDefinition> };
  const fakes: FakeService[] = [];
  const hostServices: string[] = [];
  for (const [service, definition] of Object.entries(document.services ?? {})) {
    const mode = typeof definition.network_mode === "string" ? definition.network_mode : "";
    if (!mode.startsWith("service:") && !mode.startsWith("container:")) hostServices.push(service);
    const name = labelOf(definition.labels, FAKE_LABEL);
    if (name === null) continue;
    const repository = labelOf(definition.labels, FAKE_REPOSITORY_LABEL);
    const ports = publishedPortsOf(definition.ports);
    const containerPorts = containerPortsOf(definition.ports, definition.expose);
    fakes.push({
      service,
      name,
      ...(repository === null ? {} : { repository }),
      ...(ports.length === 0 ? {} : { ports }),
      ...(containerPorts.length === 0 ? {} : { containerPorts }),
    });
  }
  return {
    fakes: fakes.sort((left, right) => (left.service < right.service ? -1 : 1)),
    hostServices: hostServices.sort(),
  };
};
