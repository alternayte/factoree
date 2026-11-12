import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import type { RepositoryDiscoveryClient, RepositoryFileReader } from "~/adapters/github/repository-discovery-client.js";
import { parseFactoreeConfig } from "~/domain/products/factoree-config.js";
import type { SandboxProviderSelector } from "~/domain/runs/provider-selection.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
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
import { narrowAllowList, type Sandbox, type SandboxRef } from "~/domain/runs/sandbox.js";
import { ensureDocker, listFakes, seedServices, startServices } from "~/domain/runs/services.js";
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
import { failureExcerpt, provenConfigOf, renderSetupReport, withPreviewDependents, type SetupPartResult, type SetupReport } from "~/domain/setup/setup-report.js";
import type { BrowserDriver } from "~/domain/validation/browser-driver.js";
import { signInStepsOf } from "~/domain/validation/user-validator.js";
import { renderSetupPrompt, SETUP_PROMPT_VERSION, type SetupPromptFields } from "~/prompts/setup.js";
import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { PUBLICATION_COMMIT_TIMESTAMP } from "./publishing.activities.js";

export interface SetupActivityDependencies {
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
}

/** docs/specs/setup-speed-and-history.md. The prompt fields that hold no sandbox path. */
export type SetupPromptInputs = Omit<SetupPromptFields, "primaryRepositoryPath" | "appChangesPath">;

/** docs/specs/setup-speed-and-history.md. What a setup does after its inputs are read. */
export type PreparedSetup =
  | { kind: "run"; defaultBranch: string; headSha: string; prompt: SetupPromptInputs }
  | { kind: "skipped" }
  | { kind: "failed"; reason: string };

/**
 * docs/specs/setup-speed-and-history.md. The setup input key: the SHA-256 of the head SHA and the
 * rendered setup prompt, with fixed text where the sandbox paths go.
 */
export const setupInputKeyOf = (headSha: string, prompt: SetupPromptInputs): string =>
  createHash("sha256")
    .update(JSON.stringify({ headSha, prompt: renderSetupPrompt({ ...prompt, primaryRepositoryPath: "<repository>", appChangesPath: "<app changes file>" }) }))
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
      egressRecorded: boolean;
      appChanges: string[];
      /** docs/specs/setup-speed-and-history.md. The session sandbox started from the warm snapshot. */
      warm: boolean;
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
  ): Promise<Sandbox> => {
    if (dependencies.providerSelector === undefined || dependencies.sandbox.forProvider === undefined) return dependencies.sandbox;
    const providerId = await dependencies.providerSelector.selectForSetup({
      runId: setupSandboxRunId(setup.id),
      tenantId: setup.tenantId,
      allowedProviderIds: product.sandboxProviderIds,
      repositoryUrl: url,
      needsDocker: true,
    });
    return dependencies.sandbox.forProvider(providerId);
  };

  const createSandbox = async (
    sandbox: Sandbox,
    setupId: string,
    tenantId: string,
    productId: string,
    allowedDomains: string[],
  ): Promise<SandboxRef> => {
    const ref = await sandbox.create({ runId: setupSandboxRunId(setupId), tenantId, productId });
    await attachRunnerEnvironment(dependencies.sandbox, ref, dependencies.secrets, tenantId, productId);
    await dependencies.sandbox.applyNetworkPolicy(ref, { allowedDomains });
    await dependencies.sandbox.exec(ref, { file: "mkdir", args: ["-p", ref.workspacePath], cwd: "/" });
    return ref;
  };

  /**
   * docs/specs/setup-speed-and-history.md. The session sandbox starts from the repository's warm
   * snapshot of the current template when one exists. A snapshot that does not restore leaves a
   * cold start. A full provider says nothing about the snapshot, so its error goes to the caller.
   */
  const startSessionSandbox = async (
    setup: { id: string; tenantId: string; productId: string },
    product: { sandboxProviderIds: string[] },
    url: string,
    allowedDomains: string[],
  ): Promise<{ ref: SandboxRef; warm: boolean }> => {
    const sandbox = await sandboxOf(setup, product, url);
    const provider = sandbox.warmSnapshots;
    const snapshot =
      provider === undefined || dependencies.warmSnapshots === undefined
        ? null
        : await dependencies.warmSnapshots.find({ tenantId: setup.tenantId, adapter: sandbox.name, repositoryUrl: url });
    if (provider !== undefined && snapshot !== null && snapshot.template === provider.template) {
      try {
        const ref = await provider.restore({ runId: setupSandboxRunId(setup.id), tenantId: setup.tenantId, productId: setup.productId }, snapshot.snapshotId);
        await attachRunnerEnvironment(dependencies.sandbox, ref, dependencies.secrets, setup.tenantId, setup.productId);
        await dependencies.sandbox.applyNetworkPolicy(ref, { allowedDomains });
        return { ref, warm: true };
      } catch (error) {
        if (error instanceof SandboxSlotUnavailableError) throw error;
        dependencies.logger.warn("the warm snapshot did not restore, so the setup sandbox starts cold", {
          setup_id: setup.id,
          snapshot_id: snapshot.snapshotId,
          detail: String(error).slice(0, 500),
        });
      }
    }
    return { ref: await createSandbox(sandbox, setup.id, setup.tenantId, setup.productId, allowedDomains), warm: false };
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
      const ref = await createSandbox(await sandboxOf(setup, product, url), setup.id, setup.tenantId, setup.productId, repositoryHosts);
      const parts: SetupPartResult[] = [];
      const record = (part: SetupPartResult): void => {
        parts.push({ ...part, ...(part.logTail === undefined ? {} : { logTail: dependencies.redactor.redactText(withoutUrlCredentials(part.logTail)) }) });
      };
      let handle: PreviewHandle | null = null;
      let fakes: SetupReport["fakes"] = [];
      let finalPatch: { patchBase64: string; patchSha256: string; gitVersion: string; empty: boolean } | null = null;
      try {
        const primary = await checkoutPrimary(dependencies.sandbox, ref, { url, ref: session.baseSha }, readToken);
        // DI-21.20. An empty patch means the agent kept the config on the default branch. Factoree
        // proves that config as it is, and git apply refuses an empty input.
        if (session.patchBase64 !== "") {
          const apply = await dependencies.sandbox.exec(ref, {
            file: "sh",
            args: ["-c", `printf '%s' "$FACTOREE_SETUP_PATCH" | base64 -d | git apply --whitespace=nowarn`],
            cwd: primary.path,
            env: { FACTOREE_SETUP_PATCH: session.patchBase64 },
          });
          if (apply.exitCode !== 0) throw new Error(`the setup patch did not apply: ${tail(apply.stdout, apply.stderr)}`);
        }

        // Policy two: the bootstrap phase, with the repository hosts and the bootstrap allow list.
        await dependencies.sandbox.applyNetworkPolicy(ref, { allowedDomains: [...new Set([...repositoryHosts, ...bootstrapAllowListOf(runtime)])] });
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
        if (runtime.bootstrapCommand !== null) {
          const bootstrap = await dependencies.sandbox.exec(ref, { file: "sh", args: ["-c", runtime.bootstrapCommand], cwd: primary.path, timeoutMs: PROOF_COMMAND_TIMEOUT_MS });
          record(
            bootstrap.exitCode === 0
              ? { kind: "bootstrap", name: "bootstrap", passed: true, reason: null }
              : { kind: "bootstrap", name: "bootstrap", passed: false, reason: `the bootstrap exited with code ${bootstrap.exitCode}`, logTail: failureExcerpt(`${bootstrap.stdout}\n${bootstrap.stderr}`) },
          );
        } else {
          record({ kind: "bootstrap", name: "bootstrap", passed: true, reason: null });
        }
        const bootstrapPassed = parts.some((part) => part.kind === "bootstrap" && part.passed);
        if (bootstrapPassed && servicesPassed && services !== null) {
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

        if (bootstrapPassed) {
          // Policy three: the agent phase, with the repository allow list alone.
          await dependencies.sandbox.applyNetworkPolicy(ref, { allowedDomains: runtime.allowedDomains });
          const environment: Record<string, string> = {};
          for (const descriptor of await dependencies.secrets.list(setup.tenantId, setup.productId)) {
            if (descriptor.kind !== "test" || !descriptor.injectIntoImplementer) continue;
            const value = await dependencies.secrets.get(setup.tenantId, setup.productId, descriptor.name);
            if (value !== null) environment[descriptor.name] = value;
          }
          const verification = await runVerification({
            sandbox: dependencies.sandbox,
            ref,
            workingDirectory: primary.path,
            commands: verifyCommands,
            environment,
            timeoutMs: PROOF_COMMAND_TIMEOUT_MS,
            redactor: dependencies.redactor,
          });
          for (const check of verification.checks) {
            record(
              check.passed
                ? { kind: "verify", name: check.name, passed: true, reason: null }
                : { kind: "verify", name: check.name, passed: false, reason: `it exited with code ${check.exitCode}`, logTail: failureExcerpt(check.log ?? "") },
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
            const signIn = await dependencies.browser.signIn({ baseUrl: handle.baseUrl, steps: signInStepsOf(account), timeoutMs: 60_000 });
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
        await dependencies.sandbox.destroy(ref).catch(() => undefined);
      }

      const finalParts = withPreviewDependents(parts);
      const report: SetupReport = {
        parts: finalParts,
        observedHosts: session.observedHosts,
        deniedHosts: session.deniedHosts,
        egressRecorded: session.egressRecorded,
        fakes,
        appChanges: session.appChanges,
        // docs/specs/claude-code-runner.md. The proven config drops an `agents` block, and the report says so.
        agentsBlockRemoved: config.agents !== undefined,
        alreadyRequested:
          session.appChanges.length === 0 || dependencies.appChangeIssues === undefined
            ? []
            : alreadyRequested(session.appChanges, await dependencies.appChangeIssues.listForRepository(setup.tenantId, setup.repositoryFullName)),
      };
      await dependencies.setups.update(setup.id, { report });
      if (finalPatch === null) {
        const failure = finalParts.find((part) => part.kind === "bootstrap" && !part.passed)
          ? "The bootstrap failed, so Factoree could prove nothing."
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
      const prompt: SetupPromptInputs = {
        repository: setup.repositoryFullName,
        productSlug: product.slug,
        linearTeamKey: product.linearTeamKey,
        testSecretNames,
        ecosystemHosts: ECOSYSTEM_HOSTS,
        existingConfig,
        previousNotProven: previousParts.filter((part) => !part.passed).map((part) => ({ kind: part.kind, name: part.name, reason: part.reason })),
        previousProven: previousParts.filter((part) => part.passed).map((part) => ({ kind: part.kind, name: part.name })),
        requestedChanges,
        repositoryInstructions,
      };
      const inputKey = setupInputKeyOf(headSha, prompt);
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
      return { kind: "run", defaultBranch, headSha, prompt };
    },

    /**
     * docs/specs/repository-setup-and-services.md. The setup agent reads the repository and writes
     * `.factoree/`. The sandbox reaches the repository, the ecosystem host list and the product
     * allow list, which holds the model API. docs/specs/setup-speed-and-history.md: the sandbox
     * starts from the warm snapshot when one exists, and the prompt is the one the key holds.
     */
    async runSetupSession(input: { setupId: string; prepared: Extract<PreparedSetup, { kind: "run" }> }): Promise<SetupSessionOutput> {
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
      const { ref, warm } = await startSessionSandbox(setup, product, url, [
        ...new Set([...hostsOf(url), ...ECOSYSTEM_HOSTS, ...product.allowedDomains, ...(claudeHost === null ? [] : [claudeHost])]),
      ]);
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
        const appChangesPath = `${ref.workspacePath}/setup-app-changes.txt`;
        const runner = dependencies.runners.get(runnerName);
        const result = await runner.run({
          runId: setupSandboxRunId(setup.id),
          tenantId: setup.tenantId,
          role: "setup",
          sandbox: dependencies.sandbox,
          ref,
          workingDirectory: primary.path,
          repositoryPath: primary.path,
          prompt: renderSetupPrompt({ ...prompt, primaryRepositoryPath: primary.path, appChangesPath }),
          promptVersion: SETUP_PROMPT_VERSION,
          environment: {},
          actionPolicy: buildActionPolicy({ role: "setup" }),
          timeoutMs: SETUP_SESSION_TIMEOUT_MS,
        });
        const usage: SetupSessionUsage = {
          runner: runnerName,
          model: result.model ?? null,
          effort: result.effort ?? null,
          outcome: result.outcome,
          durationMs: Date.now() - started,
          tokens:
            result.usage === null
              ? null
              : (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0) + (result.usage.reasoningTokens ?? 0),
          costUsd: result.usage?.costUsd ?? null,
          turns: result.usage?.turns ?? null,
          longestTurnMs: result.usage?.longestTurnMs ?? null,
          modelMs: result.usage?.modelMs ?? null,
          toolMs: result.usage?.toolMs ?? null,
        };
        await dependencies.setups.update(setup.id, { sessionUsage: usage });

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
        const document = parseDocument(proposalText);
        if (document.get("bootstrap") !== undefined) document.setIn(["bootstrap", "allowedDomains"], bootstrapHosts);
        const proposal = document.toString();
        await dependencies.sandbox.writeFile(ref, `${primary.path}/${CONFIG}`, proposal);

        const appChanges = ((await readText(dependencies.sandbox, ref, appChangesPath)) ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "");
        const patch = await capturePatch({ sandbox: dependencies.sandbox, redactor: dependencies.redactor }, { ref, primaryPath: primary.path, baseSha: primary.baseSha });
        return {
          kind: "proposed",
          defaultBranch,
          baseSha: primary.baseSha,
          patchBase64: patch.patchBase64,
          proposal,
          observedHosts: bootstrapHosts,
          deniedHosts,
          egressRecorded: log !== null,
          appChanges,
          warm,
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
