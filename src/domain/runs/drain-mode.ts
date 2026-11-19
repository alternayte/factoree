import type { Logger } from "~/telemetry/logger.js";
import type { AgentRunWorkflowInput } from "~/workflows/agent-run.workflow.js";
import type { CreateWaitingRunInput, WaitingRun, WaitingRunStore } from "./blocker-wait.js";
import { compareReleases } from "./upgrade-check.js";

/**
 * docs/specs/drain-mode.md. The install-wide pause before a release that open runs cannot replay.
 * While it is on, each new agent run waits as a WAITING_FOR_UPDATE row with no workflow, and every
 * open run finishes as normal. A worker of a newer release ends it at boot, or an admin ends it.
 */
export interface DrainState {
  startedAt: Date;
  /** The user or API key that turned it on, or null when unknown. */
  startedBy: string | null;
  /** The release of the API that turned it on. A worker of a newer release ends it. */
  release: string;
}

export interface DrainSettings {
  read(): Promise<DrainState | null>;
  write(state: DrainState | null): Promise<void>;
}

/** The elicitation of a held run, and the fixed answer to a reply while it waits. */
export const HELD_LINE = "Factoree is updating to a new release. It starts this run when the update ends.";

/** True when a worker of `release` ends the drain that `state` holds: only a newer release does. */
export const endsDrain = (state: DrainState | null, release: string): boolean =>
  state !== null && compareReleases(release, state.release) > 0;

export interface DrainModeDependencies {
  settings: DrainSettings;
  store: Pick<WaitingRunStore, "createWaiting" | "listHeld" | "holdForUpdate">;
  /** The idempotent start of the blocked-by wait: "already_started" when the workflow id exists. */
  start: (workflowId: string, input: AgentRunWorkflowInput) => Promise<"started" | "already_started">;
  post: (tenantId: string, sessionId: string, kind: "elicitation" | "response", body: string) => Promise<void>;
  /** The FACTOREE_RELEASE of this process. */
  release: string;
  logger: Logger;
  now?: () => Date;
}

export class DrainMode {
  constructor(private readonly dependencies: DrainModeDependencies) {}

  state(): Promise<DrainState | null> {
    return this.dependencies.settings.read();
  }

  async isOn(): Promise<boolean> {
    return (await this.state()) !== null;
  }

  /** Turns drain mode on. A drain already on keeps its start and its release. */
  async turnOn(startedBy: string | null): Promise<DrainState> {
    const current = await this.state();
    if (current !== null) return current;
    const state: DrainState = { startedAt: this.dependencies.now?.() ?? new Date(), startedBy, release: this.dependencies.release };
    await this.dependencies.settings.write(state);
    this.dependencies.logger.info("drain mode on", { step: "drain", release: state.release, by: startedBy ?? "unknown" });
    return state;
  }

  async turnOff(): Promise<void> {
    if ((await this.state()) === null) return;
    await this.dependencies.settings.write(null);
    this.dependencies.logger.info("drain mode off", { step: "drain" });
  }

  /** At worker boot, after the upgrade check passed: a newer release ends the drain. A restart does not. */
  async endIfNewer(): Promise<boolean> {
    const state = await this.state();
    if (!endsDrain(state, this.dependencies.release)) return false;
    await this.dependencies.settings.write(null);
    this.dependencies.logger.info("drain mode ended by a newer release", { step: "drain", from: state?.release ?? "", to: this.dependencies.release });
    return true;
  }

  /**
   * At delegation, after the blocked-by check. While drain mode is on it writes the held row and
   * posts the held line, and answers true. With drain mode off it answers false and the caller
   * starts the run.
   */
  async hold(input: Omit<CreateWaitingRunInput, "blockers" | "status">): Promise<boolean> {
    if (!(await this.isOn())) return false;
    const { runId, created } = await this.dependencies.store.createWaiting({ ...input, blockers: null, status: "WAITING_FOR_UPDATE" });
    if (!created) return true;
    this.dependencies.logger.info("run held for the update", { tenant_id: input.tenantId, product_id: input.productId, run_id: runId, step: "drain" });
    await this.post(input.tenantId, input.linearAgentSessionId, HELD_LINE);
    return true;
  }

  /** A blocked run whose blockers closed while drain mode is on waits for the update instead. */
  async holdReleasedBlockedRun(run: WaitingRun): Promise<void> {
    if (!(await this.dependencies.store.holdForUpdate(run.id))) return;
    this.dependencies.logger.info("run held for the update", { tenant_id: run.tenantId, run_id: run.id, step: "drain" });
    await this.post(run.tenantId, run.linearAgentSessionId, HELD_LINE);
  }

  /** With drain mode off, starts every held run, oldest first. Each start is idempotent. */
  async release(): Promise<number> {
    if (await this.isOn()) return 0;
    let started = 0;
    for (const run of await this.dependencies.store.listHeld()) {
      const log = { tenant_id: run.tenantId, run_id: run.id, step: "drain" };
      try {
        const outcome = await this.dependencies.start(run.temporalWorkflowId, run.startInput);
        if (outcome === "started") started += 1;
        this.dependencies.logger.info(outcome === "started" ? "held run started after the update" : "held run already started", log);
      } catch (error) {
        this.dependencies.logger.warn("a held run did not start; the next sweep tries again", { ...log, error: String(error) });
      }
    }
    return started;
  }

  /** A Linear fault never undoes the row the post describes, so it is logged. */
  private async post(tenantId: string, sessionId: string, body: string): Promise<void> {
    try {
      await this.dependencies.post(tenantId, sessionId, "elicitation", body);
    } catch (error) {
      this.dependencies.logger.warn("the held line was not posted", { tenant_id: tenantId, session_id: sessionId, step: "drain", error: String(error) });
    }
  }
}
