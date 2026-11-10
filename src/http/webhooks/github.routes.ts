import type { FastifyInstance } from "fastify";
import type { BuildAheadTrigger } from "~/domain/runs/build-ahead.js";
import {
  deploymentStatusEventSchema,
  FACTOREE_CONFIG_PATH,
  installationEventSchema,
  installationRepositoriesEventSchema,
  pullRequestEventSchema,
  pushEventSchema,
} from "~/adapters/github/webhook-schemas.js";
import type { DiscoveryOutcome, DiscoveryService } from "~/domain/products/discovery-service.js";
import type { TenantRegistry } from "~/domain/products/tenant-registry.js";
import type { Logger } from "~/telemetry/logger.js";

export interface GitHubWebhookDependencies {
  discovery: DiscoveryService;
  tenants: TenantRegistry;
  /** Reads the webhook secret from the install settings for each delivery. */
  verifySignature: (raw: Buffer, signature: string) => boolean | Promise<boolean>;
  /**
   * Starts the sync of one GitHub App installation, keyed on the installation id so a repeated
   * `installation` event joins the run already in flight rather than start a second one.
   */
  startInstallationSync: (input: { tenantId: string; githubInstallationId: string }) => Promise<void>;
  /**
   * docs/specs/proof-pack-and-visual-evidence.md. Records the pull request preview of the commit
   * a Run published, and adds the link to its Linear session. It answers false when no Run of the
   * tenant published that commit.
   */
  recordPullRequestPreview: (input: {
    tenantId: string;
    repositoryFullName: string;
    commitSha: string;
    previewUrl: string;
  }) => Promise<boolean>;
  logger: Logger;
  /** docs/specs/run-speed.md. A config push with a new bootstrap key requests a build-ahead. */
  buildAhead?: Pick<BuildAheadTrigger, "afterPush">;
  /**
   * docs/specs/setup-app-change-issues.md. Each push to the default branch: a merged setup creates
   * its app-change issues, and a round whose issues all ended starts the next setup.
   */
  setupAfterPush?: (input: { tenantId: string; repositoryFullName: string }) => Promise<void>;
  /**
   * docs/specs/egress-honesty-and-issue-status.md. A pull request of a run merged or closed. It
   * answers "unmatched" when no run target of the tenant opened it.
   */
  pullRequestClosed?: (input: {
    tenantId: string;
    deliveryId: string;
    repositoryFullName: string;
    number: number;
    merged: boolean;
  }) => Promise<"handled" | "duplicate" | "unmatched">;
}

/**
 * Resolves the tenant that owns a GitHub App installation. The numeric installation id is
 * stable across an account rename, so this route never resolves by the account login.
 */
const resolveTenantId = async (
  dependencies: GitHubWebhookDependencies,
  installationId: number,
  accountLogin: string | undefined,
): Promise<string | null> => {
  const tenant = await dependencies.tenants.findByGitHubInstallation(String(installationId));
  if (tenant !== null) return tenant.id;
  // No operator has bound this installation to a tenant yet. This is not an error. The event
  // carries no work Factoree can do. GitHub must not redeliver it.
  dependencies.logger.warn("ignored a GitHub event for an unbound installation", {
    installation_id: String(installationId),
    ...(accountLogin === undefined ? {} : { account_login: accountLogin }),
  });
  return null;
};

const touchesConfigPath = (files: string[]): boolean => files.includes(FACTOREE_CONFIG_PATH);

/**
 * Specification section 8. A discovery conflict must not vanish. No persisted conflict record
 * and no operator route that lists one exist yet, so the worker log is the record: it names
 * the repository, the reason, and, because `DiscoveryService` already folds the offending key
 * or the competing Product's slug into `reason`, an operator can read the line alone and know
 * exactly what to change, with no code open.
 */
const logDiscoveryOutcome = (
  dependencies: GitHubWebhookDependencies,
  fullName: string,
  outcome: DiscoveryOutcome,
): void => {
  if (outcome.kind === "registered") return;
  const level = outcome.kind === "conflict" ? "warn" : "info";
  dependencies.logger[level](`repository discovery did not register ${fullName}: ${outcome.reason}`, {
    repository: fullName,
    outcome: outcome.kind,
    reason: outcome.reason,
  });
};

export const registerGitHubWebhookRoutes = (app: FastifyInstance, dependencies: GitHubWebhookDependencies): void => {
  app.post("/webhooks/github", async (request, reply) => {
    const raw = request.rawBody ?? Buffer.alloc(0);
    const signature = request.headers["x-hub-signature-256"] as string | undefined;
    if (!(await dependencies.verifySignature(raw, signature ?? ""))) {
      return reply.code(401).send({ error: "invalid_signature" });
    }

    const event = request.headers["x-github-event"] as string | undefined;

    if (event === "installation_repositories") {
      const parsed = installationRepositoriesEventSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(200).send({ status: "ignored", reason: "unsupported payload" });

      const tenantId = await resolveTenantId(
        dependencies,
        parsed.data.installation.id,
        parsed.data.installation.account.login,
      );
      if (tenantId !== null) {
        // The event names no default branch, so the installation sync reads each granted
        // repository from the API, the same path as the installation event.
        if (parsed.data.repositories_added.length > 0) {
          await dependencies.startInstallationSync({
            tenantId,
            githubInstallationId: String(parsed.data.installation.id),
          });
        }
        for (const repository of parsed.data.repositories_removed ?? []) {
          await dependencies.discovery.markAbsent(tenantId, repository.full_name);
        }
      }
      return reply.code(200).send({ status: "handled" });
    }

    if (event === "push") {
      const parsed = pushEventSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(200).send({ status: "ignored", reason: "unsupported payload" });

      const { ref, repository, commits, installation } = parsed.data;
      if (ref !== `refs/heads/${repository.default_branch}`) {
        return reply.code(200).send({ status: "ignored", reason: "not the default branch" });
      }

      let added = false;
      let modified = false;
      let removed = false;
      for (const commit of commits) {
        if (touchesConfigPath(commit.added)) added = true;
        if (touchesConfigPath(commit.modified)) modified = true;
        if (touchesConfigPath(commit.removed)) removed = true;
      }

      if (added || modified || removed) {
        const tenantId = await resolveTenantId(dependencies, installation.id, undefined);
        if (tenantId !== null) {
          if (removed && !added && !modified) {
            await dependencies.discovery.markAbsent(tenantId, repository.full_name);
          } else {
            const outcome = await dependencies.discovery.syncRepository(
              tenantId,
              repository.full_name,
              repository.default_branch,
              String(installation.id),
            );
            logDiscoveryOutcome(dependencies, repository.full_name, outcome);
            if (outcome.kind === "registered") {
              await dependencies.buildAhead?.afterPush(tenantId, repository.full_name);
            }
          }
        }
      } else if (dependencies.buildAhead !== undefined) {
        // docs/specs/repository-setup-and-services.md. A push that changes a key file changes the
        // bootstrap key, though it leaves the config alone. The trigger reads the key and decides.
        const tenantId = await resolveTenantId(dependencies, installation.id, undefined);
        if (tenantId !== null) await dependencies.buildAhead.afterPush(tenantId, repository.full_name);
      }
      if (dependencies.setupAfterPush !== undefined) {
        const tenantId = await resolveTenantId(dependencies, installation.id, undefined);
        if (tenantId !== null) await dependencies.setupAfterPush({ tenantId, repositoryFullName: repository.full_name });
      }
      return reply.code(200).send({ status: "handled" });
    }

    if (event === "deployment_status") {
      const parsed = deploymentStatusEventSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(200).send({ status: "ignored", reason: "unsupported payload" });
      const url = parsed.data.deployment_status.environment_url ?? "";
      // Only a live preview is a link a human can open. A pending, failed or inactive status
      // carries no URL worth showing.
      if (parsed.data.deployment_status.state !== "success" || !/^https:\/\//.test(url)) {
        return reply.code(200).send({ status: "ignored", reason: "no live preview" });
      }
      const tenantId = await resolveTenantId(dependencies, parsed.data.installation.id, undefined);
      if (tenantId === null) return reply.code(200).send({ status: "handled" });
      // The deployment SHA must equal the commit a Run published. A preview of any other commit
      // shows a change Factoree did not verify.
      const linked = await dependencies.recordPullRequestPreview({
        tenantId,
        repositoryFullName: parsed.data.repository.full_name,
        commitSha: parsed.data.deployment.sha,
        previewUrl: url,
      });
      return reply.code(200).send(linked ? { status: "handled" } : { status: "ignored", reason: "no run published this commit" });
    }

    if (event === "pull_request") {
      const parsed = pullRequestEventSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(200).send({ status: "ignored", reason: "unsupported payload" });
      // A close without a merge makes no push, so only this event says a pull request ended.
      if (parsed.data.action !== "closed" || dependencies.pullRequestClosed === undefined) {
        return reply.code(200).send({ status: "ignored", reason: "unsupported action" });
      }
      const tenantId = await resolveTenantId(dependencies, parsed.data.installation.id, undefined);
      if (tenantId === null) return reply.code(200).send({ status: "handled" });
      const merged = parsed.data.pull_request.merged === true;
      const delivery = request.headers["x-github-delivery"];
      const outcome = await dependencies.pullRequestClosed({
        tenantId,
        // GitHub always names the delivery. Without it, the event itself keys the marker.
        deliveryId:
          typeof delivery === "string" && delivery !== ""
            ? `github:${delivery}`
            : `github:pull_request:${parsed.data.repository.full_name}#${String(parsed.data.number)}:${merged ? "merged" : "closed"}`,
        repositoryFullName: parsed.data.repository.full_name,
        number: parsed.data.number,
        merged,
      });
      return reply
        .code(200)
        .send(outcome === "unmatched" ? { status: "ignored", reason: "no run opened this pull request" } : { status: outcome });
    }

    if (event === "installation") {
      const parsed = installationEventSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(200).send({ status: "ignored", reason: "unsupported payload" });
      // "created" grants a fresh installation. "unsuspend" can restore access to repositories
      // granted while the installation was suspended. Both need a sync. "deleted" and "suspend"
      // must not sync: the installation's token can no longer be minted, so a sync would only
      // fail against GitHub. GitHub sends no default branch on this event, so the sync workflow
      // reads every granted repository of the installation instead, rather than a target here.
      if (parsed.data.action !== "created" && parsed.data.action !== "unsuspend") {
        return reply.code(200).send({ status: "ignored", reason: "unsupported action" });
      }
      const tenantId = await resolveTenantId(
        dependencies,
        parsed.data.installation.id,
        parsed.data.installation.account.login,
      );
      if (tenantId !== null) {
        await dependencies.startInstallationSync({
          tenantId,
          githubInstallationId: String(parsed.data.installation.id),
        });
      }
      return reply.code(200).send({ status: "handled" });
    }

    return reply.code(200).send({ status: "ignored", reason: "unsupported event" });
  });
};
