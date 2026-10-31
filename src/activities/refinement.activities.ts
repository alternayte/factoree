import { Context } from "@temporalio/activity";
import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import type { AgentRunResult, AgentRunner, AgentRunnerRegistry, AgentSessionRef } from "~/domain/runs/agent-runner.js";
import { agentSessionKey, type AgentSessionStore } from "~/domain/runs/agent-session.js";
import { hangOf, recordAgentSession, type AgentHang } from "./agent-session-recording.js";
import { UnknownAgentRunnerError } from "~/domain/runs/agent-runner.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import type { AgentExecutionRepository } from "~/domain/runs/agent-execution.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import { attachRunnerEnvironment } from "~/domain/products/runner-credentials.js";
import { registerProjectSecrets } from "~/domain/products/redaction-loader.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { worktreeFingerprint } from "~/domain/review/source-diff.js";
import type { ValidationCriterion } from "~/domain/validation/validation-contract-builder.js";
import type { FactoreeDecision } from "~/domain/runs/factoree-decision.js";
import {
  gateRefinerProposal,
  refinementDecisions,
  type GatedRefinement,
  type GateRepository,
  parseRefinerProposal,
  REFINER_PROPOSAL_SCHEMA,
} from "~/domain/refinement/refiner-proposal.js";
import { REFINER_PROMPT_VERSION, renderRefinerPrompt } from "~/prompts/refiner.js";
import { metrics } from "~/telemetry/metrics.js";
import type {
  RecordedDecision,
  RefinementEngine,
  RefinementProject,
  RefinementQuestion,
} from "~/domain/refinement/refinement-engine.js";
import type { WorkItemSource } from "~/domain/refinement/work-item.js";

export interface RefineActivityInput {
  runId: string;
  tenantId: string;
  productId: string;
  source: WorkItemSource;
  project: RefinementProject;
  decisions: RecordedDecision[];
  /** True when the labels of the Work Item could not be read. */
  labelsUnreadable?: boolean;
}

export interface RefineActivityOutput {
  status: "ready" | "needs_input";
  goal: string;
  primaryRepository: string;
  referenceRepositories: string[];
  /** The statements only. The workflow needs them for the context topics. */
  acceptanceCriteria: string[];
  /**
   * The proposed acceptance criteria with their identifiers. SDD section 24 requires each
   * validation assertion to name its source requirement, and the identifier is that name.
   * `acceptanceCriteria` above stays a list of statements, because the context topics need the
   * statements only.
   */
  criteria: Array<{ id: string; statement: string; source: string }>;
  /** Every reference the Work Item declared, as written. */
  workItemReferences: string[];
  risks: string[];
  /** SDD section 7 and section 40. The constraints the Work Item stated. */
  constraints: string[];
  unresolvedQuestions: RefinementQuestion[];
  autonomyLevel: string;
  /** docs/specs/autonomy-levels.md. One sentence for each rule that lowered the level. */
  autonomyReasons: string[];
}

export interface RefinementActivityDependencies {
  refinement: RefinementEngine;
  logger: Logger;
  /** docs/specs/refiner-agent.md. The ports the refiner agent session needs. */
  agent?: {
    sandbox: Sandbox;
    runners: AgentRunnerRegistry;
    executions: AgentExecutionRepository;
    /** docs/specs/agent-session-usage-and-hangs.md. One row per agent session. */
    sessions: AgentSessionStore;
    secrets: SecretStore;
    redactor: Redactor;
  };
}

/** docs/specs/refiner-agent.md. One refiner session in the work sprite. */
export interface ProposeRefinementActivityInput {
  runId: string;
  tenantId: string;
  productId: string;
  runnerName: string;
  spriteId: string;
  adapter: string;
  workspacePath: string;
  primaryPath: string;
  /** The ticket title and description, as Linear holds them. The gate checks quotes against it. */
  workItemText: string;
  goal: string;
  statedCriteria: string[];
  contextContract: string;
  skills: string[];
  /** docs/specs/proof-pack-and-visual-evidence.md. True when the repository has an enabled preview. */
  previewConfigured: boolean;
  timeoutMs: number;
  /**
   * docs/specs/agent-session-usage-and-hangs.md. True for the one fresh session that follows a
   * hung one. It writes its own proposal file and its own rows.
   */
  afterHang?: boolean;
}

export interface ProposeRefinementActivityOutput {
  /**
   * `unavailable`: the refiner wrote no valid proposal. `worktree_changed`: it changed a file of
   * the primary worktree, which the refiner role must never do.
   */
  status: "proposed" | "unavailable" | "worktree_changed";
  /** The criteria that freeze, implied ones included. */
  accepted: ValidationCriterion[];
  /**
   * docs/specs/own-proposals-and-parallel-runs.md. The proposals Factoree takes without asking:
   * implied criteria, criteria not built, dropped criteria, the refiner's answers and a visual gap.
   */
  decisions: FactoreeDecision[];
  /** docs/specs/proof-pack-and-visual-evidence.md. The visual evidence gap Factoree accepted. */
  visualEvidenceGap: string | null;
  reason: string;
  /** docs/specs/agent-session-usage-and-hangs.md. Set when the session wrote no output for the silence limit. */
  hang: AgentHang;
}

const REFINER_HEARTBEAT_INTERVAL_MS = 10_000;

interface RunnerWithActiveSession {
  activeSession(runId: string): AgentSessionRef | undefined;
}

const activeSessionOf = (runner: AgentRunner, runId: string): AgentSessionRef | undefined => {
  const candidate = runner as Partial<RunnerWithActiveSession>;
  return typeof candidate.activeSession === "function" ? candidate.activeSession(runId) : undefined;
};

/** Gates a proposal text, or answers null when the text is not a valid proposal. */
const gateOrNull = (
  text: string,
  workItemText: string,
  repository: GateRepository,
): GatedRefinement | null => {
  try {
    return gateRefinerProposal(parseRefinerProposal(text), workItemText, repository);
  } catch {
    return null;
  }
};

/**
 * SDD section 63 names this file. SDD section 8 puts Refinement before the readiness gate and
 * before a sandbox exists. The activity therefore holds no sandbox and no agent runner. It is a
 * pure function of its input, so a Temporal retry causes no side effect.
 */
export const createRefinementActivities = (dependencies: RefinementActivityDependencies) => ({
  refine(input: RefineActivityInput): Promise<RefineActivityOutput> {
    const started = Date.now();
    const output = dependencies.refinement.refine({
      source: input.source,
      project: input.project,
      decisions: input.decisions,
      ...(input.labelsUnreadable === undefined ? {} : { labelsUnreadable: input.labelsUnreadable }),
    });
    // A Temporal workflow must stay deterministic, so the metric belongs here.
    metrics.refinementDuration.observe(
      { tenant_id: input.tenantId, product_id: input.productId },
      (Date.now() - started) / 1000,
    );
    dependencies.logger.info("run refined", {
      tenant_id: input.tenantId,
      product_id: input.productId,
      run_id: input.runId,
      step: "refine",
      status: output.status,
    });
    return Promise.resolve({
      status: output.status,
      goal: output.goal,
      primaryRepository: output.primaryRepository,
      referenceRepositories: output.referenceRepositories,
      acceptanceCriteria: output.proposedAcceptanceCriteria.map((criterion) => criterion.statement),
      criteria: output.proposedAcceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        statement: criterion.statement,
        source: criterion.source,
      })),
      workItemReferences: output.workItem.references.map((reference) => reference.value),
      risks: output.risks,
      constraints: output.workItem.constraints,
      unresolvedQuestions: output.unresolvedQuestions,
      autonomyLevel: output.autonomyLevel,
      autonomyReasons: output.autonomyReasons,
    });
  },

  /**
   * docs/specs/refiner-agent.md. A fresh refiner session reads the work sprite and writes one
   * proposal. The gate decides what of it may freeze. The session must not change the primary
   * worktree, and the fingerprint before and after proves it.
   */
  async proposeRefinement(input: ProposeRefinementActivityInput): Promise<ProposeRefinementActivityOutput> {
    const agent = dependencies.agent;
    if (agent === undefined) {
      throw new Error("the refiner activity needs the agent ports, and this worker holds none");
    }
    await registerProjectSecrets(agent.redactor, agent.secrets, input.tenantId, input.productId, dependencies.logger);

    let runner: AgentRunner;
    try {
      runner = agent.runners.get(input.runnerName);
    } catch (error) {
      if (!(error instanceof UnknownAgentRunnerError)) throw error;
      throw new RunConfigurationError(
        `The Project configures the validator runner "${input.runnerName}", which the refiner uses, ` +
          `and it is not registered. Registered runners: ${agent.runners.names().join(", ")}. ` +
          "Repair `validator_runner` in `.factoree/config.yaml`.",
      );
    }

    const ref = { id: input.spriteId, adapter: input.adapter, workspacePath: input.workspacePath };
    await attachRunnerEnvironment(agent.sandbox, ref, agent.secrets, input.tenantId, input.productId);
    const directory = `${input.workspacePath}/refinement`;
    await agent.sandbox.exec(ref, { file: "mkdir", args: ["-p", directory] });
    const afterHang = input.afterHang === true;
    // A hung session can leave a partial proposal, and the fresh session must never read it.
    const proposalPath = `${directory}/${afterHang ? "proposal-after-hang" : "proposal"}.json`;
    const fingerprint = { sandbox: agent.sandbox, redactor: agent.redactor };
    const before = await worktreeFingerprint(fingerprint, { ref, primaryPath: input.primaryPath });

    const repository = { previewConfigured: input.previewConfigured };
    const actionPolicy = buildActionPolicy({ role: "refiner" });
    const prompt = renderRefinerPrompt({
      workItem: input.workItemText,
      goal: input.goal,
      statedCriteria: input.statedCriteria,
      contextContract: input.contextContract,
      primaryRepositoryPath: input.primaryPath,
      proposalPath,
      proposalSchema: REFINER_PROPOSAL_SCHEMA,
      skills: input.skills,
    });

    const context = Context.current();
    const heartbeat = setInterval(() => context.heartbeat(), REFINER_HEARTBEAT_INTERVAL_MS);
    const onCancel = (): void => {
      const session = activeSessionOf(runner, input.runId);
      if (session !== undefined) void runner.cancel(session).catch(() => undefined);
    };
    if (context.cancellationSignal.aborted) onCancel();
    else context.cancellationSignal.addEventListener("abort", onCancel, { once: true });

    const invocations: AgentRunResult[] = [];
    try {
      const result = await runner.run({
        runId: input.runId,
        tenantId: input.tenantId,
        role: "refiner",
        sandbox: agent.sandbox,
        ref,
        workingDirectory: directory,
        repositoryPath: input.primaryPath,
        prompt,
        promptVersion: REFINER_PROMPT_VERSION,
        environment: {},
        actionPolicy,
        timeoutMs: input.timeoutMs,
      });
      invocations.push(result);
      // A reminder is pointless once the session hung. The workflow decides what follows.
      const live = (): boolean => !context.cancellationSignal.aborted && hangOf(invocations) === null;
      let read = await agent.sandbox.exec(ref, { file: "cat", args: [proposalPath] });
      if (read.exitCode !== 0 && live()) {
        // A session can answer in a message and forget the file. One reminder recovers it.
        invocations.push(
          await runner.resume(result.session, {
            prompt: `You wrote no proposal. Write it now, as one JSON document, to ${proposalPath}. Write the file and nothing else.`,
            timeoutMs: input.timeoutMs,
          }),
        );
        read = await agent.sandbox.exec(ref, { file: "cat", args: [proposalPath] });
      }
      // docs/specs/proof-pack-and-visual-evidence.md. A visible criterion in a repository with a
      // preview needs a browser check. One reminder asks for it before the gap reaches a human.
      if (read.exitCode === 0 && input.previewConfigured && live()) {
        const first = gateOrNull(read.stdout, input.workItemText, repository);
        if (first !== null && first.visualEvidenceGap !== null) {
          const reminder = await runner.resume(result.session, {
            prompt:
              `${first.visualEvidenceGap} The repository has a preview, so give each visible criterion ` +
              'the method "browser" and a target route that starts with "/". Rewrite ' +
              `${proposalPath} with the whole proposal. Write the file and nothing else.`,
            timeoutMs: input.timeoutMs,
          });
          invocations.push(reminder);
          read = await agent.sandbox.exec(ref, { file: "cat", args: [proposalPath] });
        }
      }
      const hang = hangOf(invocations);

      await agent.executions.record({
        tenantId: input.tenantId,
        runId: input.runId,
        role: "refiner",
        runner: runner.name,
        model: null,
        sessionRef: result.session.sessionId,
        promptVersion: REFINER_PROMPT_VERSION,
        durationMs: result.durationMs,
        finalResult: {
          completed: result.completed,
          exitCode: result.exitCode,
          cancelled: result.cancelled,
          summary: result.summary,
        },
        idempotencyKey: agentSessionKey(input.runId, "refiner", null, afterHang),
      });
      // The refiner runs before the first Implementer attempt, so its row carries attempt 1.
      await recordAgentSession(
        { sessions: agent.sessions, logger: dependencies.logger },
        {
          tenantId: input.tenantId,
          productId: input.productId,
          runId: input.runId,
          role: "refiner",
          attempt: 1,
          runner: runner.name,
          idempotencyKey: agentSessionKey(input.runId, "refiner", null, afterHang),
        },
        invocations,
      );

      const after = await worktreeFingerprint(fingerprint, { ref, primaryPath: input.primaryPath });
      const empty = { accepted: [], decisions: [], visualEvidenceGap: null, hang: null };
      if (after !== before) {
        return {
          status: "worktree_changed",
          ...empty,
          reason: `The refiner changed the primary worktree. Tree before: ${before}. Tree after: ${after}.`,
        };
      }
      // docs/specs/agent-session-usage-and-hangs.md. A hung session proves nothing, even when a
      // partial proposal exists. The workflow starts one fresh session.
      if (hang !== null) {
        return { status: "unavailable", ...empty, hang, reason: "The refiner session wrote no output for the silence limit." };
      }
      if (read.exitCode !== 0) {
        return { status: "unavailable", ...empty, reason: "The refiner wrote no proposal." };
      }
      let gated;
      try {
        gated = gateRefinerProposal(parseRefinerProposal(read.stdout), input.workItemText, repository);
      } catch (error) {
        return { status: "unavailable", ...empty, reason: agent.redactor.redactText(String(error)) };
      }
      dependencies.logger.info("refinement proposed", {
        tenant_id: input.tenantId,
        run_id: input.runId,
        step: "propose_refinement",
        accepted: gated.accepted.length,
        implied: gated.implied.length,
        not_built: gated.notBuilt.length,
      });
      return {
        status: "proposed",
        accepted: gated.accepted,
        decisions: refinementDecisions(gated),
        visualEvidenceGap: gated.visualEvidenceGap,
        reason: "",
        hang: null,
      };
    } finally {
      clearInterval(heartbeat);
      context.cancellationSignal.removeEventListener("abort", onCancel);
    }
  },
});
