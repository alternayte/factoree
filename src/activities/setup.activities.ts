import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import type { RepositoryDiscoveryClient, RepositoryFileReader } from "~/adapters/github/repository-discovery-client.js";
import { parseFactoreeConfig, sandboxMinimumOf } from "~/domain/products/factoree-config.js";
import type { SandboxMinimum } from "~/domain/settings/install-settings.js";
import type { SandboxProviderSelector } from "~/domain/runs/provider-selection.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import { registerProjectSecrets } from "~/domain/products/redaction-loader.js";
import { buildRepositoryUrl } from "~/domain/products/repository-url.js";
import { attachRunnerEnvironment, loadRunnerEnvironment } from "~/domain/products/runner-credentials.js";
import { CLAUDE_CREDENTIAL_NAMES, claudeApiHostOf, hasClaudeCredential, resolveRole } from "~/domain/products/agent-settings.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import type { GitHubTokenProvider } from "~/domain/products/github-token-provider.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { capturePatch } from "~/domain/publishing/patch.js";
import type { PullRequestPort } from "~/domain/publishing/pull-request.js";
import { publishToBranch } from "~/domain/publishing/trusted-checkout.js";
import type { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import { projectDefaultsOf } from "~/domain/runs/build-ahead.js";
import { checkoutPrimary, refreshPrimary, withoutUrlCredentials } from "~/domain/runs/checkout.js";
import { capInstructions, REPOSITORY_INSTRUCTION_FILES } from "~/domain/runs/repository-config-source.js";
import { SandboxSlotUnavailableError } from "~/domain/runs/sandbox-slot-error.js";
import type { WarmSnapshotStore } from "~/domain/runs/warm-snapshot.js";
import { PreviewStartError, startPreview, stopPreview, type PreviewHandle, type ReadinessProbe } from "~/domain/runs/preview.js";
import { bootstrapAllowListOf, toProjectRuntimeConfig } from "~/domain/runs/project-runtime-config.js";
import { allowListCovers, narrowAllowList, type Sandbox, type SandboxRef } from "~/domain/runs/sandbox.js";
import { BOOTSTRAP_TIMEOUT_MS, bootstrapScript } from "~/domain/runs/sandbox-manager.js";
import { readDerivedHosts, uncoveredDerivedHosts, type DerivedHostCoverage } from "~/domain/setup/derived-hosts.js";
import { classifyNugetFeeds, FACTOREE_NUGET_CONFIG, needsNugetPrecheck, readNugetConfigFiles } from "~/domain/setup/nuget-feeds.js";
import { nugetPrecheckKeyOf, nugetPromptFactsOf, runNugetPrecheck, type NugetPrecheckReport, type NugetPrecheckResult } from "~/domain/setup/nuget-precheck.js";
import { dockerLogSize, dockerPullFailures, ensureDocker, listFakes, seedServices, startServices } from "~/domain/runs/services.js";
import { runVerification } from "~/domain/runs/verification.js";
import { alreadyRequested, type AppChangeIssueStore } from "~/domain/setup/app-change-issues.js";
import { ECOSYSTEM_HOSTS } from "~/domain/setup/ecosystem-hosts.js";
import {
  skipSourceOf,
  setupBranchName,
  setupSandboxRunId,
  type RepositorySetupStore,
  type RepositorySetupStatus,
  type SetupSessionUsage,
} from "~/domain/setup/repository-setup.js";
import {
  failureExcerpt,
  parseLeftOutStacks,
  parseSetupSources,
  provenConfigOf,
  renderSetupReport,
  withPreviewDependents,
  withSources,
  type SetupPartResult,
  type SetupReport,
} from "~/domain/setup/setup-report.js";
import type { BrowserDriver } from "~/domain/validation/browser-driver.js";
import { signInStepsOf } from "~/domain/validation/user-validator.js";
import { renderSetupPrompt, SETUP_PROMPT_VERSION, type SetupPromptFields } from "~/prompts/setup.js";
import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { PUBLICATION_COMMIT_TIMESTAMP } from "./publishing.activities.js";
import { NO_HOST_CREDENTIALS, type HostCredentialAccess } from "~/domain/products/host-credentials.js";
import { applyEgress, assertBindable, probeCredentialHosts, probeHosts, type CredentialBindingStore, type CredentialEgress } from "~/domain/runs/credential-egress.js";
import { recordRunEvent, type RunEventRecorder } from "~/domain/diagnostics/run-event.js";
import { higherPeak, killedOf, readSandboxFault, readSandboxPeak, reportSandboxFault, startResourceSampler, type SandboxPeak } from "~/domain/runs/sandbox-fault.js";
import { faultEgressFacts, withDeniedHosts } from "~/domain/diagnostics/egress-facts.js";
import { recordSessionFaults } from "./agent-session-recording.js";
import { isMember } from "~/domain/products/membership.js";

export interface SetupActivityDependencies {
  /** docs/specs/run-diagnostics.md. The writer of run events, absent in a test that records none. */
  events?: RunEventRecorder | undefined;
  setups: RepositorySetupStore;
  products: Pick<ProductRegistry, "findById">;
  sandbox: Sandbox;
  /**
   * docs/specs/sandbox-provider-spillover.md. Picks the provider of a setup by the rule of a run.
   * Absent means the default provider.
   */
  providerSelector?: SandboxProviderSelector | undefined;
  runners: AgentRunnerRegistry;
  secrets: SecretStore;
  tokens: GitHubTokenProvider;
  discoveryClient: Pick<RepositoryDiscoveryClient, "listInstallationRepositories">;
  /** docs/specs/setup-speed-and-history.md. Reads the head SHA and the files the setup input key needs. */
  repositoryFiles: RepositoryFileReader;
  /** docs/specs/setup-speed-and-history.md. The warm snapshots the session sandbox can start from. */
  warmSnapshots?: Pick<WarmSnapshotStore, "find"> | undefined;
  browser: BrowserDriver;
  previewProbe: ReadinessProbe;
  pullRequests: (token: string) => PullRequestPort;
  gitAuthor: () => Promise<{ name: string; email: string }>;
  repositoryBaseUrl: () => Promise<string>;
  redactor: Redactor;
  logger: Logger;
  /** docs/specs/setup-app-change-issues.md. The stored app-change issues, so the report names the ones already requested. */
  appChangeIssues?: Pick<AppChangeIssueStore, "listForRepository"> | undefined;
  /** docs/specs/host-credentials.md. The host credentials of a product, with their bindings. */
  hostCredentials?: ((tenantId: string, productId: string, checkoutRepositories: readonly string[]) => Promise<HostCredentialAccess>) | undefined;
  /** docs/specs/host-credentials.md. Where a sandbox with a `github` binding is recorded for its refresh. */
  credentialBindings?: CredentialBindingStore | undefined;
  /** docs/specs/host-credentials.md. The hosts the product's credentials reach, for the setup prompt. */
  credentialHosts?: ((tenantId: string, productId: string) => Promise<string[]>) | undefined;
  /** docs/specs/private-stack-onboarding.md. What already covers a derived host of the product. */
  derivedHostCoverage?: ((tenantId: string, productId: string) => Promise<DerivedHostCoverage>) | undefined;
  /**
   * docs/specs/change-sets.md, DI-21.145. The repositories of the product, so the setup agent can
   * name the one that serves a fake. Absent means the prompt names none.
   */
  repositories?: Pick<RepositoryRegistry, "listByProduct" | "findByFullName"> | undefined;
}

/** docs/specs/setup-speed-and-history.md. The prompt fields that hold no sandbox path. */
export type SetupPromptInputs = Omit<SetupPromptFields, "primaryRepositoryPath" | "appChangesPath" | "sourcesPath" | "leftOutPath">;

/**
 * docs/specs/setup-speed-and-history.md. What a setup does after its inputs are read.
 * docs/specs/nuget-private-feed-mapping.md: `precheck` means a NuGet feed needs the pre-check,
 * which decides the setup input key and the skip.
 */
export type PreparedSetup =
  | {
      kind: "run";
      defaultBranch: string;
      headSha: string;
      prompt: SetupPromptInputs;
      /** docs/specs/nuget-private-feed-mapping.md. The pre-check, when one ran. */
      nuget?: NugetPrecheckReport;
      /** docs/specs/nuget-private-feed-mapping.md. The `.factoree/nuget.config` the pre-check wrote. */
      nugetConfig?: string;
    }
  | { kind: "precheck"; defaultBranch: string; headSha: string; prompt: SetupPromptInputs }
  | { kind: "skipped" }
  | { kind: "failed"; reason: string };

/** What a setup does once every check before its session ran. */
export type ReadySetup = Exclude<PreparedSetup, { kind: "precheck" }>;

/**
 * docs/specs/setup-speed-and-history.md. The setup input key: the SHA-256 of the head SHA and the
 * rendered setup prompt, with fixed text where the sandbox paths go.
 * docs/specs/nuget-private-feed-mapping.md: and the outcome of the NuGet pre-check when one ran,
 * because the mirror and the credential live outside the repository.
 */
export const setupInputKeyOf = (headSha: string, prompt: SetupPromptInputs, nuget?: NugetPrecheckReport): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        headSha,
        prompt: renderSetupPrompt({ ...prompt, primaryRepositoryPath: "<repository>", appChangesPath: "<app changes file>", sourcesPath: "<sources file>", leftOutPath: "<left-out file>" }),
        ...(nuget === undefined ? {} : { nuget: nugetPrecheckKeyOf(nuget) }),
      }),
    )
    .digest("hex");

/** The agent session of one setup, and what it wrote. */
export type SetupSessionOutput =
  | {
      kind: "proposed";
      defaultBranch: string;
      baseSha: string;
      /** The `.factoree/**` patch the session wrote, with the allow list Factoree filled in. */
      patchBase64: string;
      proposal: string;
      observedHosts: string[];
      deniedHosts: string[];
      /** docs/specs/host-credentials.md. The credential and redirect hosts the session reached. */
      credentialHosts?: string[];
      egressRecorded: boolean;
      appChanges: string[];
      /** docs/specs/setup-speed-and-history.md. The session sandbox started from the warm snapshot. */
      warm: boolean;
      /** docs/specs/private-stack-onboarding.md. The source of each part, keyed `<kind>:<name>`. */
      sources?: Record<string, string>;
      /** GitHub issue 82. The stacks the agent found and did not propose, as failed `stack` parts. */
      leftOut?: SetupPartResult[];
      /** docs/specs/nuget-private-feed-mapping.md. The NuGet pre-check before the session, for the report. */
      nuget?: NugetPrecheckReport;
    }
  | { kind: "failed"; reason: string };

export interface SetupProofOutput {
  status: Extract<RepositorySetupStatus, "proposed" | "partial" | "failed" | "unchanged">;
  pullRequestUrl: string | null;
  failureMessage: string | null;
}

/** The longest a setup agent session may run. */
// setup@2 names this limit to the agent. Change both together.
const SETUP_SESSION_TIMEOUT_MS = 60 * 60_000;
/** The longest one proof command may run. */
const PROOF_COMMAND_TIMEOUT_MS = 30 * 60_000;
/** GitHub issue 84. The least session time a retry after a hang needs to write a config. */
const SETUP_HANG_RETRY_MIN_MS = 10 * 60_000;
const CONFIG = ".factoree/config.yaml";

const tail = (stdout: string, stderr: string): string => `${stdout}\n${stderr}`.trim().split("\n").slice(-30).join("\n").slice(-3000);

const hostsOf = (url: string): string[] => {
  try {
    return [new URL(url).hostname.toLowerCase()];
  } catch {
    return [];
  }
};

/** The bootstrap allow list of a config text, or none when it has no list or does not parse. */
const existingBootstrapHosts = (config: string | null): string[] => {
  if (config === null) return [];
  try {
    const hosts: unknown = (parseDocument(config).toJS() as { bootstrap?: { allowedDomains?: unknown } } | null)?.bootstrap?.allowedDomains;
    return Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === "string") : [];
  } catch {
    return [];
  }
};

/** Every path the worktree changed, from `git status`, so an ignored file is no escape. */
const changedPaths = async (sandbox: Sandbox, ref: SandboxRef, primaryPath: string): Promise<string[]> => {
  const status = await sandbox.exec(ref, {
    file: "git",
    args: ["-C", primaryPath, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no"],
    cwd: "/",
  });
  const paths: string[] = [];
  const records = status.stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4) continue;
    paths.push(record.slice(3));
    // A rename names its source in the next record.
    if (record[0] === "R" || record[0] === "C") index += 1;
  }
  return paths;
};

const readText = async (sandbox: Sandbox, ref: SandboxRef, path: string): Promise<string | null> => {
  const result = await sandbox.exec(ref, { file: "cat", args: [path], cwd: "/" });
  return result.exitCode === 0 ? result.stdout : null;
};

export const createSetupActivities = (dependencies: SetupActivityDependencies) => {
  const load = async (setupId: string) => {
    const setup = await dependencies.setups.findById(setupId);
    if (setup === null) throw new Error(`the setup ${setupId} does not exist`);
    const product = await dependencies.products.findById(setup.tenantId, setup.productId);
    if (product === null) throw new Error(`the product of the setup ${setupId} does not exist`);
    const url = buildRepositoryUrl(await dependencies.repositoryBaseUrl(), setup.repositoryFullName);
    return { setup, product, url };
  };

  /**
   * docs/specs/sandbox-provider-spillover.md. The sandbox provider of a setup: the rule of a run, with
   * no held slots. A setup prefers a provider with Docker, because its agent writes compose stacks.
   */
  const sandboxOf = async (
    setup: { id: string; tenantId: string },
    product: { sandboxProviderIds: string[] },
    url: string,
    /** docs/specs/sandbox-memory-and-size.md. The size the sandbox must have. */
    minimum: SandboxMinimum | null,
  ): Promise<Sandbox> => {
    if (dependencies.providerSelector === undefined || dependencies.sandbox.forProvider === undefined) return dependencies.sandbox;
    const providerId = await dependencies.providerSelector.selectForSetup({
      runId: setupSandboxRunId(setup.id),
      tenantId: setup.tenantId,
      allowedProviderIds: product.sandboxProviderIds,
      repositoryUrl: url,
      needsDocker: true,
      minimum,
    });
    return dependencies.sandbox.forProvider(providerId, minimum);
  };

  /** docs/specs/sandbox-memory-and-size.md. The `sandbox` minimum discovery stored for the repository. */
  const storedMinimumOf = async (setup: { tenantId: string; repositoryFullName: string }): Promise<SandboxMinimum | null> =>
    (await dependencies.repositories?.findByFullName(setup.tenantId, setup.repositoryFullName))?.sandboxMinimum ?? null;

  /**
   * docs/specs/host-credentials.md. The credentials of the product apply in every setup phase, as in
   * a run. A provider that cannot bind them fails the setup before it creates a sandbox.
   */
  const credentialEgressOf = async (sandbox: Sandbox, tenantId: string, productId: string, repository: string): Promise<CredentialEgress> => {
    // The setup repository may not be registered yet, and its checkout runs under the binding.
    const repositories = [repository];
    const access = dependencies.hostCredentials === undefined ? NO_HOST_CREDENTIALS : await dependencies.hostCredentials(tenantId, productId, repositories);
    assertBindable(sandbox, access);
    for (const binding of access.bindings) dependencies.redactor.addSecret(binding.value);
    return { tenantId, productId, access, store: dependencies.credentialBindings, repositories };
  };

  const createSandbox = async (
    sandbox: Sandbox,
    setupId: string,
    egress: CredentialEgress,
    allowedDomains: string[],
  ): Promise<SandboxRef> => {
    const ref = await sandbox.create({ runId: setupSandboxRunId(setupId), tenantId: egress.tenantId, productId: egress.productId });
    await attachRunnerEnvironment(dependencies.sandbox, ref, dependencies.secrets, egress.tenantId, egress.productId);
    await applyEgress(dependencies.sandbox, ref, allowedDomains, egress);
    await dependencies.sandbox.exec(ref, { file: "mkdir", args: ["-p", ref.workspacePath], cwd: "/" });
    await probeCredentialHosts(dependencies.sandbox, ref, egress.access);
    // docs/specs/sandbox-memory-and-size.md. The agent reads the peaks of its session, and the
    // report states the peaks of the proof.
    await startResourceSampler(dependencies.sandbox, ref);
    return ref;
  };

  /**
   * docs/specs/setup-speed-and-history.md. The session sandbox starts from the repository's warm
   * snapshot of the current template when one exists. A snapshot that does not restore leaves a
   * cold start. A full provider says nothing about the snapshot, so its error goes to the caller.
   */
  const startSessionSandbox = async (
    setup: { id: string; tenantId: string; productId: string; repositoryFullName: string },
    product: { sandboxProviderIds: string[] },
    url: string,
    allowedDomains: string[],
  ): Promise<{ ref: SandboxRef; warm: boolean; egress: CredentialEgress }> => {
    const sandbox = await sandboxOf(setup, product, url, await storedMinimumOf(setup));
    const egress = await credentialEgressOf(sandbox, setup.tenantId, setup.productId, setup.repositoryFullName);
    const provider = sandbox.warmSnapshots;
    const snapshot =
      provider === undefined || dependencies.warmSnapshots === undefined
        ? null
        : await dependencies.warmSnapshots.find({ tenantId: setup.tenantId, adapter: sandbox.name, repositoryUrl: url });
    if (provider !== undefined && snapshot !== null && snapshot.template === provider.template) {
      try {
        const ref = await provider.restore({ runId: setupSandboxRunId(setup.id), tenantId: setup.tenantId, productId: setup.productId }, snapshot.snapshotId);
        await attachRunnerEnvironment(dependencies.sandbox, ref, dependencies.secrets, setup.tenantId, setup.productId);
        await applyEgress(dependencies.sandbox, ref, allowedDomains, egress);
        await probeCredentialHosts(dependencies.sandbox, ref, egress.access);
        await startResourceSampler(dependencies.sandbox, ref);
        return { ref, warm: true, egress };
      } catch (error) {
        if (error instanceof SandboxSlotUnavailableError) throw error;
        dependencies.logger.warn("the warm snapshot did not restore, so the setup sandbox starts cold", {
          setup_id: setup.id,
          snapshot_id: snapshot.snapshotId,
          detail: String(error).slice(0, 500),
        });
      }
    }
    return { ref: await createSandbox(sandbox, setup.id, egress, allowedDomains), warm: false, egress };
  };

  /** The proof of one setup. proveAndPublishSetup times it. */
  const prove = async (input: { setupId: string; session: Extract<SetupSessionOutput, { kind: "proposed" }> }): Promise<SetupProofOutput> => {
      const { setup, product, url } = await load(input.setupId);
      const session = input.session;
      let config;
      try {
        config = parseFactoreeConfig(session.proposal);
      } catch (error) {
        return { status: "failed", pullRequestUrl: null, failureMessage: `The proposed config is invalid: ${error instanceof Error ? error.message : String(error)}` };
      }
      const { runtime, verifyCommands, preview } = toProjectRuntimeConfig(config, projectDefaultsOf(product));
      const readToken = await dependencies.tokens.tokenForInstallation(setup.githubInstallationId, { contents: "read" }, [setup.repositoryFullName]);
      dependencies.redactor.addSecret(readToken);
      const repositoryHosts = hostsOf(url);
      // docs/specs/sandbox-memory-and-size.md. The proof runs at the size the proposal asks for, so
      // the size it proves is the size the merge gives every later run.
      const proofSandbox = await sandboxOf(setup, product, url, sandboxMinimumOf(config));
      const egress = await credentialEgressOf(proofSandbox, setup.tenantId, setup.productId, setup.repositoryFullName);
      let ref = await createSandbox(proofSandbox, setup.id, egress, repositoryHosts);
      const parts: SetupPartResult[] = [];
      // docs/specs/run-diagnostics.md. The allow list of the phase a part ran in, for its host hints.
      let phaseAllowList: string[] = repositoryHosts;
      const failedParts: Array<{ part: SetupPartResult; allowList: string[] }> = [];
      let recordedFaults = 0;
      // docs/specs/sandbox-memory-and-size.md. The highest peaks of the proof sandboxes, and the
      // kernel kill lines already given to a part, so a later part gets only its own.
      let proofPeak: SandboxPeak | null = null;
      const seenKernelLines = new Set<string>();
      const record = (part: SetupPartResult): void => {
        const kept = { ...part, ...(part.logTail === undefined ? {} : { logTail: dependencies.redactor.redactText(withoutUrlCredentials(part.logTail)) }) };
        parts.push(kept);
        if (!kept.passed && kept.kind !== "account") failedParts.push({ part: kept, allowList: phaseAllowList });
      };
      /** docs/specs/private-stack-onboarding.md. The warm proof replaces the cold result of a part. */
      const replace = (part: SetupPartResult): void => {
        const index = parts.findIndex((entry) => entry.kind === part.kind && entry.name === part.name);
        if (index >= 0) parts.splice(index, 1);
        record(part);
      };
      // The egress log goes with each sandbox, so its faults are written before it is destroyed.
      const recordProofFaults = async (): Promise<void> => {
        const peak = await readSandboxPeak(dependencies.sandbox, ref);
        if (peak !== null) proofPeak = higherPeak(proofPeak, peak);
        for (const { part, allowList } of failedParts.splice(0)) {
          const index = recordedFaults;
          recordedFaults += 1;
          // docs/specs/sandbox-memory-and-size.md. A part the kernel killed, or that hit a full
          // disk, names the sandbox fault in its reason. A setup starts no other setup run.
          const reading = await readSandboxFault(dependencies.sandbox, ref, { exitCode: null, stoppedByFactoree: false, output: part.logTail ?? "" });
          const fault = reading.fault === null ? null : { ...reading.fault, kernelLines: reading.fault.kernelLines.filter((line) => !seenKernelLines.has(line)) };
          if (fault !== null && (fault.kind === "sandbox_disk_full" || fault.kernelLines.length > 0)) {
            for (const line of fault.kernelLines) seenKernelLines.add(line);
            const message = await reportSandboxFault({
              recorder: dependencies.events,
              sink: undefined,
              tenantId: setup.tenantId,
              productId: setup.productId,
              repositoryFullName: setup.repositoryFullName,
              subject: { setupId: setup.id },
              stage: "setup_proof",
              attempt: 1,
              step: `setup_proof:${part.kind}`,
              checkName: `the setup proof of ${part.name}`,
              command: part.kind === "bootstrap" ? (runtime.bootstrapCommand ?? "") : part.name,
              exitCode: null,
              log: part.logTail ?? null,
              fault: fault.kind === "sandbox_out_of_memory" ? { ...fault, killed: killedOf(fault.kernelLines) } : fault,
              peak,
              idempotencyKey: `setup:${setup.id}:proof:${String(index)}`,
            });
            part.reason = `${part.reason ?? "it did not pass"}. ${message}`;
            continue;
          }
          const facts = await faultEgressFacts({ sandbox: dependencies.sandbox, ref, allowList }, part.logTail ?? null);
          await recordRunEvent(dependencies.events, {
            tenantId: setup.tenantId,
            subject: { setupId: setup.id },
            stage: "setup_proof",
            attempt: 1,
            role: null,
            kind: "command_failed",
            message: withDeniedHosts(`The setup proof of ${part.name} failed: ${part.reason ?? "it did not pass"}.`, facts),
            detail: {
              step: `setup_proof:${part.kind}`,
              command: part.kind === "bootstrap" ? (runtime.bootstrapCommand ?? "") : part.name,
              exitCode: null,
              durationMs: null,
              log: part.logTail ?? null,
              ...facts,
            },
            idempotencyKey: `setup:${setup.id}:proof:${String(index)}`,
          });
        }
      };
      const applyProposal = async (path: string): Promise<void> => {
        // DI-21.20. An empty patch means the agent kept the config on the default branch. Factoree
        // proves that config as it is, and git apply refuses an empty input.
        if (session.patchBase64 === "") return;
        const apply = await dependencies.sandbox.exec(ref, {
          file: "sh",
          args: ["-c", `printf '%s' "$FACTOREE_SETUP_PATCH" | base64 -d | git apply --whitespace=nowarn`],
          cwd: path,
          env: { FACTOREE_SETUP_PATCH: session.patchBase64 },
        });
        if (apply.exitCode !== 0) throw new Error(`the setup patch did not apply: ${tail(apply.stdout, apply.stderr)}`);
      };
      /**
       * docs/specs/private-stack-onboarding.md, GitHub issue 59. The bootstrap runs as a run runs it:
       * the same script, the same environment, the same phase egress and the same timeout.
       */
      const runBootstrap = async (path: string, afterRestore: boolean): Promise<SetupPartResult> => {
        if (runtime.bootstrapCommand === null) return { kind: "bootstrap", name: "bootstrap", passed: true, reason: null };
        const result = await dependencies.sandbox.exec(ref, { file: "sh", args: ["-c", bootstrapScript(runtime.bootstrapCommand)], cwd: path, timeoutMs: BOOTSTRAP_TIMEOUT_MS });
        if (!result.timedOut && result.exitCode === 0) return { kind: "bootstrap", name: "bootstrap", passed: true, reason: null };
        const failure = result.timedOut ? `ran longer than ${String(BOOTSTRAP_TIMEOUT_MS / 60_000)} minutes` : `exited with code ${String(result.exitCode)}`;
        return {
          kind: "bootstrap",
          name: "bootstrap",
          passed: false,
          reason: afterRestore ? `The bootstrap failed after a warm restore: it ${failure}` : `the bootstrap ${failure}`,
          logTail: failureExcerpt(`${result.stdout}\n${result.stderr}`),
        };
      };
      const bootstrapAllowList = [...new Set([...repositoryHosts, ...bootstrapAllowListOf(runtime)])];
      // docs/specs/private-stack-onboarding.md. The derived hosts that the bootstrap may reach
      // must resolve and connect, so a private feed fails here with a reason, not in the bootstrap.
      const reachableDerivedHosts = [
        ...new Set(
          (setup.derivedHosts ?? [])
            .map((entry) => entry.host)
            .filter((host) => host !== "github.com" && !ECOSYSTEM_HOSTS.includes(host) && (allowListCovers(bootstrapAllowList, host) || egress.access.hosts.includes(host))),
        ),
      ].sort();
      let handle: PreviewHandle | null = null;
      let fakes: SetupReport["fakes"] = [];
      let finalPatch: { patchBase64: string; patchSha256: string; gitVersion: string; empty: boolean } | null = null;
      let snapshotId: string | null = null;
      let warmProof: SetupReport["warmProof"];
      let warmProofMs: number | null = null;
      try {
        let primary = await checkoutPrimary(dependencies.sandbox, ref, { url, ref: session.baseSha }, readToken);
        await applyProposal(primary.path);

        // Policy two: the bootstrap phase, with the repository hosts and the bootstrap allow list.
        phaseAllowList = [...bootstrapAllowList, ...egress.access.hosts];
        await applyEgress(dependencies.sandbox, ref, bootstrapAllowList, egress);
        await probeHosts(dependencies.sandbox, ref, reachableDerivedHosts, "derived host");
        const services = runtime.services ?? null;
        let servicesPassed = true;
        if (runtime.docker === true) {
          try {
            await ensureDocker(dependencies.sandbox, ref);
            if (services !== null) await startServices(dependencies.sandbox, ref, primary.path, services);
          } catch (error) {
            servicesPassed = false;
            record({ kind: "services", name: "services", passed: false, reason: "the stack did not start", logTail: String(error) });
          }
        }
        record(await runBootstrap(primary.path, false));
        const coldBootstrapPassed = parts.some((part) => part.kind === "bootstrap" && part.passed);
        if (coldBootstrapPassed && servicesPassed && services !== null) {
          try {
            await seedServices(dependencies.sandbox, ref, primary.path, services);
          } catch (error) {
            servicesPassed = false;
            record({ kind: "services", name: "services", passed: false, reason: "the seed failed", logTail: String(error) });
          }
        }
        if (runtime.docker === true && servicesPassed) {
          record({ kind: "services", name: "services", passed: true, reason: null });
          if (services !== null) fakes = await listFakes(dependencies.sandbox, ref, primary.path, services).catch(() => []);
        }

        // docs/specs/private-stack-onboarding.md. The warm proof: the rest of the proof runs in a
        // sandbox restored from a snapshot of this one, as every work sprite starts.
        const snapshots = proofSandbox.warmSnapshots;
        if (coldBootstrapPassed && servicesPassed && snapshots === undefined) warmProof = "skipped";
        if (coldBootstrapPassed && servicesPassed && snapshots !== undefined) {
          const warmStarted = Date.now();
          if (runtime.warmCommand !== null && runtime.warmCommand !== undefined) {
            const warmCommand = await dependencies.sandbox.exec(ref, { file: "sh", args: ["-c", bootstrapScript(runtime.warmCommand)], cwd: primary.path, timeoutMs: BOOTSTRAP_TIMEOUT_MS });
            if (warmCommand.timedOut || warmCommand.exitCode !== 0) {
              dependencies.logger.warn("the warm command failed in the setup proof, so the snapshot holds a partial build cache", { setup_id: setup.id, exit_code: warmCommand.exitCode });
            }
          }
          snapshotId = await snapshots.take(ref);
          await recordProofFaults();
          await dependencies.sandbox.destroy(ref).catch(() => undefined);
          ref = await snapshots.restore({ runId: setupSandboxRunId(setup.id), tenantId: setup.tenantId, productId: setup.productId }, snapshotId);
          await attachRunnerEnvironment(dependencies.sandbox, ref, dependencies.secrets, setup.tenantId, setup.productId);
          phaseAllowList = repositoryHosts;
          await applyEgress(dependencies.sandbox, ref, repositoryHosts, egress);
          await probeCredentialHosts(dependencies.sandbox, ref, egress.access);
          await startResourceSampler(dependencies.sandbox, ref);
          primary = await refreshPrimary(dependencies.sandbox, ref, { url, ref: session.baseSha }, readToken);
          await applyProposal(primary.path);
          phaseAllowList = [...bootstrapAllowList, ...egress.access.hosts];
          await applyEgress(dependencies.sandbox, ref, bootstrapAllowList, egress);
          let warmServicesPassed = true;
          if (runtime.docker === true) {
            try {
              await ensureDocker(dependencies.sandbox, ref);
              if (services !== null) await startServices(dependencies.sandbox, ref, primary.path, services);
            } catch (error) {
              warmServicesPassed = false;
              replace({ kind: "services", name: "services", passed: false, reason: "the stack did not start after a warm restore", logTail: String(error) });
            }
          }
          const warmBootstrap = await runBootstrap(primary.path, true);
          if (!warmBootstrap.passed) replace(warmBootstrap);
          warmProof = warmBootstrap.passed && warmServicesPassed ? "passed" : "failed";
          warmProofMs = Date.now() - warmStarted;
        }

        const bootstrapPassed = parts.some((part) => part.kind === "bootstrap" && part.passed);
        if (bootstrapPassed) {
          // Policy three: the agent phase, with the repository allow list alone.
          phaseAllowList = [...runtime.allowedDomains, ...egress.access.hosts];
          await applyEgress(dependencies.sandbox, ref, runtime.allowedDomains, egress);
          const environment: Record<string, string> = {};
          for (const descriptor of await dependencies.secrets.list(setup.tenantId, setup.productId)) {
            if (descriptor.kind !== "test" || !descriptor.injectIntoImplementer) continue;
            const value = await dependencies.secrets.get(setup.tenantId, setup.productId, descriptor.name);
            if (value !== null) environment[descriptor.name] = value;
          }
          const dockerLogStart = runtime.docker === true ? await dockerLogSize(dependencies.sandbox, ref).catch(() => 0) : 0;
          const verification = await runVerification({
            sandbox: dependencies.sandbox,
            ref,
            workingDirectory: primary.path,
            commands: verifyCommands,
            environment,
            timeoutMs: PROOF_COMMAND_TIMEOUT_MS,
            redactor: dependencies.redactor,
          });
          // GitHub issue 86. The verify commands reach only the product allow list, so an image a
          // test starts and the bootstrap did not pull fails to pull. dockerd is the only record.
          const pullFailures =
            runtime.docker === true && verification.checks.some((check) => !check.passed)
              ? await dockerPullFailures(dependencies.sandbox, ref, dockerLogStart)
              : [];
          const pullNote =
            pullFailures.length === 0
              ? ""
              : "Docker could not pull an image while the verify commands ran. The verify commands reach only sandbox.allowedDomains, so the bootstrap must pull each image a test starts. The dockerd log:\n" +
                `${pullFailures.join("\n")}\n\n`;
          for (const check of verification.checks) {
            record(
              check.passed
                ? { kind: "verify", name: check.name, passed: true, reason: null }
                : {
                    kind: "verify",
                    name: check.name,
                    passed: false,
                    reason: `it exited with code ${check.exitCode}${pullNote === "" ? "" : ", and Docker could not pull an image"}`,
                    logTail: `${pullNote}${failureExcerpt(check.log ?? "")}`,
                  },
            );
          }
          if (preview !== null && preview.enabled) {
            try {
              handle = await startPreview({
                sandbox: dependencies.sandbox,
                ref,
                workingDirectory: primary.path,
                preview,
                environment,
                probe: dependencies.previewProbe,
                redactor: dependencies.redactor,
              });
              record({ kind: "preview", name: "preview", passed: true, reason: null });
            } catch (error) {
              record({ kind: "preview", name: "preview", passed: false, reason: "the preview did not become ready", logTail: error instanceof PreviewStartError && error.log.length > 0 ? `${String(error)}\n\n${failureExcerpt(error.log)}` : String(error) });
            }
          }
          for (const account of runtime.accounts ?? []) {
            if (handle === null) {
              record({ kind: "account", name: account.name, passed: false, reason: "it needs the preview, which failed" });
              continue;
            }
            // Issue #44, DI-21.69. The proof signs in as a run does, with the ready wait of the config.
            const signIn = await dependencies.browser.signIn({
              baseUrl: handle.baseUrl,
              steps: signInStepsOf(account),
              timeoutMs: 60_000,
              ...(preview?.readySelector === undefined ? {} : { readySelector: preview.readySelector }),
            });
            record(
              signIn.signedIn
                ? { kind: "account", name: account.name, passed: true, reason: null }
                : { kind: "account", name: account.name, passed: false, reason: `the sign-in failed at step ${signIn.failedStep}: ${signIn.reason}` },
            );
          }
        }

        const proven = provenConfigOf(session.proposal, withPreviewDependents(parts));
        if (proven !== null) {
          await dependencies.sandbox.writeFile(ref, `${primary.path}/${CONFIG}`, proven);
          const patch = await capturePatch({ sandbox: dependencies.sandbox, redactor: dependencies.redactor }, { ref, primaryPath: primary.path, baseSha: session.baseSha });
          const outside = patch.changedFiles.filter((path) => !path.startsWith(".factoree/"));
          if (outside.length > 0) throw new Error(`the setup patch changes files outside .factoree/: ${outside.join(", ")}`);
          finalPatch = { patchBase64: patch.patchBase64, patchSha256: patch.patchSha256, gitVersion: patch.gitVersion, empty: patch.changedFiles.length === 0 };
        }
      } finally {
        if (handle !== null) await stopPreview(dependencies.sandbox, ref, handle).catch(() => undefined);
        await recordProofFaults();
        await dependencies.sandbox.destroy(ref).catch(() => undefined);
        // The warm proof snapshot serves no run: build-ahead takes the warm snapshot after the merge.
        if (snapshotId !== null && proofSandbox.warmSnapshots !== undefined) {
          const removed = await proofSandbox.warmSnapshots.remove(snapshotId).catch(() => false);
          if (!removed) dependencies.logger.warn("the warm proof snapshot was not removed", { setup_id: setup.id, snapshot_id: snapshotId });
        }
        await dependencies.setups.update(setup.id, { warmProofMs }).catch(() => undefined);
      }

      const finalParts = [...withSources(withPreviewDependents(parts), new Map(Object.entries(session.sources ?? {}))), ...(session.leftOut ?? [])];
      // docs/specs/private-stack-onboarding.md. The derived hosts that still need the operator.
      const coverage = (await dependencies.derivedHostCoverage?.(setup.tenantId, setup.productId)) ?? {
        allowedDomains: product.allowedDomains,
        credentialHosts: egress.access.hosts,
        githubRepositories: [],
      };
      const derivedHosts = uncoveredDerivedHosts(setup.derivedHosts ?? [], coverage);
      // The closures above set the peak, so the compiler cannot narrow it here.
      const measured = proofPeak as SandboxPeak | null;
      const report: SetupReport = {
        parts: finalParts,
        observedHosts: session.observedHosts,
        deniedHosts: session.deniedHosts,
        ...(session.credentialHosts === undefined || session.credentialHosts.length === 0 ? {} : { credentialHosts: session.credentialHosts }),
        egressRecorded: session.egressRecorded,
        fakes,
        appChanges: session.appChanges,
        // docs/specs/claude-code-runner.md. The proven config drops an `agents` block, and the report says so.
        agentsBlockRemoved: config.agents !== undefined,
        alreadyRequested:
          session.appChanges.length === 0 || dependencies.appChangeIssues === undefined
            ? []
            : alreadyRequested(session.appChanges, await dependencies.appChangeIssues.listForRepository(setup.tenantId, setup.repositoryFullName)),
        ...(derivedHosts.length === 0 ? {} : { derivedHosts }),
        ...(warmProof === undefined ? {} : { warmProof }),
        ...(measured === null
          ? {}
          : { resources: { peakMemoryMb: measured.memoryMb, peakDiskMb: measured.diskMb, memoryMb: measured.totalMemoryMb, diskMb: measured.totalDiskMb } }),
        ...(session.nuget === undefined ? {} : { nuget: session.nuget }),
      };
      await dependencies.setups.update(setup.id, { report });
      if (finalPatch === null) {
        const bootstrap = finalParts.find((part) => part.kind === "bootstrap" && !part.passed);
        const failure = bootstrap !== undefined
          ? warmProof === "failed" && bootstrap.reason !== null
            ? `${bootstrap.reason}, so Factoree could prove nothing.`
            : "The bootstrap failed, so Factoree could prove nothing."
          : "No verify command passed, so the config would be invalid.";
        return { status: "failed", pullRequestUrl: null, failureMessage: failure };
      }
      // DI-21.20. The proven config equals the default branch, so there is nothing to propose.
      if (finalPatch.empty) return { status: "unchanged", pullRequestUrl: null, failureMessage: null };

      const token = await dependencies.tokens.tokenForInstallation(setup.githubInstallationId, { contents: "write", pull_requests: "write" }, [setup.repositoryFullName]);
      dependencies.redactor.addSecret(token);
      const branch = setupBranchName(setup.id);
      const author = await dependencies.gitAuthor();
      await publishToBranch({
        cloneUrl: url,
        token,
        baseSha: session.baseSha,
        branch,
        baseBranch: session.defaultBranch,
        patchBase64: finalPatch.patchBase64,
        verifiedPatchSha256: finalPatch.patchSha256,
        verifiedGitVersion: finalPatch.gitVersion,
        commitMessage: `Factoree setup\n\nSetup ID: ${setup.id}\nPatch SHA-256: ${finalPatch.patchSha256}\n`,
        commitTimestamp: PUBLICATION_COMMIT_TIMESTAMP,
        authorName: author.name,
        authorEmail: author.email,
      });
      const port = dependencies.pullRequests(token);
      const existing = await port.findByHead(setup.repositoryFullName, branch, setup.githubInstallationId);
      const pullRequest =
        existing ??
        (await port.create({
          slug: setup.repositoryFullName,
          headBranch: branch,
          baseBranch: session.defaultBranch,
          draft: false,
          title: "Factoree setup",
          body: renderSetupReport(report),
        }, setup.githubInstallationId));
      const allPassed = finalParts.every((part) => part.passed);
      return { status: allPassed ? "proposed" : "partial", pullRequestUrl: pullRequest.url, failureMessage: null };
  };

  /**
   * docs/specs/setup-speed-and-history.md. Stores the setup input key, and skips the session when
   * the newest ended setup of the repository is unchanged with the same key. A setup that failed,
   * in the NuGet pre-check or anywhere else, is never a skip source.
   */
  const decide = async (
    setup: { id: string; productId: string; repositoryFullName: string; createdAt: Date },
    defaultBranch: string,
    headSha: string,
    prompt: SetupPromptInputs,
    nuget?: NugetPrecheckResult,
  ): Promise<ReadySetup> => {
    const inputKey = setupInputKeyOf(headSha, prompt, nuget?.report);
    await dependencies.setups.update(setup.id, { inputKey });

    const latest = await dependencies.setups.latestEnded(setup.productId, setup.repositoryFullName, setup.createdAt);
    const source = skipSourceOf(latest, inputKey);
    if (latest !== null && source !== null) {
      await dependencies.setups.update(setup.id, {
        status: "unchanged",
        skippedFromSetupId: source,
        ...(latest.report === null ? {} : { report: latest.report }),
        failureMessage: null,
        endedAt: new Date(),
      });
      dependencies.logger.info("the setup inputs did not change, so the setup skipped its session", { setup_id: setup.id, skipped_from: source, step: "setup_skip" });
      return { kind: "skipped" };
    }
    return {
      kind: "run",
      defaultBranch,
      headSha,
      prompt,
      ...(nuget === undefined ? {} : { nuget: nuget.report }),
      ...(nuget?.config === null || nuget?.config === undefined ? {} : { nugetConfig: nuget.config }),
    };
  };

  return {
    /**
     * docs/specs/setup-speed-and-history.md. Reads every input of the setup prompt through the
     * GitHub API and the database, stores the setup input key, and skips the session when the newest
     * ended setup of the repository is unchanged with the same key.
     */
    async prepareSetup(input: { setupId: string; temporalRunId: string }): Promise<PreparedSetup> {
      const { setup, product } = await load(input.setupId);
      await dependencies.setups.update(setup.id, { status: "running", temporalRunId: input.temporalRunId });
      const repositories = await dependencies.discoveryClient.listInstallationRepositories(setup.githubInstallationId);
      const defaultBranch = repositories.find((entry) => entry.fullName === setup.repositoryFullName)?.defaultBranch;
      if (defaultBranch === undefined) {
        return { kind: "failed", reason: `The GitHub App installation does not grant ${setup.repositoryFullName}.` };
      }
      const files = dependencies.repositoryFiles;
      const headSha = await files.headSha(setup.repositoryFullName, defaultBranch, setup.githubInstallationId);
      const existingConfig = await files.readFile(setup.repositoryFullName, CONFIG, headSha, setup.githubInstallationId);
      // docs/specs/private-stack-onboarding.md. The hosts the committed files name, before any sandbox.
      const derivedHosts = await readDerivedHosts(files, setup.repositoryFullName, headSha, setup.githubInstallationId).catch((error: unknown) => {
        dependencies.logger.warn("the derived hosts were not read", { setup_id: setup.id, error: String(error) });
        return [];
      });
      await dependencies.setups.update(setup.id, { derivedHosts });
      let repositoryInstructions: SetupPromptInputs["repositoryInstructions"] = null;
      for (const file of REPOSITORY_INSTRUCTION_FILES) {
        const text = await files.readFile(setup.repositoryFullName, file, headSha, setup.githubInstallationId);
        if (text === null) continue;
        repositoryInstructions = { file, text: capInstructions(file, text) };
        break;
      }
      // DI-21.18. The parts the last setup could not prove, so the agent tries them again, and the
      // parts it proved, so a rerun leaves them alone.
      const previous = await dependencies.setups.previousWithReport(setup.productId, setup.repositoryFullName, setup.createdAt);
      const previousParts = previous?.report?.parts ?? [];
      const testSecretNames = (await dependencies.secrets.list(setup.tenantId, setup.productId))
        .filter((secret) => secret.kind === "test")
        .map((secret) => secret.name)
        .sort();
      const requestedChanges =
        dependencies.appChangeIssues === undefined
          ? []
          : (await dependencies.appChangeIssues.listForRepository(setup.tenantId, setup.repositoryFullName))
              .filter((row) => row.outcome === null)
              .flatMap((row) => row.changes);
      // DI-21.145. The other present repositories of the product, so a fake can name the one that serves it.
      const productRepositories =
        dependencies.repositories === undefined
          ? []
          : (await dependencies.repositories.listByProduct(setup.productId))
              .filter((row) => row.tenantId === setup.tenantId && isMember(row) && row.fullName.toLowerCase() !== setup.repositoryFullName.toLowerCase())
              .map((row) => row.fullName)
              .sort();
      const prompt: SetupPromptInputs = {
        repository: setup.repositoryFullName,
        productRepositories,
        productSlug: product.slug,
        linearTeamKey: product.linearTeamKey,
        testSecretNames,
        ecosystemHosts: ECOSYSTEM_HOSTS,
        credentialHosts: (await dependencies.credentialHosts?.(setup.tenantId, setup.productId)) ?? [],
        existingConfig,
        previousNotProven: previousParts.filter((part) => !part.passed).map((part) => ({ kind: part.kind, name: part.name, reason: part.reason })),
        previousProven: previousParts.filter((part) => part.passed).map((part) => ({ kind: part.kind, name: part.name })),
        requestedChanges,
        repositoryInstructions,
        // docs/specs/sandbox-memory-and-size.md. A setup a sandbox fault started repairs that fault.
        sandboxFault: setup.sandboxFault,
      };
      // docs/specs/nuget-private-feed-mapping.md. A NuGet feed that no sandbox reaches as it is
      // waits for the pre-check, which reads the mirror and decides the key.
      const nugetConfigs = await readNugetConfigFiles(files, setup.repositoryFullName, headSha, setup.githubInstallationId).catch((error: unknown) => {
        dependencies.logger.warn("the NuGet configs were not read", { setup_id: setup.id, error: String(error) });
        return [];
      });
      const nugetFeeds = classifyNugetFeeds(nugetConfigs, { credentialHosts: prompt.credentialHosts ?? [], allowedDomains: product.allowedDomains });
      if (needsNugetPrecheck(nugetFeeds)) return { kind: "precheck", defaultBranch, headSha, prompt };
      return await decide(setup, defaultBranch, headSha, prompt);
    },

    /**
     * docs/specs/nuget-private-feed-mapping.md. The NuGet pre-check, in a sandbox before the agent
     * session: the mirror requests run inside it, where the provider adds the credential, so no
     * secret reaches the worker, a prompt or a file. A failure fails the whole setup with its
     * evidence, starts no session and creates no app-change issue. A pass decides the key and the
     * skip, and gives the session the file Factoree wrote.
     */
    async precheckNugetFeeds(input: { setupId: string; prepared: Extract<PreparedSetup, { kind: "precheck" }> }): Promise<ReadySetup> {
      const { setup, product, url } = await load(input.setupId);
      const { defaultBranch, headSha, prompt } = input.prepared;
      const started = Date.now();
      const token = await dependencies.tokens.tokenForInstallation(setup.githubInstallationId, { contents: "read" }, [setup.repositoryFullName]);
      dependencies.redactor.addSecret(token);
      const hosts = [...new Set([...hostsOf(url), ...ECOSYSTEM_HOSTS, ...product.allowedDomains])];
      const { ref, warm, egress } = await startSessionSandbox(setup, product, url, hosts);
      let result: NugetPrecheckResult;
      try {
        const primary = warm
          ? await refreshPrimary(dependencies.sandbox, ref, { url, ref: headSha }, token)
          : await checkoutPrimary(dependencies.sandbox, ref, { url, ref: headSha }, token);
        result = await runNugetPrecheck({
          sandbox: dependencies.sandbox,
          ref,
          repositoryPath: primary.path,
          credentials: egress.access.credentials,
          coverage: { credentialHosts: egress.access.hosts, allowedDomains: product.allowedDomains },
          egressHosts: [...hosts, ...egress.access.hosts],
        });
      } finally {
        await dependencies.sandbox.destroy(ref).catch(() => undefined);
      }
      const redact = (text: string): string => dependencies.redactor.redactText(withoutUrlCredentials(text));
      const report: NugetPrecheckReport = {
        ...result.report,
        feeds: result.report.feeds.map((feed) => ({ ...feed, url: withoutUrlCredentials(feed.url) })),
        restore: { ...result.report.restore, detail: result.report.restore.detail === null ? null : redact(result.report.restore.detail) },
        failure: result.report.failure === null ? null : redact(result.report.failure),
      };
      if (report.outcome === "failed") {
        const failure = report.failure ?? "The NuGet pre-check failed.";
        await recordRunEvent(dependencies.events, {
          tenantId: setup.tenantId,
          subject: { setupId: setup.id },
          stage: "setup",
          attempt: 1,
          role: null,
          kind: "command_failed",
          message: failure.split("\n")[0] ?? failure,
          detail: {
            step: "setup_precheck:nuget",
            command: "the NuGet pre-check",
            exitCode: null,
            durationMs: Date.now() - started,
            log: failure,
            egress: "not_recorded",
            deniedHosts: [],
            hostHints: [],
          },
          idempotencyKey: `setup:${setup.id}:precheck:nuget`,
        });
        // DI-21.229. The report keeps the parts of the setup before it, so the next setup still
        // names what is unproven (DI-21.18). A failed pre-check renders only its own evidence.
        const previous = await dependencies.setups.previousWithReport(setup.productId, setup.repositoryFullName, setup.createdAt);
        await dependencies.setups.update(setup.id, {
          inputKey: setupInputKeyOf(headSha, prompt, report),
          report: { parts: previous?.report?.parts ?? [], observedHosts: [], deniedHosts: [], egressRecorded: false, fakes: [], appChanges: [], nuget: report },
        });
        dependencies.logger.warn("the NuGet pre-check failed, so the setup starts no session", { setup_id: setup.id, step: "setup_precheck" });
        return { kind: "failed", reason: failure };
      }
      const facts = nugetPromptFactsOf(report);
      return await decide(setup, defaultBranch, headSha, facts === null ? prompt : { ...prompt, nugetFeed: facts }, { report, config: result.config });
    },

    /**
     * docs/specs/repository-setup-and-services.md. The setup agent reads the repository and writes
     * `.factoree/`. The sandbox reaches the repository, the ecosystem host list and the product
     * allow list, which holds the model API. docs/specs/setup-speed-and-history.md: the sandbox
     * starts from the warm snapshot when one exists, and the prompt is the one the key holds.
     */
    async runSetupSession(input: { setupId: string; prepared: Extract<ReadySetup, { kind: "run" }> }): Promise<SetupSessionOutput> {
      const { setup, product, url } = await load(input.setupId);
      const { defaultBranch, headSha, prompt } = input.prepared;
      await registerProjectSecrets(dependencies.redactor, dependencies.secrets, setup.tenantId, setup.productId, dependencies.logger);
      const token = await dependencies.tokens.tokenForInstallation(setup.githubInstallationId, { contents: "read" }, [setup.repositoryFullName]);
      dependencies.redactor.addSecret(token);

      // docs/specs/claude-code-runner.md. The Product selects the setup runner. A claude setup
      // needs an Anthropic credential, and its sandbox reaches the model host.
      const runnerName = resolveRole(product, "setup").runner;
      const runnerEnvironment = await loadRunnerEnvironment(dependencies.secrets, setup.tenantId, setup.productId);
      if (runnerName === "claude" && !hasClaudeCredential(runnerEnvironment)) {
        return {
          kind: "failed",
          reason: `The Product runs the setup agent on Claude Code, and it holds no Anthropic credential. Add ${CLAUDE_CREDENTIAL_NAMES.join(" or ")} as a runner credential on the product page.`,
        };
      }
      const claudeHost = runnerName === "claude" ? claudeApiHostOf(runnerEnvironment) : null;
      const sessionHosts = [
        ...new Set([...hostsOf(url), ...ECOSYSTEM_HOSTS, ...product.allowedDomains, ...(claudeHost === null ? [] : [claudeHost])]),
      ];
      const { ref, warm, egress } = await startSessionSandbox(setup, product, url, sessionHosts);
      await dependencies.setups.update(setup.id, { warm });
      const started = Date.now();
      try {
        const primary = warm
          ? await refreshPrimary(dependencies.sandbox, ref, { url, ref: headSha }, token)
          : await checkoutPrimary(dependencies.sandbox, ref, { url, ref: headSha }, token);
        // The agent may start the stack itself to try it. A provider without Docker runs none.
        // The capabilities of the provider that runs this sandbox, which the ref names.
        const owner = dependencies.sandbox.forProvider === undefined ? dependencies.sandbox : await dependencies.sandbox.forProvider(ref.adapter);
        if (owner.capabilities.supportsDocker) {
          await ensureDocker(dependencies.sandbox, ref).catch((error: unknown) =>
            dependencies.logger.warn("rootless Docker did not start in the setup sandbox", { setup_id: setup.id, error: String(error) }),
          );
        }
        // docs/specs/nuget-private-feed-mapping.md. The file the pre-check wrote, given to the agent as it is.
        const nugetConfig = input.prepared.nugetConfig;
        if (nugetConfig !== undefined) {
          await dependencies.sandbox.exec(ref, { file: "mkdir", args: ["-p", `${primary.path}/.factoree`], cwd: "/" });
          await dependencies.sandbox.writeFile(ref, `${primary.path}/${FACTOREE_NUGET_CONFIG}`, nugetConfig);
        }
        const appChangesPath = `${ref.workspacePath}/setup-app-changes.txt`;
        const sourcesPath = `${ref.workspacePath}/setup-sources.txt`;
        const leftOutPath = `${ref.workspacePath}/setup-left-out.txt`;
        const runner = dependencies.runners.get(runnerName);
        const startSession = (timeoutMs: number) => runner.run({
          runId: setupSandboxRunId(setup.id),
          tenantId: setup.tenantId,
          role: "setup",
          sandbox: dependencies.sandbox,
          ref,
          workingDirectory: primary.path,
          repositoryPath: primary.path,
          prompt: renderSetupPrompt({ ...prompt, primaryRepositoryPath: primary.path, appChangesPath, sourcesPath, leftOutPath }),
          promptVersion: SETUP_PROMPT_VERSION,
          environment: {},
          actionPolicy: buildActionPolicy({ role: "setup" }),
          timeoutMs,
        });
        const results: Array<Awaited<ReturnType<typeof startSession>>> = [];
        try {
          results.push(await startSession(SETUP_SESSION_TIMEOUT_MS));
          // GitHub issue 84, docs/specs/agent-session-usage-and-hangs.md. A hung session gets one
          // fresh session more, in the same sandbox, with the rest of the session budget.
          const left = SETUP_SESSION_TIMEOUT_MS - (Date.now() - started);
          if (results[0]?.outcome === "hung" && left >= SETUP_HANG_RETRY_MIN_MS) {
            dependencies.logger.warn("the setup agent session hung, so Factoree starts it once more", { setup_id: setup.id });
            results.push(await startSession(left));
          }
        } catch (error) {
          // docs/specs/run-diagnostics.md. A runner that cannot start the session names why.
          const message = error instanceof Error ? error.message : String(error);
          await recordRunEvent(dependencies.events, {
            tenantId: setup.tenantId,
            subject: { setupId: setup.id },
            stage: "setup",
            attempt: 1,
            role: "setup",
            kind: "session_failed",
            message: `The setup agent session did not start: ${message}`,
            detail: { runner: runnerName, model: null, exitCode: null, summary: message, log: null, egress: "not_recorded", deniedHosts: [], hostHints: [] },
            idempotencyKey: `setup:${setup.id}:session:start`,
          });
          throw error;
        }
        const result = results.at(-1)!;
        /** The sum of one usage field over every session, or null when no session reports it. */
        const total = (field: (entry: (typeof results)[number]) => number | null | undefined): number | null => {
          const values = results.map(field).filter((value): value is number => value !== null && value !== undefined);
          return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
        };
        const longest = (field: (entry: (typeof results)[number]) => number | null | undefined): number | null => {
          const values = results.map(field).filter((value): value is number => value !== null && value !== undefined);
          return values.length === 0 ? null : Math.max(...values);
        };
        const usage: SetupSessionUsage = {
          runner: runnerName,
          model: result.model ?? null,
          effort: result.effort ?? null,
          outcome: result.outcome,
          durationMs: Date.now() - started,
          tokens: total((entry) =>
            entry.usage === null ? null : (entry.usage.inputTokens ?? 0) + (entry.usage.outputTokens ?? 0) + (entry.usage.reasoningTokens ?? 0),
          ),
          costUsd: total((entry) => entry.usage?.costUsd),
          turns: total((entry) => entry.usage?.turns),
          longestTurnMs: longest((entry) => entry.usage?.longestTurnMs),
          modelMs: total((entry) => entry.usage?.modelMs),
          toolMs: total((entry) => entry.usage?.toolMs),
        };
        await dependencies.setups.update(setup.id, { sessionUsage: usage });
        await recordSessionFaults(
          dependencies.events,
          {
            tenantId: setup.tenantId,
            runId: setupSandboxRunId(setup.id),
            setupId: setup.id,
            role: "setup",
            attempt: 1,
            runner: runnerName,
            idempotencyKey: `setup:${setup.id}:session`,
            egress: { sandbox: dependencies.sandbox, ref, allowList: [...sessionHosts, ...egress.access.hosts] },
          },
          results,
        );

        const outside = (await changedPaths(dependencies.sandbox, ref, primary.path)).filter((path) => !path.startsWith(".factoree/"));
        if (outside.length > 0) {
          return {
            kind: "failed",
            reason: `The setup agent changed files outside .factoree/, so Factoree refused the setup: ${outside.slice(0, 20).join(", ")}.`,
          };
        }
        const proposalText = await readText(dependencies.sandbox, ref, `${primary.path}/${CONFIG}`);
        if (proposalText === null) {
          // GitHub issue 37. A session that did not finish names its own error, redacted by the
          // runner, as a Run does. Without it the reason hides a model or a credential fault.
          if (!result.completed) {
            dependencies.logger.warn("the setup agent session did not finish", {
              setup_id: setup.id,
              outcome: result.outcome,
              exit_code: result.exitCode,
              summary: result.summary,
            });
          }
          const cause = result.completed || result.summary.trim() === "" ? "" : ` The agent session ${result.outcome === "hung" ? "hung" : "failed"}: ${result.summary.trim().slice(0, 1_000)}`;
          return { kind: "failed", reason: `The setup agent wrote no .factoree/config.yaml.${cause}` };
        }

        // The bootstrap allow list is what the sandbox reached inside the ecosystem host list. A
        // provider that records no egress gets the whole list.
        const log = dependencies.sandbox.egressLog === undefined ? null : await dependencies.sandbox.egressLog(ref);
        const reached = log === null ? [...ECOSYSTEM_HOSTS] : [...new Set(log.filter((record) => record.decision === "allowed").map((record) => record.host))];
        // docs/specs/setup-speed-and-history.md. A warm sandbox already holds the packages, so it
        // reaches fewer hosts than a cold bootstrap needs. The existing allow list stays.
        if (warm) reached.push(...existingBootstrapHosts(prompt.existingConfig));
        const bootstrapHosts = narrowAllowList(reached.length === 0 ? ["none.invalid"] : reached, [...ECOSYSTEM_HOSTS]).sort();
        // DI-21.20. A name with no dot is a local lookup, such as the sandbox's own hostname or a
        // compose service, never a host the allow list could name.
        const deniedHosts =
          log === null ? [] : [...new Set(log.filter((record) => record.decision === "denied" && record.host.includes(".")).map((record) => record.host))].sort();
        // docs/specs/host-credentials.md. Factoree adds the credential hosts in every phase, so they
        // stay out of the config, and the report lists the ones the session reached.
        const credentialHosts = new Set(egress.access.hosts);
        const credentialHostsReached = log === null ? [] : [...new Set(reached.filter((host) => credentialHosts.has(host)))].sort();
        const document = parseDocument(proposalText);
        if (document.get("bootstrap") !== undefined) document.setIn(["bootstrap", "allowedDomains"], bootstrapHosts);
        const proposal = document.toString();
        await dependencies.sandbox.writeFile(ref, `${primary.path}/${CONFIG}`, proposal);
        // Factoree's file wins over any change the agent made to it.
        if (nugetConfig !== undefined) await dependencies.sandbox.writeFile(ref, `${primary.path}/${FACTOREE_NUGET_CONFIG}`, nugetConfig);

        const appChanges = ((await readText(dependencies.sandbox, ref, appChangesPath)) ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "");
        const sources = Object.fromEntries(parseSetupSources(dependencies.redactor.redactText((await readText(dependencies.sandbox, ref, sourcesPath)) ?? "")));
        const leftOut = parseLeftOutStacks(dependencies.redactor.redactText(withoutUrlCredentials((await readText(dependencies.sandbox, ref, leftOutPath)) ?? "")));
        const patch = await capturePatch({ sandbox: dependencies.sandbox, redactor: dependencies.redactor }, { ref, primaryPath: primary.path, baseSha: primary.baseSha });
        return {
          kind: "proposed",
          sources,
          defaultBranch,
          baseSha: primary.baseSha,
          patchBase64: patch.patchBase64,
          proposal,
          observedHosts: bootstrapHosts,
          deniedHosts,
          credentialHosts: credentialHostsReached,
          egressRecorded: log !== null,
          appChanges,
          warm,
          ...(leftOut.length === 0 ? {} : { leftOut }),
          ...(input.prepared.nuget === undefined ? {} : { nuget: input.prepared.nuget }),
        };
      } finally {
        await dependencies.sandbox.destroy(ref).catch(() => undefined);
      }
    },

    /**
     * docs/specs/repository-setup-and-services.md. Proves each part in a fresh sandbox with only
     * the proposed allow list, keeps the parts that passed, and opens the pull request.
     * docs/specs/setup-speed-and-history.md: the setup row records the proof time.
     */
    async proveAndPublishSetup(input: { setupId: string; session: Extract<SetupSessionOutput, { kind: "proposed" }> }): Promise<SetupProofOutput> {
      const started = Date.now();
      try {
        return await prove(input);
      } finally {
        await dependencies.setups.update(input.setupId, { proofMs: Date.now() - started }).catch(() => undefined);
      }
    },

    /** Records how a setup ended. */
    async finishSetup(input: { setupId: string; status: RepositorySetupStatus; pullRequestUrl: string | null; failureMessage: string | null }): Promise<void> {
      await dependencies.setups.update(input.setupId, {
        status: input.status,
        pullRequestUrl: input.pullRequestUrl,
        failureMessage: input.failureMessage === null ? null : dependencies.redactor.redactText(input.failureMessage),
        endedAt: new Date(),
      });
    },
  };
};
