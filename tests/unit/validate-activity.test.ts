import { describe, expect, it, vi } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
import type { UserValidateActivityOutput } from "~/activities/validation.activities.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import {
  AgentSessionUnavailableError,
  type AgentResumeInput,
  type AgentRunResult,
  type AgentSessionRef,
} from "~/domain/runs/agent-runner.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { FakeRunner } from "../support/fake-runner.js";
import { build, input, planFiles, planText, rejectedPlan } from "../support/user-validate-fixture.js";

/**
 * Rejects every `exposeService` call, the way `FlySpriteSandbox` does today (a recorded Phase 2
 * limitation: Fly has no documented publish API). Every other method behaves like `FakeSandbox`.
 */
class NoExposeSandbox extends FakeSandbox {
  override exposeService(): ReturnType<FakeSandbox["exposeService"]> {
    return Promise.reject(new Error("this sandbox adapter cannot expose a service"));
  }
}


describe("the userValidate activity", () => {
  it("runs a fresh validator session and records its prompt version", async () => {
    const runner = new FakeRunner();
    const { activities, executions } = build(runner);
    const environment = new MockActivityEnvironment();

    const output: UserValidateActivityOutput = await environment.run(
      (activityInput: typeof input) => activities.userValidate(activityInput),
      input,
    );

    expect(runner.runs[0]?.role).toBe("validator");
    expect(executions.rows[0]).toMatchObject({ role: "validator", promptVersion: "user-validator@9" });
    expect(output.sessionId).toBe("ses_fake");
  });

  it("keeps heartbeating while the preview builds and the browser runs (FAC-41 live run)", async () => {
    // FAC-41 failed with a heartbeat timeout: the heartbeat stopped with the validator session,
    // and the Next.js preview build of the check sprite outlasted the two-minute timeout.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const runner = new FakeRunner();
      const { activities, browser } = build(runner);
      const environment = new MockActivityEnvironment();
      let heartbeats = 0;
      environment.on("heartbeat", () => {
        heartbeats += 1;
      });
      let duringBrowser = 0;
      browser.during = async () => {
        const before = heartbeats;
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        duringBrowser = heartbeats - before;
      };

      await environment.run((activityInput: typeof input) => activities.userValidate(activityInput), input);

      expect(duringBrowser).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never gives the validator an Implementer transcript", async () => {
    const runner = new FakeRunner();
    const { activities } = build(runner);
    const environment = new MockActivityEnvironment();

    await environment.run((activityInput: typeof input) => activities.userValidate(activityInput), input);

    expect(runner.runs[0]?.prompt).not.toContain("The change is applied.");
  });

  it("denies the validator the primary worktree", async () => {
    const runner = new FakeRunner();
    const { activities } = build(runner);
    const environment = new MockActivityEnvironment();

    await environment.run((activityInput: typeof input) => activities.userValidate(activityInput), input);

    expect(runner.runs[0]?.actionPolicy.decide("writePrimaryWorktree")).toBe("deny");
  });

  it("writes one evidence row per artefact and one result row per assertion", async () => {
    const runner = new FakeRunner();
    const { activities, evidence, results } = build(runner);
    const environment = new MockActivityEnvironment();

    await environment.run((activityInput: typeof input) => activities.userValidate(activityInput), input);

    // The browser outcome always carries a console, a network, and an assertion-log artefact
    // beside the required screenshot; the http outcome carries one request-response artefact.
    expect(evidence.rows.filter((row) => row.validationAssertionId !== null)).toHaveLength(5);
    expect(results.rows).toHaveLength(2);
    expect(results.rows[0]).toMatchObject({ result: "PASS", attempt: 1 });
  });

  it("reports hasFailure only when an assertion is FAIL", async () => {
    const passRunner = new FakeRunner();
    const { activities } = build(passRunner);
    const environment = new MockActivityEnvironment();

    const output: UserValidateActivityOutput = await environment.run(
      (activityInput: typeof input) => activities.userValidate(activityInput),
      input,
    );
    expect(output.hasFailure).toBe(false);
    expect(output.passed).toBe(true);
  });

  it("writes nothing new on a second call with the same attempt", async () => {
    const runner = new FakeRunner();
    const { activities, executions, evidence, results } = build(runner);
    const environment = new MockActivityEnvironment();

    await environment.run((activityInput: typeof input) => activities.userValidate(activityInput), input);
    // A second call with the same attempt models a Temporal retry. The idempotency key of every
    // row it writes must stay the same, so every store must still hold the same rows, not a
    // second copy.
    await environment.run((activityInput: typeof input) => activities.userValidate(activityInput), input);

    expect(executions.rows).toHaveLength(1);
    expect(evidence.rows).toHaveLength(5);
    expect(results.rows).toHaveLength(2);
  });

  it("asks the sandbox to expose the preview address without starting a second preview process", async () => {
    const runner = new FakeRunner();
    const { activities, sandbox } = build(runner);
    const environment = new MockActivityEnvironment();

    await environment.run((activityInput: typeof input) => activities.userValidate(activityInput), input);

    // The prompt's own step reads the address through `exposeService` alone, never through
    // `startProcess`. `runUserValidation` is the only caller that starts the preview process,
    // so exactly one `startProcess` call for the preview command exists.
    expect(sandbox.calls.filter((call) => call.startsWith("exposeService")).length).toBeGreaterThan(0);
    expect(sandbox.commands.filter((command) => command.args.includes("npm run dev -- --port 8080"))).toHaveLength(1);
  });

  it("still produces results when the sandbox cannot expose the preview address", async () => {
    const runner = new FakeRunner();
    const { activities } = build(runner, new NoExposeSandbox());
    const environment = new MockActivityEnvironment();

    const output: UserValidateActivityOutput = await environment.run(
      (activityInput: typeof input) => activities.userValidate(activityInput),
      input,
    );

    // No preview URL could be read, so the browser and http assertions cannot run. The activity
    // still returns a plain result instead of throwing, and `runUserValidation` reports the
    // honest outcome for each affected assertion.
    expect(output.hasBlocked).toBe(true);
    expect(output.passed).toBe(false);
  });

  it("reports the exposed preview base URL, so the Proof Pack can name it", async () => {
    const runner = new FakeRunner();
    const { activities } = build(runner);
    const environment = new MockActivityEnvironment();

    const output: UserValidateActivityOutput = await environment.run(
      (activityInput: typeof input) => activities.userValidate(activityInput),
      input,
    );

    // SDD section 47. The Proof Pack names the preview a human can still open while the sandbox
    // lives. It must be the address the validator actually used.
    expect(output.previewUrl).toMatch(/^http/);
  });

  it("reports no preview URL when the sandbox could not expose one", async () => {
    const runner = new FakeRunner();
    const { activities } = build(runner, new NoExposeSandbox());
    const environment = new MockActivityEnvironment();

    const output: UserValidateActivityOutput = await environment.run(
      (activityInput: typeof input) => activities.userValidate(activityInput),
      input,
    );

    // A URL Factoree never exposed must never reach the Proof Pack. Null is the honest report.
    expect(output.previewUrl).toBeNull();
  });

  it("reports an unregistered validator runner as a configuration fault", async () => {
    const runner = new FakeRunner();
    const { activities } = build(runner);
    const environment = new MockActivityEnvironment();

    // SDD section 15 states `claude` as the default validator runner, and SDD section 69 gives
    // `ClaudeCodeRunner` to Phase 11. A stock configuration must fail as a repairable
    // configuration fault, not as an internal error.
    const promise = environment.run(
      (activityInput: typeof input) => activities.userValidate(activityInput),
      { ...input, runnerName: "claude" },
    );

    await expect(promise).rejects.toThrow(RunConfigurationError);
    await expect(promise).rejects.toThrow(/validator runner "claude"/);
    // The message names the registered runners, so an operator can repair the configuration.
    await expect(promise).rejects.toThrow(/opencode/);
  });
});

describe("the userValidate activity, a session that wrote no plan", () => {
  // A measured session wrote the plan on one pass and not on the next, from the same prompt.
  // Without a reminder every automated assertion is BLOCKED, and the Run proves nothing.
  it("asks the session once more, then reads the plan it wrote", async () => {
    const sandbox = new FakeSandbox();
    let reads = 0;
    sandbox.onExec = (command) => {
      if (command.file !== "cat") return { exitCode: 0, stdout: "", stderr: "" };
      reads += 1;
      // The first read finds nothing. The reminder makes the session write the plan.
      return reads === 1
        ? { exitCode: 1, stdout: "", stderr: "No such file" }
        : { exitCode: 0, stdout: planText, stderr: "" };
    };
    const runner = new FakeRunner();
    const { activities, results } = build(runner, sandbox);

    const output: UserValidateActivityOutput = await new MockActivityEnvironment().run(
      (activityInput: typeof input) => activities.userValidate(activityInput),
      input,
    );

    expect(runner.resumes).toHaveLength(1);
    expect(runner.resumes[0]?.input.prompt).toContain("You wrote no Validation Plan");
    // The plan of the second read decides the outcome, so the assertions are answered.
    expect(results.rows.every((row) => row.result !== "BLOCKED")).toBe(true);
    expect(output.results.length).toBeGreaterThan(0);
  });

  it("blocks the assertions when the reminder produces no plan either", async () => {
    const sandbox = new FakeSandbox();
    sandbox.onExec = (command) =>
      command.file === "cat"
        ? { exitCode: 1, stdout: "", stderr: "No such file" }
        : { exitCode: 0, stdout: "", stderr: "" };
    const runner = new FakeRunner();
    const { activities } = build(runner, sandbox);

    const output: UserValidateActivityOutput = await new MockActivityEnvironment().run(
      (activityInput: typeof input) => activities.userValidate(activityInput),
      input,
    );

    expect(runner.resumes).toHaveLength(1);
    expect(output.results.every((result) => result.result === "BLOCKED")).toBe(true);
  });
});

describe("the userValidate activity, a rejected Validation Plan (DI-15.23)", () => {
  // FAC-63: the validator wrote a browser assertion as a command check, the plan rules rejected
  // the whole plan, and the Run ended VALIDATION_BLOCKED with no assertion executed.
  const commandReason = 'is a "command" check, but the frozen method "browser" requires a "browser" check.';
  const pathReason = '"//evil.example/health", which is not a relative preview path';

  const run = (activities: ReturnType<typeof build>["activities"]): Promise<UserValidateActivityOutput> =>
    new MockActivityEnvironment().run(
      (activityInput: typeof input) => activities.userValidate(activityInput),
      input,
    );

  it("asks nothing more when the first plan is valid", async () => {
    const runner = new FakeRunner();
    const { activities, sessions, logLines } = build(runner);

    const output = await run(activities);

    expect(output.passed).toBe(true);
    expect(runner.runs).toHaveLength(1);
    expect(runner.resumes).toHaveLength(0);
    expect(sessions.rows.map((row) => row.idempotencyKey)).toEqual(["run:run-1:validator:1"]);
    expect(logLines.some((line) => line["message"] === "validation plan rejected; asking the validator to correct it")).toBe(false);
  });

  it("resumes the session once with every reason, then runs the corrected plan", async () => {
    const runner = new FakeRunner();
    const { activities, sessions, results, browser, logLines } = build(runner, planFiles(rejectedPlan, planText));

    const output = await run(activities);

    expect(runner.runs).toHaveLength(1);
    expect(runner.resumes).toHaveLength(1);
    const prompt = runner.resumes[0]!.input.prompt;
    expect(prompt).toContain(commandReason);
    expect(prompt).toContain(pathReason);
    expect(prompt).toContain('VAL-UI-001: frozen method "browser". Its entry must be a "browser" check.');
    expect(prompt).toContain('VAL-API-001: frozen method "http". Its entry must be a "http" check.');
    expect(prompt).toContain("/workspace/validation/plan-corrected.json");
    expect(prompt).toContain("full corrected Validation Plan");
    // The assertions of the corrected plan executed.
    expect(browser.calls).toHaveLength(1);
    expect(output.passed).toBe(true);
    expect(results.rows.map((row) => row.result)).toEqual(["PASS", "PASS"]);
    expect(sessions.rows.map((row) => row.idempotencyKey)).toEqual([
      "run:run-1:validator:1",
      "run:run-1:validator:1:plan-correction",
    ]);
    expect(sessions.rows[1]).toMatchObject({ role: "validator", attempt: 1 });
    const rejection = logLines.find((line) => line["message"] === "validation plan rejected; asking the validator to correct it");
    expect(JSON.stringify(rejection?.["reasons"])).toContain("VAL-UI-001");
    expect(JSON.stringify(rejection?.["reasons"])).toContain("VAL-API-001");
  });

  it("blocks every automated assertion with both reasons when the corrected plan is rejected too", async () => {
    const stillWrong = JSON.stringify({
      version: 1,
      entries: [{ assertionId: "VAL-UI-001", kind: "browser", steps: [{ action: "goto", path: "/" }] }],
    });
    const runner = new FakeRunner();
    const { activities, browser } = build(runner, planFiles(rejectedPlan, stillWrong));

    const output = await run(activities);

    expect(runner.resumes).toHaveLength(1);
    expect(browser.calls).toHaveLength(0);
    expect(output.hasBlocked).toBe(true);
    expect(output.hasFailure).toBe(false);
    for (const result of output.results) {
      expect(result.result).toBe("BLOCKED");
      expect(result.reason).toContain(`Factoree rejected the first Validation Plan: The Validation Plan entry for "VAL-UI-001" ${commandReason}`);
      expect(result.reason).toContain("It then rejected the corrected Validation Plan:");
      expect(result.reason).toContain("asserts nothing");
    }
  });

  it("names a missing corrected plan beside the first reason", async () => {
    const runner = new FakeRunner();
    const { activities } = build(runner, planFiles(rejectedPlan, null));

    const output = await run(activities);

    expect(output.results.every((result) => result.result === "BLOCKED")).toBe(true);
    expect(output.results[0]?.reason).toContain("The validator wrote no corrected Validation Plan.");
    expect(output.results[0]?.reason).toContain(commandReason);
  });

  it("starts one fresh session with the correction when the CLI named no session", async () => {
    // The runner names the session by its process, so no CLI session exists to resume.
    const runner = new FakeRunner("opencode", {
      session: { sessionId: "process-fake", processId: "process-fake", runner: "opencode" },
    });
    const { activities, executions, sessions, results } = build(
      runner,
      planFiles(rejectedPlan, planText, () => runner.runs.length > 1),
    );

    const output = await run(activities);

    expect(runner.resumes).toHaveLength(0);
    expect(runner.runs).toHaveLength(2);
    const fresh = runner.runs[1]!;
    expect(fresh.prompt).toContain("# User Validator instructions");
    expect(fresh.prompt).toContain("# Validation Plan correction");
    expect(fresh.prompt).toContain(commandReason);
    expect(fresh.prompt).toContain("/workspace/validation/plan-corrected.json");
    expect(fresh.prompt).not.toContain("/workspace/validation/plan.json");
    expect(fresh.promptVersion).toBe("user-validator@9+user-validator-plan-correction@1");
    expect(output.passed).toBe(true);
    expect(results.rows.map((row) => row.result)).toEqual(["PASS", "PASS"]);
    expect(executions.rows.map((row) => row.idempotencyKey)).toEqual([
      "run:run-1:validator:1",
      "run:run-1:validator:1:plan-correction",
    ]);
    expect(sessions.rows).toHaveLength(2);
  });

  it("starts one fresh session when this worker cannot resume the session", async () => {
    class RemoteSessionRunner extends FakeRunner {
      override resume(session: AgentSessionRef): Promise<AgentRunResult> {
        return Promise.reject(new AgentSessionUnavailableError(this.name, session.sessionId));
      }
    }
    const runner = new RemoteSessionRunner();
    const { activities } = build(runner, planFiles(rejectedPlan, planText, () => runner.runs.length > 1));

    const output = await run(activities);

    expect(runner.runs).toHaveLength(2);
    expect(runner.runs[1]!.prompt).toContain("# Validation Plan correction");
    expect(output.passed).toBe(true);
  });

  it("starts one fresh session when the resume fails and writes no plan", async () => {
    class FailingResumeRunner extends FakeRunner {
      override async resume(session: AgentSessionRef, resumeInput: AgentResumeInput): Promise<AgentRunResult> {
        const result = await super.resume(session, resumeInput);
        return { ...result, completed: false, exitCode: 1 };
      }
    }
    const runner = new FailingResumeRunner();
    const { activities } = build(runner, planFiles(rejectedPlan, planText, () => runner.runs.length > 1));

    const output = await run(activities);

    expect(runner.resumes).toHaveLength(1);
    expect(runner.runs).toHaveLength(2);
    expect(runner.runs[1]!.prompt).toContain("# Validation Plan correction");
    expect(output.passed).toBe(true);
  });
});
