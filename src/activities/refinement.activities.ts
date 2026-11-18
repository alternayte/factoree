import { Context } from "@temporalio/activity";
import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";
import type { Sandbox } from "~/domain/runs/sandbox.js";
import type { AgentRunResult, AgentRunner, AgentRunnerRegistry, AgentSessionRef } from "~/domain/runs/agent-runner.js";
import { agentSessionKey, refinerLimitCorrectionSessionKey, type AgentSessionStore } from "~/domain/runs/agent-session.js";
import { hangOf, providerUnreachableOf, recordAgentSession, type AgentHang, type AgentProviderUnreachable } from "./agent-session-recording.js";
import { AgentSessionUnavailableError, UnknownAgentRunnerError } from "~/domain/runs/agent-runner.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import type { AgentExecutionRepository } from "~/domain/runs/agent-execution.js";
import type { SecretStore } from "~/domain/products/secret-store.js";
import { attachRunnerEnvironment } from "~/domain/products/runner-credentials.js";
import { registerProjectSecrets } from "~/domain/products/redaction-loader.js";
import { buildActionPolicy } from "~/domain/policy/action-policy.js";
import { setFingerprintOf, worktreeFingerprint } from "~/domain/review/source-diff.js";
import type { ValidationCriterion } from "~/domain/validation/validation-contract-builder.js";
import type { FactoreeDecision } from "~/domain/runs/factoree-decision.js";
import {
  DEFAULT_REFINER_CRITERIA_LIMIT,
  gateRefinerProposal,
  overLimitMessage,
  proposalOverLimitOf,
  refinementDecisions,
  type GatedRefinement,
  type GateRepository,
  parseRefinerProposal,
  REFINER_PROPOSAL_SCHEMA,
  REFINER_QUESTIONS_LIMIT,
  RefinerProposalError,
  citationKey,
  gateTargetProposals,
  type AddedTarget,
  type GatedTargets,
} from "~/domain/refinement/refiner-proposal.js";
import {
  REFINER_LIMIT_CORRECTION_VERSION,
  REFINER_PROMPT_VERSION,
  renderRefinerLimitCorrectionPrompt,
  renderRefinerPrompt,
} from "~/prompts/refiner.js";
import { metrics } from "~/telemetry/metrics.js";
import type {
  RecordedDecision,
  RefinementEngine,
  RefinementProject,
  RefinementQuestion,
} from "~/domain/refinement/refinement-engine.js";
import type { WorkItemSource } from "~/domain/refinement/work-item.js";
import type { RunStageStore } from "~/domain/runs/run-stage.js";
import { gateMissingHosts, type EgressFacts, type MissingHost } from "~/domain/runs/egress.js";
import type { ForYourEyeCriterion } from "~/domain/validation/for-your-eye.js";
import type { TargetEdge } from "~/domain/runs/merge-order.js";

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
    /** docs/specs/run-speed.md. The stage rows of each run. */
    stages?: RunStageStore | undefined;
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
  /** docs/specs/change-sets.md. Every target of a change set in the work sprite. Absent for one target. */
  targets?: Array<{ repository: string; path: string }>;
  /** docs/specs/change-sets.md. The `owner/repo` name of the primary target. Absent in an older history. */
  primaryRepository?: string;
  /**
   * docs/specs/change-sets.md, DI-21.138. The other repositories of the product, cloned read-only
   * at their default-branch head. Absent when the run can add no target.
   */
  siblings?: Array<{ repository: string; path: string; commitSha: string }>;
  /**
   * DI-21.139. True when the gate takes the proposed targets and edges. False or absent for a PR
   * follow-up run, a bring-current run and an older history: the proposal then adds nothing.
   */
  targetsOpen?: boolean;
  /** The ticket title and description, as Linear holds them. The gate checks quotes against it. */
  workItemText: string;
  goal: string;
  statedCriteria: string[];
  contextContract: string;
  /**
   * docs/specs/external-context-delivery.md. One line per context file of the work sprite. Absent
   * in a history recorded before the delivery existed.
   */
  contextFiles?: string[];
  /**
   * docs/specs/work-item-images-and-links.md. One line per image file of the sandbox. Absent in a
   * history recorded before the images existed.
   */
  imageFiles?: string[];
  skills: string[];
  /** docs/specs/proof-pack-and-visual-evidence.md. True when the repository has an enabled preview. */
  previewConfigured: boolean;
  timeoutMs: number;
  /**
   * docs/specs/agent-session-usage-and-hangs.md. True for the one fresh session that follows a
   * hung one. It writes its own proposal file and its own rows.
   */
  afterHang?: boolean;
  /**
   * docs/specs/provider-unreachable.md. 1 or 2 for the fresh session that follows an unreachable
   * provider. It writes its own files and its own rows, as the session after a hang does.
   */
  unreachableRetry?: number;
  /**
   * docs/specs/egress-honesty-and-issue-status.md. The effective allow list of the work sprite and
   * the hosts only the bootstrap reached. Absent in a history recorded before it existed.
   */
  egress?: EgressFacts | null;
  /**
   * Issue #39, DI-21.66. The most criteria the proposal may hold, the Product setting. Absent in
   * a history recorded before the setting existed, where the cap was 20.
   */
  criteriaLimit?: number;
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
  /**
   * docs/specs/by-eye-criteria-and-selector-recheck.md. The criteria a person judges by eye. They
   * never freeze. Absent in a history recorded before they existed.
   */
  forYourEye?: ForYourEyeCriterion[];
  reason: string;
  /**
   * Issue #39, DI-21.66. The whole failure message, when the human must act on it: the proposal
   * stayed over a cap after the correction round. Absent otherwise, and in an older history.
   */
  message?: string;
  /** docs/specs/agent-session-usage-and-hangs.md. Set when the session wrote no output for the silence limit. */
  hang: AgentHang;
  /** docs/specs/provider-unreachable.md. Set when the session could not reach the model provider. */
  providerUnreachable?: AgentProviderUnreachable;
  /**
   * docs/specs/egress-honesty-and-issue-status.md, DI-21.48. The named hosts the effective allow
   * list does not hold. Any one ends the Run. Absent in a history recorded before it existed.
   */
  missingHosts?: MissingHost[];
  /**
   * docs/specs/change-sets.md, DI-21.139. The targets the gate accepted, each with its decision,
   * which the workflow records once the target joins the run. Absent when no target is open.
   */
  addedTargets?: AddedTarget[];
  /** DI-21.139. The edges the gate accepted, between targets of the set after the additions. */
  edges?: TargetEdge[];
}

const REFINER_HEARTBEAT_INTERVAL_MS = 10_000;

interface RunnerWithActiveSession {
  activeSession(runId: string): AgentSessionRef | undefined;
}

const activeSessionOf = (runner: AgentRunner, runId: string): AgentSessionRef | undefined => {
  const candidate = runner as Partial<RunnerWithActiveSession>;
  return typeof candidate.activeSession === "function" ? candidate.activeSession(runId) : undefined;
};

/**
 * docs/specs/change-sets.md, DI-21.139. One cited line of a file in a checkout, or null when the
 * path leaves the checkout, names no file, or the file holds no such line. The sandbox resolves
 * every link first, so a link cannot read outside the checkout.
 */
const readCitation = async (
  sandbox: Sandbox,
  ref: { id: string; adapter: string; workspacePath: string },
  root: string,
  file: string,
  line: number,
): Promise<string | null> => {
  if (file.startsWith("/") || file.split("/").includes("..") || !Number.isInteger(line) || line < 1) return null;
  const result = await sandbox.exec(ref, {
    file: "sh",
    args: [
      "-c",
      'r=$(realpath -e -- "$0") || exit 3; p=$(realpath -e -- "$0/$1") || exit 3; case "$p" in "$r"/*) ;; *) exit 4;; esac; ' +
        '[ -f "$p" ] || exit 5; awk -v n="$2" \'NR == n { print; found = 1; exit } END { exit found ? 0 : 6 }\' "$p"',
      root,
      file,
      String(line),
    ],
    cwd: "/",
  });
  return result.exitCode === 0 ? result.stdout.replace(/\n$/, "") : null;
};

/** Gates a proposal text, or answers null when the text is not a valid proposal. */
const gateOrNull = (
  text: string,
  workItemText: string,
  repository: GateRepository,
  criteriaLimit: number,
): GatedRefinement | null => {
  try {
    return gateRefinerProposal(parseRefinerProposal(text, criteriaLimit), workItemText, repository);
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
        `The Product selects the refiner runner "${input.runnerName}", and it is not registered. ` +
          `Registered runners: ${agent.runners.names().join(", ")}. Repair the refiner runner on the product page.`,
      );
    }

    const ref = { id: input.spriteId, adapter: input.adapter, workspacePath: input.workspacePath };
    await attachRunnerEnvironment(agent.sandbox, ref, agent.secrets, input.tenantId, input.productId);
    const directory = `${input.workspacePath}/refinement`;
    await agent.sandbox.exec(ref, { file: "mkdir", args: ["-p", directory] });
    const unreachableRetry = input.unreachableRetry ?? 0;
    const afterHang = input.afterHang === true || unreachableRetry > 0;
    // A hung session can leave a partial proposal, and the fresh session must never read it.
    const proposalBase = `${afterHang ? "proposal-after-hang" : "proposal"}${unreachableRetry > 0 ? `-unreachable-${unreachableRetry}` : ""}`;
    const proposalPath = `${directory}/${proposalBase}.json`;
    const fingerprint = { sandbox: agent.sandbox, redactor: agent.redactor };
    // docs/specs/change-sets.md. The refiner must not change any target of a change set.
    const setTargets = input.targets !== undefined && input.targets.length > 1 ? input.targets : null;
    const treeOf = (): Promise<string> =>
      setTargets === null
        ? worktreeFingerprint(fingerprint, { ref, primaryPath: input.primaryPath })
        : setFingerprintOf(setTargets, (path) => worktreeFingerprint(fingerprint, { ref, primaryPath: path }));
    const before = await treeOf();

    const repository = { previewConfigured: input.previewConfigured };
    const actionPolicy = buildActionPolicy({ role: "refiner" });
    const criteriaLimit = input.criteriaLimit ?? DEFAULT_REFINER_CRITERIA_LIMIT;
    const promptFor = (path: string): string =>
      renderRefinerPrompt({
        workItem: input.workItemText,
        goal: input.goal,
        statedCriteria: input.statedCriteria,
        contextContract: input.contextContract,
        contextFiles: input.contextFiles ?? [],
        imageFiles: input.imageFiles ?? [],
        primaryRepositoryPath: input.primaryPath,
        ...(setTargets === null ? {} : { targetRepositories: setTargets }),
        ...(input.targetsOpen === true && (input.siblings ?? []).length > 0 ? { siblingRepositories: input.siblings } : {}),
        proposalPath: path,
        proposalSchema: REFINER_PROPOSAL_SCHEMA,
        criteriaLimit,
        questionsLimit: REFINER_QUESTIONS_LIMIT,
        skills: input.skills,
        egress: input.egress ?? null,
      });
    const prompt = promptFor(proposalPath);

    const context = Context.current();
    const heartbeat = setInterval(() => context.heartbeat(), REFINER_HEARTBEAT_INTERVAL_MS);
    const onCancel = (): void => {
      const session = activeSessionOf(runner, input.runId);
      if (session !== undefined) void runner.cancel(session).catch(() => undefined);
    };
    if (context.cancellationSignal.aborted) onCancel();
    else context.cancellationSignal.addEventListener("abort", onCancel, { once: true });

    const invocations: AgentRunResult[] = [];
    // Issue #39. A fresh session that corrects an over-limit proposal writes its own rows.
    const correctionInvocations: AgentRunResult[] = [];
    const correctionKey = refinerLimitCorrectionSessionKey(input.runId, afterHang, unreachableRetry);
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
      const live = (): boolean => !context.cancellationSignal.aborted && hangOf([...invocations, ...correctionInvocations]) === null &&
        providerUnreachableOf([...invocations, ...correctionInvocations]) === null;
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
      // Issue #39, DI-21.66. A proposal whose only fault is too many criteria or questions gets
      // one correction round: the same session when it resumes, one fresh session otherwise. The
      // corrected proposal goes to a new file, so a session that writes nothing leaves the first.
      let currentPath = proposalPath;
      const over = read.exitCode === 0 && live() ? proposalOverLimitOf(read.stdout, criteriaLimit) : null;
      if (over !== null) {
        const correctedPath = `${directory}/${proposalBase}-corrected.json`;
        const correction = renderRefinerLimitCorrectionPrompt({ ...over, proposalPath: correctedPath });
        dependencies.logger.warn("the refiner proposal is over its limits; asking the refiner to correct it", {
          tenant_id: input.tenantId,
          run_id: input.runId,
          step: "propose_refinement",
          criteria: over.criteria?.count ?? null,
          questions: over.questions?.count ?? null,
          criteria_limit: criteriaLimit,
        });
        // The last invocation is the live CLI session. A runner that never learned a CLI session
        // identifier names the session by its process, and that cannot be resumed.
        const last = invocations.at(-1)!.session;
        let resumed: AgentRunResult | null = null;
        if (last.sessionId !== last.processId) {
          try {
            resumed = await runner.resume(last, { prompt: correction, timeoutMs: input.timeoutMs });
            invocations.push(resumed);
          } catch (error) {
            // Another worker holds the session, so this one cannot resume it.
            if (!(error instanceof AgentSessionUnavailableError)) throw error;
          }
        }
        let corrected = await agent.sandbox.exec(ref, { file: "cat", args: [correctedPath] });
        // docs/specs/provider-unreachable.md. An outage is not a session that cannot be resumed.
        // It leaves the fallback, so a fresh correction is not started and then thrown away by the
        // outage the workflow retries on.
        const resumeFailed =
          resumed === null ||
          (!resumed.completed && !resumed.cancelled && resumed.outcome !== "hung" && resumed.outcome !== "unreachable");
        if (resumeFailed && corrected.exitCode !== 0 && !context.cancellationSignal.aborted) {
          dependencies.logger.warn("the refiner session cannot be resumed; starting one fresh session to correct the proposal", {
            tenant_id: input.tenantId,
            run_id: input.runId,
            step: "propose_refinement",
            resumed: resumed !== null,
          });
          // The fresh session reads the normal prompt, with the corrected proposal path, and then
          // the same correction message.
          const promptVersion = `${REFINER_PROMPT_VERSION}+${REFINER_LIMIT_CORRECTION_VERSION}`;
          const fresh = await runner.run({
            runId: input.runId,
            tenantId: input.tenantId,
            role: "refiner",
            sandbox: agent.sandbox,
            ref,
            workingDirectory: directory,
            repositoryPath: input.primaryPath,
            prompt: `${promptFor(correctedPath)}\n\n${correction}`,
            promptVersion,
            environment: {},
            actionPolicy,
            timeoutMs: input.timeoutMs,
          });
          correctionInvocations.push(fresh);
          await agent.executions.record({
            tenantId: input.tenantId,
            runId: input.runId,
            role: "refiner",
            runner: runner.name,
            model: null,
            sessionRef: fresh.session.sessionId,
            promptVersion,
            durationMs: fresh.durationMs,
            finalResult: {
              completed: fresh.completed,
              exitCode: fresh.exitCode,
              cancelled: fresh.cancelled,
              summary: fresh.summary,
            },
            idempotencyKey: correctionKey,
          });
          corrected = await agent.sandbox.exec(ref, { file: "cat", args: [correctedPath] });
        }
        if (corrected.exitCode === 0) {
          read = corrected;
          currentPath = correctedPath;
        }
      }
      // docs/specs/proof-pack-and-visual-evidence.md. A visible criterion in a repository with a
      // preview needs a browser check. One reminder asks for it before the gap reaches a human.
      if (read.exitCode === 0 && input.previewConfigured && live()) {
        const first = gateOrNull(read.stdout, input.workItemText, repository, criteriaLimit);
        if (first !== null && first.visualEvidenceGap !== null) {
          const reminder = await runner.resume(result.session, {
            prompt:
              `${first.visualEvidenceGap} The repository has a preview, so give each visible criterion ` +
              'the method "browser" and a target route that starts with "/". Rewrite ' +
              `${currentPath} with the whole proposal. Write the file and nothing else.`,
            timeoutMs: input.timeoutMs,
          });
          invocations.push(reminder);
          read = await agent.sandbox.exec(ref, { file: "cat", args: [currentPath] });
        }
      }
      const hang = hangOf([...invocations, ...correctionInvocations]);
      const providerUnreachable = providerUnreachableOf([...invocations, ...correctionInvocations]);

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
        idempotencyKey: agentSessionKey(input.runId, "refiner", null, afterHang, unreachableRetry),
      });
      // The refiner runs before the first Implementer attempt, so its row carries attempt 1.
      await recordAgentSession(
        { sessions: agent.sessions, logger: dependencies.logger, stages: agent.stages },
        {
          tenantId: input.tenantId,
          productId: input.productId,
          runId: input.runId,
          role: "refiner",
          attempt: 1,
          runner: runner.name,
          idempotencyKey: agentSessionKey(input.runId, "refiner", null, afterHang, unreachableRetry),
          sandboxId: input.spriteId,
        },
        invocations,
      );
      if (correctionInvocations.length > 0) {
        await recordAgentSession(
          { sessions: agent.sessions, logger: dependencies.logger, stages: agent.stages },
          {
            tenantId: input.tenantId,
            productId: input.productId,
            runId: input.runId,
            role: "refiner",
            attempt: 1,
            runner: runner.name,
            idempotencyKey: correctionKey,
            sandboxId: input.spriteId,
          },
          correctionInvocations,
        );
      }

      const after = await treeOf();
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
      // docs/specs/provider-unreachable.md. The session could not reach the model provider, so it
      // wrote no proposal. The workflow retries it.
      if (providerUnreachable !== null) {
        return { status: "unavailable", ...empty, providerUnreachable, reason: "The refiner session could not reach the model provider." };
      }
      if (read.exitCode !== 0) {
        return { status: "unavailable", ...empty, reason: "The refiner wrote no proposal." };
      }
      let gated;
      let parsed;
      try {
        parsed = parseRefinerProposal(read.stdout, criteriaLimit);
        gated = gateRefinerProposal(parsed, input.workItemText, repository);
      } catch (error) {
        // Issue #39. Still over a cap after the correction round: the human splits the Work Item
        // or raises the limit, so the message names that and not the schema.
        if (error instanceof RefinerProposalError && error.overLimit !== null) {
          const message = overLimitMessage(error.overLimit);
          return { status: "unavailable", ...empty, reason: message, message };
        }
        return { status: "unavailable", ...empty, reason: agent.redactor.redactText(String(error)) };
      }
      // DI-21.48. A host the allow list already holds is a misread fault, not a missing host.
      const hosts = gateMissingHosts(gated.missingHosts, input.egress?.allowed ?? []);
      if (hosts.dropped.length > 0) {
        dependencies.logger.warn("the refiner named hosts the allow list already holds, and Factoree dropped them", {
          tenant_id: input.tenantId,
          run_id: input.runId,
          step: "propose_refinement",
          hosts: hosts.dropped.map((entry) => entry.host).join(", "),
        });
      }
      // docs/specs/change-sets.md, DI-21.139. Each citation is read from the clone it names before the
      // gate decides, so the gate itself stays a pure function of the proposal and the lines.
      let targetGate: GatedTargets | null = null;
      if (input.targetsOpen === true) {
        const primaryName = input.primaryRepository ?? null;
        const targetRoots = setTargets ?? (primaryName === null ? [] : [{ repository: primaryName, path: input.primaryPath }]);
        const roots = new Map<string, { repository: string; path: string }>();
        for (const root of [...targetRoots, ...(input.siblings ?? [])]) roots.set(root.repository.toLowerCase(), root);
        const citations = new Map<string, string | null>();
        const wanted = [
          ...parsed.targets.map((target) => ({ repository: target.repository, file: target.file, line: target.line })),
          ...parsed.edges.map((edge) => ({ repository: edge.consumer, file: edge.file, line: edge.line })),
        ];
        for (const citation of wanted) {
          const root = roots.get(citation.repository.trim().toLowerCase());
          const key = citationKey(citation.repository.trim(), citation.file, citation.line);
          if (root === undefined || citations.has(key)) continue;
          const text = await readCitation(agent.sandbox, ref, root.path, citation.file, citation.line);
          citations.set(key, text === null ? null : agent.redactor.redactText(text));
        }
        targetGate = gateTargetProposals(parsed, {
          targets: targetRoots.map((root) => root.repository),
          siblings: (input.siblings ?? []).map((sibling) => ({ repository: sibling.repository, commitSha: sibling.commitSha })),
          cited: (name, file, line) => citations.get(citationKey(name, file, line)) ?? null,
        });
      }
      dependencies.logger.info("refinement proposed", {
        tenant_id: input.tenantId,
        run_id: input.runId,
        step: "propose_refinement",
        accepted: gated.accepted.length,
        implied: gated.implied.length,
        not_built: gated.notBuilt.length,
        for_your_eye: gated.forYourEye.length,
        targets_added: targetGate?.added.length ?? 0,
        edges: targetGate?.edges.length ?? 0,
      });
      return {
        status: "proposed",
        accepted: gated.accepted,
        decisions: [...refinementDecisions(gated), ...(targetGate?.refused ?? [])],
        visualEvidenceGap: gated.visualEvidenceGap,
        forYourEye: gated.forYourEye,
        reason: "",
        hang: null,
        missingHosts: hosts.missing,
        ...(targetGate === null ? {} : { addedTargets: targetGate.added, edges: targetGate.edges }),
      };
    } finally {
      clearInterval(heartbeat);
      context.cancellationSignal.removeEventListener("abort", onCancel);
    }
  },
});
