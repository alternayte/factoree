import type { McpToolPort } from "~/adapters/mcp/mcp-json-rpc-client.js";
import { CLAUDE_CREDENTIAL_NAMES, claudeApiHostOf, hasClaudeCredential } from "~/domain/products/agent-settings.js";
import type { ProductRegistry } from "~/domain/products/product-registry.js";
import type { RepositoryRegistry } from "~/domain/products/repository-registry.js";
import { registerProjectSecrets } from "~/domain/products/redaction-loader.js";
import { attachRunnerEnvironment, loadRunnerEnvironment } from "~/domain/products/runner-credentials.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { checkFinding, findingsFileSchema, MAX_FINDINGS, titleKeyOf, type CheckedFinding, type RetroSessionInput } from "~/domain/retro/retro-finding.js";
import { FIRST_RETRO_WINDOW_MS, MAX_RETRO_RUNS, retroMetricsOf, type RetroRunExport } from "~/domain/retro/retro-export.js";
import { resolveRetroRole, retroSessionRunId } from "~/domain/retro/retro-settings.js";
import { fetchSignals } from "~/domain/retro/signal-fetch.js";
import { signalResultPath } from "~/domain/retro/signal-source.js";
import type { TranscriptStore } from "~/domain/retro/transcript.js";
import type { AgentRunnerRegistry, AgentRunResult } from "~/domain/runs/agent-runner.js";
import type { SandboxProviderSelector } from "~/domain/runs/provider-selection.js";
import type { Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import type { PrismaRetroSettingsStore, PrismaRetroStore, PrismaSignalSourceStore, RetroEvent } from "~/persistence/prisma/retro.prisma.js";
import { RETRO_PROMPT_VERSION, renderRetroPrompt } from "~/prompts/retro.js";
import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";

export interface RetroActivityDependencies {
  retroSettings: Pick<PrismaRetroSettingsStore, "read">;
  retros: PrismaRetroStore;
  signalSources: Pick<PrismaSignalSourceStore, "list">;
  transcripts: Pick<TranscriptStore, "forRun">;
  products: Pick<ProductRegistry, "findById" | "list">;
  repositories: Pick<RepositoryRegistry, "listByProduct">;
  secrets: SecretStore;
  sandbox: Sandbox;
  providerSelector?: SandboxProviderSelector | undefined;
  runners: AgentRunnerRegistry;
  /** The MCP client of one signal source endpoint with its bearer token. */
  mcpTools: (endpoint: string, token: string | null) => McpToolPort;
  redactor: Redactor;
  logger: Logger;
  clock?: () => Date;
}

export type PreparedRetro = { kind: "run"; retroId: string; productIds: string[]; costCapUsd: number } | { kind: "skipped"; reason: string };

export interface RetroSessionOutcome {
  costUsd: number;
}

/** The longest one retro session may run. */
const RETRO_SESSION_TIMEOUT_MS = 30 * 60_000;
/** A hung session tries once more only with this much of its budget left. */
const RETRO_HANG_RETRY_MIN_MS = 5 * 60_000;
/** The transcripts of one run the export holds at most, and the bytes of each. */
const MAX_TRANSCRIPT_BYTES = 512 * 1024;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const slug = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);

export const createRetroActivities = (dependencies: RetroActivityDependencies) => {
  const now = dependencies.clock ?? (() => new Date());

  const event = (kind: RetroEvent["kind"], productId: string | null, message: string): Omit<RetroEvent, "at"> => ({
    kind,
    productId,
    message: dependencies.redactor.redactText(message).slice(0, 1_000),
  });

  const runSession = async (input: { tenantId: string; retroId: string; productId: string }): Promise<RetroSessionOutcome> => {
    const retro = await dependencies.retros.detail(input.tenantId, input.retroId);
      if (retro === null) throw new Error(`the retro ${input.retroId} does not exist`);
      const product = await dependencies.products.findById(input.tenantId, input.productId);
      if (product === null) throw new Error(`the product ${input.productId} of the retro does not exist`);
      const settings = await dependencies.retroSettings.read(input.tenantId);
      const role = resolveRetroRole(settings, product);
      const started = Date.now();
      const fail = async (reason: string, costUsd: number | null = null, extra: Partial<Parameters<PrismaRetroStore["recordSession"]>[0]> = {}): Promise<RetroSessionOutcome> => {
        await dependencies.retros.recordSession({
          tenantId: input.tenantId,
          retroId: input.retroId,
          productId: input.productId,
          status: "failed",
          runCount: 0,
          runner: role.runner,
          model: role.model,
          effort: role.effort,
          outcome: null,
          costUsd,
          durationMs: Date.now() - started,
          metrics: null,
          failureMessage: dependencies.redactor.redactText(reason),
          ...extra,
        });
        await dependencies.retros.addEvents(input.retroId, [event("session_failed", input.productId, reason)]);
        return { costUsd: costUsd ?? 0 };
      };

      await registerProjectSecrets(dependencies.redactor, dependencies.secrets, input.tenantId, input.productId, dependencies.logger);
      const runnerEnvironment = await loadRunnerEnvironment(dependencies.secrets, input.tenantId, input.productId);
      if (role.runner === "claude" && !hasClaudeCredential(runnerEnvironment)) {
        return fail(`The retro runs on Claude Code, and the product holds no Anthropic credential. Add ${CLAUDE_CREDENTIAL_NAMES.join(" or ")} as a runner credential on the product page.`);
      }

      // The runs and their transcripts.
      const runs = await dependencies.retros.exportRuns(input.tenantId, input.productId, retro.windowStart, retro.windowEnd, MAX_RETRO_RUNS);
      const transcriptFiles = new Map<string, string>();
      const exported: RetroRunExport[] = [];
      for (const run of runs) {
        const kept = await dependencies.transcripts.forRun(input.tenantId, run.id).catch((error: unknown) => {
          dependencies.logger.warn("a kept transcript did not read for the retro", { retro_id: input.retroId, run_id: run.id, error: messageOf(error) });
          return [];
        });
        const paths = kept.map((transcript) => {
          const path = `transcripts/${run.id}-${slug(transcript.role)}-${transcript.attempt}.txt`;
          transcriptFiles.set(path, transcript.text.slice(0, MAX_TRANSCRIPT_BYTES));
          return path;
        });
        exported.push({ ...run, transcripts: paths });
      }
      const metrics = retroMetricsOf(exported);

      // The signal results. A query fault is a retro event, never a failed retro.
      const since = retro.windowStart ?? new Date(retro.windowEnd.getTime() - FIRST_RETRO_WINDOW_MS);
      const sources = await dependencies.signalSources.list(input.tenantId, input.productId);
      const fetched = await fetchSignals(sources, since, {
        tools: dependencies.mcpTools,
        token: async (name) => {
          const value = await dependencies.secrets.get(input.tenantId, input.productId, name);
          if (value !== null) dependencies.redactor.addSecret(value);
          return value;
        },
        redactor: dependencies.redactor,
      });
      const signals = await dependencies.retros.storeSignalResults(input.tenantId, input.retroId, input.productId, fetched.results);
      const skippedLines = fetched.skipped.map((skip) => `${skip.sourceName}/${skip.queryName}: ${skip.reason}`);
      await dependencies.retros.addEvents(
        input.retroId,
        fetched.skipped.map((skip) => event("signal_skipped", input.productId, `The query ${skip.sourceName}/${skip.queryName} gave no result: ${skip.reason}`)),
      );

      const recordSkip = async (reason: string): Promise<RetroSessionOutcome> => {
        await dependencies.retros.recordSession({
          tenantId: input.tenantId,
          retroId: input.retroId,
          productId: input.productId,
          status: "skipped",
          runCount: 0,
          runner: role.runner,
          model: role.model,
          effort: role.effort,
          outcome: null,
          costUsd: null,
          durationMs: Date.now() - started,
          metrics,
          failureMessage: reason,
        });
        return { costUsd: 0 };
      };
      // An agent session with nothing to read costs money and finds nothing.
      if (exported.length === 0 && signals.length === 0) return recordSkip("No run of the product ended in the window, and it has no signal result.");

      const repositories = (await dependencies.repositories.listByProduct(input.productId)).map((repository) => repository.fullName);
      const sessionRunId = retroSessionRunId(input.retroId, input.productId);

      // docs/specs/sandbox-provider-spillover.md. The rule of a setup: no held slot, no Docker.
      let sandbox = dependencies.sandbox;
      if (dependencies.providerSelector !== undefined && dependencies.sandbox.forProvider !== undefined) {
        const providerId = await dependencies.providerSelector.selectForSetup({
          runId: sessionRunId,
          tenantId: input.tenantId,
          allowedProviderIds: product.sandboxProviderIds,
          repositoryUrl: null,
          needsDocker: false,
          minimum: null,
        });
        sandbox = await dependencies.sandbox.forProvider(providerId);
      }
      // P-08. The session reaches the model provider and nothing else: the Anthropic host for
      // Claude Code, and for opencode the product's allow list, where its model hosts live.
      const claudeHost = role.runner === "claude" ? claudeApiHostOf(runnerEnvironment) : null;
      const hosts = role.runner === "claude" ? (claudeHost === null ? [] : [claudeHost]) : [...product.allowedDomains];
      const ref: SandboxRef = await sandbox.create({ runId: sessionRunId, tenantId: input.tenantId, productId: input.productId });
      try {
        await attachRunnerEnvironment(dependencies.sandbox, ref, dependencies.secrets, input.tenantId, input.productId);
        await dependencies.sandbox.applyNetworkPolicy(ref, { allowedDomains: hosts });
        const root = `${ref.workspacePath}/retro`;
        await dependencies.sandbox.exec(ref, { file: "mkdir", args: ["-p", `${root}/runs`, `${root}/transcripts`, `${root}/signals`], cwd: "/" });
        for (const run of exported) {
          await dependencies.sandbox.writeFile(ref, `${root}/runs/${run.id}.json`, JSON.stringify(run, null, 2));
        }
        for (const [path, text] of transcriptFiles) await dependencies.sandbox.writeFile(ref, `${root}/${path}`, text);
        const promptSignals = [];
        for (const signal of signals) {
          const path = signalResultPath(signal.sourceName, signal.queryName);
          await dependencies.sandbox.exec(ref, { file: "mkdir", args: ["-p", `${root}/signals/${signal.sourceName}`], cwd: "/" });
          await dependencies.sandbox.writeFile(ref, `${root}/${path}`, signal.content);
          promptSignals.push({ id: signal.id, sourceName: signal.sourceName, kind: signal.sourceKind, queryName: signal.queryName, path: `${root}/${path}` });
        }
        const findingsPath = `${root}/findings.json`;
        const prompt = renderRetroPrompt({
          productId: product.id,
          productSlug: product.slug,
          productName: product.name,
          productGoal: product.productGoal,
          windowStart: retro.windowStart?.toISOString() ?? null,
          windowEnd: retro.windowEnd.toISOString(),
          runsDirectory: `${root}/runs`,
          runCount: exported.length,
          metrics,
          repositories,
          signals: promptSignals,
          skippedSignals: skippedLines,
          findingsPath,
        });

        const runner = dependencies.runners.get(role.runner);
        const startSession = (timeoutMs: number) =>
          runner.run({
            runId: sessionRunId,
            tenantId: input.tenantId,
            role: "retro",
            sandbox: dependencies.sandbox,
            ref,
            workingDirectory: root,
            prompt,
            promptVersion: RETRO_PROMPT_VERSION,
            environment: {},
            actionPolicy: buildActionPolicy({ role: "retro" }),
            timeoutMs,
          });
        const results: AgentRunResult[] = [];
        results.push(await startSession(RETRO_SESSION_TIMEOUT_MS));
        const left = RETRO_SESSION_TIMEOUT_MS - (Date.now() - started);
        if (results[0]?.outcome === "hung" && left >= RETRO_HANG_RETRY_MIN_MS) {
          dependencies.logger.warn("the retro session hung, so Factoree starts it once more", { retro_id: input.retroId, product_id: input.productId });
          results.push(await startSession(left));
        }
        const result = results.at(-1)!;
        const costs = results.map((entry) => entry.usage?.costUsd).filter((cost): cost is number => cost !== null && cost !== undefined);
        const costUsd = costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0);
        const sessionFields = { runCount: exported.length, outcome: result.outcome, model: result.model ?? role.model, metrics };

        const read = await dependencies.sandbox.exec(ref, { file: "cat", args: [findingsPath], cwd: "/" });
        if (read.exitCode !== 0) {
          const cause = result.completed || result.summary.trim() === "" ? "" : ` The session ${result.outcome}: ${result.summary.trim().slice(0, 500)}`;
          return fail(`The retro agent wrote no findings.json.${cause}`, costUsd, sessionFields);
        }
        let raw: unknown[];
        try {
          raw = findingsFileSchema.parse(JSON.parse(read.stdout)).findings;
        } catch (error) {
          return fail(`The retro agent wrote a findings.json that is not valid: ${messageOf(error).slice(0, 300)}`, costUsd, sessionFields);
        }

        // An agent claim is never evidence: each citation must name what this session read.
        const sessionInput: RetroSessionInput = {
          productId: product.id,
          productNames: [product.id, product.slug],
          runIds: new Set(exported.map((run) => run.id)),
          signalResults: new Map(signals.map((signal) => [signal.id, signal.sourceKind])),
          repositories: new Set(repositories),
        };
        const open = await dependencies.retros.openFindingsByTitle(input.tenantId, input.productId);
        const kept: Array<CheckedFinding & { duplicateOfId: string | null }> = [];
        const dropped: Array<Omit<RetroEvent, "at">> = [];
        const seen = new Set<string>();
        for (const entry of raw.slice(0, MAX_FINDINGS)) {
          const checked = checkFinding(entry, sessionInput);
          if ("dropped" in checked) {
            dropped.push(event("finding_dropped", input.productId, `Factoree dropped the finding "${checked.dropped.title}": ${checked.dropped.reason}.`));
            continue;
          }
          const key = titleKeyOf(checked.kept.title);
          if (seen.has(key)) continue;
          seen.add(key);
          const redacted = { ...checked.kept, title: dependencies.redactor.redactText(checked.kept.title), description: dependencies.redactor.redactText(checked.kept.description) };
          kept.push({ ...redacted, duplicateOfId: open.get(key) ?? null });
        }
        if (raw.length > MAX_FINDINGS) dropped.push(event("finding_dropped", input.productId, `Factoree kept the first ${MAX_FINDINGS} of ${raw.length} findings.`));
        await dependencies.retros.storeFindings({ tenantId: input.tenantId, retroId: input.retroId, productId: input.productId, findings: kept });
        await dependencies.retros.addEvents(input.retroId, dropped);
        await dependencies.retros.recordSession({
          tenantId: input.tenantId,
          retroId: input.retroId,
          productId: input.productId,
          status: "finished",
          runner: role.runner,
          effort: role.effort,
          costUsd,
          durationMs: Date.now() - started,
          failureMessage: null,
          ...sessionFields,
        });
        return { costUsd: costUsd ?? 0 };
      } finally {
        await dependencies.sandbox.destroy(ref).catch(() => undefined);
      }
  };

  return {
    /**
     * docs/specs/retro-agent.md. Opens the retro of one workflow. One retro runs at a time per
     * tenant, and the window starts where the last successful retro ended.
     */
    async prepareRetro(input: { tenantId: string; workflowId: string; trigger: "schedule" | "manual" }): Promise<PreparedRetro> {
      const existing = await dependencies.retros.findByWorkflow(input.workflowId);
      if (existing === null) {
        const running = await dependencies.retros.running(input.tenantId);
        if (running !== null) return { kind: "skipped", reason: `the retro ${running.id} is still running` };
      }
      const settings = await dependencies.retroSettings.read(input.tenantId);
      const last = await dependencies.retros.lastSuccessful(input.tenantId);
      const products = (await dependencies.products.list(input.tenantId)).filter(
        (product) => product.status === "active" && (settings.productIds.length === 0 || settings.productIds.includes(product.id)),
      );
      // A retry of this activity reads the row it wrote, with the products it chose then.
      const retro =
        existing ??
        (await dependencies.retros.start({
          tenantId: input.tenantId,
          workflowId: input.workflowId,
          trigger: input.trigger,
          windowStart: last?.windowEnd ?? null,
          windowEnd: now(),
          promptVersion: RETRO_PROMPT_VERSION,
          productIds: products.map((product) => product.id),
        }));
      return { kind: "run", retroId: retro.id, productIds: retro.productIds, costCapUsd: settings.costCapUsd };
    },

    /** A product the retro did not read, or whose session failed, with the reason, so the page names it. */
    async skipRetroSession(input: { tenantId: string; retroId: string; productId: string; reason: string; status?: "skipped" | "failed" }): Promise<void> {
      await dependencies.retros.recordSession({
        tenantId: input.tenantId,
        retroId: input.retroId,
        productId: input.productId,
        status: input.status ?? "skipped",
        runCount: 0,
        runner: null,
        model: null,
        effort: null,
        outcome: null,
        costUsd: null,
        durationMs: null,
        metrics: null,
        failureMessage: input.reason,
      });
      await dependencies.retros.addEvents(input.retroId, [event(input.status === "failed" ? "session_failed" : "session_skipped", input.productId, input.reason)]);
    },

    /**
     * docs/specs/retro-agent.md. One agent session for one product: Factoree exports the ended
     * runs and the signal results as files, the agent writes findings.json, and Factoree keeps the
     * findings whose citations hold.
     */
    async runRetroSession(input: { tenantId: string; retroId: string; productId: string }): Promise<RetroSessionOutcome> {
      return runSession(input);
    },

    async finishRetro(input: { retroId: string; status: "succeeded" | "failed"; failureMessage: string | null }): Promise<void> {
      await dependencies.retros.finish(input.retroId, input.status, input.failureMessage === null ? null : dependencies.redactor.redactText(input.failureMessage).slice(0, 2_000));
    },
  };
};

export type RetroActivities = ReturnType<typeof createRetroActivities>;
