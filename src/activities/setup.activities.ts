import { parseDocument } from "yaml";
import type { RepositoryDiscoveryClient } from "~/adapters/github/repository-discovery-client.js";
import { parseFactoreeConfig } from "~/domain/products/factoree-config.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import { registerProjectSecrets } from "~/domain/products/redaction-loader.js";
import { buildRepositoryUrl } from "~/domain/products/repository-url.js";
import { attachRunnerEnvironment } from "~/domain/products/runner-credentials.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import type { GitHubTokenProvider } from "~/domain/products/github-token-provider.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { capturePatch } from "~/domain/publishing/patch.js";
import type { PullRequestPort } from "~/domain/publishing/pull-request.js";
import { publishToBranch } from "~/domain/publishing/trusted-checkout.js";
import type { AgentRunnerRegistry } from "~/domain/runs/agent-runner.js";
import { projectDefaultsOf } from "~/domain/runs/build-ahead.js";
import { checkoutPrimary, withoutUrlCredentials } from "~/domain/runs/checkout.js";
import { PreviewStartError, startPreview, stopPreview, type PreviewHandle, type ReadinessProbe } from "~/domain/runs/preview.js";
import { bootstrapAllowListOf, DEFAULT_PROJECT_RUNTIME_CONFIG, toProjectRuntimeConfig } from "~/domain/runs/project-runtime-config.js";
import { narrowAllowList, type Sandbox, type SandboxRef } from "~/domain/runs/sandbox.js";
import { ensureDocker, listFakes, seedServices, startServices } from "~/domain/runs/services.js";
import { runVerification } from "~/domain/runs/verification.js";
import { alreadyRequested, type AppChangeIssueStore } from "~/domain/setup/app-change-issues.js";
import { ECOSYSTEM_HOSTS } from "~/domain/setup/ecosystem-hosts.js";
import {
  setupBranchName,
  setupSandboxRunId,
  type RepositorySetupStore,
  type RepositorySetupStatus,
  type SetupSessionUsage,
} from "~/domain/setup/repository-setup.js";
import { failureExcerpt, provenConfigOf, renderSetupReport, withPreviewDependents, type SetupPartResult, type SetupReport } from "~/domain/setup/setup-report.js";
import type { BrowserDriver } from "~/domain/validation/browser-driver.js";
import { signInStepsOf } from "~/domain/validation/user-validator.js";
import { renderSetupPrompt, SETUP_PROMPT_VERSION } from "~/prompts/setup.js";
import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";
import { PUBLICATION_COMMIT_TIMESTAMP } from "./publishing.activities.js";

export interface SetupActivityDependencies {
  setups: RepositorySetupStore;
  products: Pick<ProductRegistry, "findById">;
  sandbox: Sandbox;
  runners: AgentRunnerRegistry;
  secrets: SecretStore;
  tokens: GitHubTokenProvider;
  discoveryClient: Pick<RepositoryDiscoveryClient, "listInstallationRepositories">;
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
    }
  | { kind: "failed"; reason: string };

export interface SetupProofOutput {
  status: Extract<RepositorySetupStatus, "proposed" | "partial" | "failed">;
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

  const createSandbox = async (setupId: string, tenantId: string, productId: string, allowedDomains: string[]): Promise<SandboxRef> => {
    const ref = await dependencies.sandbox.create({ runId: setupSandboxRunId(setupId), tenantId, productId });
    await attachRunnerEnvironment(dependencies.sandbox, ref, dependencies.secrets, tenantId, productId);
    await dependencies.sandbox.applyNetworkPolicy(ref, { allowedDomains });
    await dependencies.sandbox.exec(ref, { file: "mkdir", args: ["-p", ref.workspacePath], cwd: "/" });
    return ref;
  };

  return {
    /**
     * docs/specs/repository-setup-and-services.md. The setup agent reads the repository and writes
     * `.factoree/`. The sandbox reaches the repository, the ecosystem host list and the product
     * allow list, which holds the model API.
     */
    async runSetupSession(input: { setupId: string }): Promise<SetupSessionOutput> {
      const { setup, product, url } = await load(input.setupId);
      await dependencies.setups.update(setup.id, { status: "running" });
      await registerProjectSecrets(dependencies.redactor, dependencies.secrets, setup.tenantId, setup.productId, dependencies.logger);
      const repositories = await dependencies.discoveryClient.listInstallationRepositories(setup.githubInstallationId);
      const defaultBranch = repositories.find((entry) => entry.fullName === setup.repositoryFullName)?.defaultBranch;
      if (defaultBranch === undefined) {
        return { kind: "failed", reason: `The GitHub App installation does not grant ${setup.repositoryFullName}.` };
      }
      const token = await dependencies.tokens.tokenForInstallation(setup.githubInstallationId, { contents: "read" }, [setup.repositoryFullName]);
      dependencies.redactor.addSecret(token);

      const ref = await createSandbox(setup.id, setup.tenantId, setup.productId, [
        ...new Set([...hostsOf(url), ...ECOSYSTEM_HOSTS, ...product.allowedDomains]),
      ]);
      const started = Date.now();
      try {
        const primary = await checkoutPrimary(dependencies.sandbox, ref, { url, ref: defaultBranch }, token);
        const existingConfig = await readText(dependencies.sandbox, ref, `${primary.path}/${CONFIG}`);
        // DI-21.18. The parts the last setup could not prove, so the agent tries them again.
        const previous = await dependencies.setups.previousWithReport(setup.productId, setup.repositoryFullName, setup.createdAt);
        const previousNotProven = (previous?.report?.parts ?? [])
          .filter((part) => !part.passed)
          .map((part) => ({ kind: part.kind, name: part.name, reason: part.reason }));
        // The agent may start the stack itself to try it. A provider without Docker runs none.
        if (dependencies.sandbox.capabilities.supportsDocker) {
          await ensureDocker(dependencies.sandbox, ref).catch((error: unknown) =>
            dependencies.logger.warn("rootless Docker did not start in the setup sandbox", { setup_id: setup.id, error: String(error) }),
          );
        }
        const testSecretNames = (await dependencies.secrets.list(setup.tenantId, setup.productId))
          .filter((secret) => secret.kind === "test")
          .map((secret) => secret.name);
        const appChangesPath = `${ref.workspacePath}/setup-app-changes.txt`;
        const runnerName = DEFAULT_PROJECT_RUNTIME_CONFIG.implementerRunner;
        const runner = dependencies.runners.get(runnerName);
        const result = await runner.run({
          runId: setupSandboxRunId(setup.id),
          tenantId: setup.tenantId,
          role: "setup",
          sandbox: dependencies.sandbox,
          ref,
          workingDirectory: primary.path,
          repositoryPath: primary.path,
          prompt: renderSetupPrompt({
            repository: setup.repositoryFullName,
            primaryRepositoryPath: primary.path,
            productSlug: product.slug,
            linearTeamKey: product.linearTeamKey,
            testSecretNames,
            ecosystemHosts: ECOSYSTEM_HOSTS,
            appChangesPath,
            existingConfig,
            previousNotProven,
          }),
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
        if (proposalText === null) return { kind: "failed", reason: "The setup agent wrote no .factoree/config.yaml." };

        // The bootstrap allow list is what the sandbox reached inside the ecosystem host list. A
        // provider that records no egress gets the whole list.
        const log = dependencies.sandbox.egressLog === undefined ? null : await dependencies.sandbox.egressLog(ref);
        const reached = log === null ? [...ECOSYSTEM_HOSTS] : [...new Set(log.filter((record) => record.decision === "allowed").map((record) => record.host))];
        const bootstrapHosts = narrowAllowList(reached.length === 0 ? ["none.invalid"] : reached, [...ECOSYSTEM_HOSTS]).sort();
        const deniedHosts = log === null ? [] : [...new Set(log.filter((record) => record.decision === "denied").map((record) => record.host))].sort();
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
        };
      } finally {
        await dependencies.sandbox.destroy(ref).catch(() => undefined);
      }
    },

    /**
     * docs/specs/repository-setup-and-services.md. Proves each part in a fresh sandbox with only
     * the proposed allow list, keeps the parts that passed, and opens the pull request.
     */
    async proveAndPublishSetup(input: { setupId: string; session: Extract<SetupSessionOutput, { kind: "proposed" }> }): Promise<SetupProofOutput> {
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
      const ref = await createSandbox(setup.id, setup.tenantId, setup.productId, repositoryHosts);
      const parts: SetupPartResult[] = [];
      const record = (part: SetupPartResult): void => {
        parts.push({ ...part, ...(part.logTail === undefined ? {} : { logTail: dependencies.redactor.redactText(withoutUrlCredentials(part.logTail)) }) });
      };
      let handle: PreviewHandle | null = null;
      let fakes: SetupReport["fakes"] = [];
      let finalPatch: { patchBase64: string; patchSha256: string; gitVersion: string } | null = null;
      try {
        const primary = await checkoutPrimary(dependencies.sandbox, ref, { url, ref: session.baseSha }, readToken);
        const apply = await dependencies.sandbox.exec(ref, {
          file: "sh",
          args: ["-c", `printf '%s' "$FACTOREE_SETUP_PATCH" | base64 -d | git apply --whitespace=nowarn`],
          cwd: primary.path,
          env: { FACTOREE_SETUP_PATCH: session.patchBase64 },
        });
        if (apply.exitCode !== 0) throw new Error(`the setup patch did not apply: ${tail(apply.stdout, apply.stderr)}`);

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
          finalPatch = { patchBase64: patch.patchBase64, patchSha256: patch.patchSha256, gitVersion: patch.gitVersion };
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
