import { describe, expect, it } from "vitest";
import {
  assertRunnerCredential,
  loadRepositoryReadToken,
  loadRunnerEnvironment,
  RunnerCredentialError,
} from "~/domain/projects/runner-credentials.js";
import {
  RUN_CONFIGURATION_ERROR_TYPE,
  RunConfigurationError,
} from "~/domain/runs/run-configuration-error.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";

describe("assertRunnerCredential", () => {
  it("accepts a model provider credential", () => {
    expect(() => assertRunnerCredential("ANTHROPIC_API_KEY", `sk-ant-${"a".repeat(40)}`)).not.toThrow();
    expect(() => assertRunnerCredential("DEEPSEEK_API_KEY", `sk-${"b".repeat(32)}`)).not.toThrow();
    expect(() => assertRunnerCredential("OPENCODE_API_KEY", "opencode-zen-value-0123456789")).not.toThrow();
  });

  it("rejects a GitHub or a Linear credential, whatever the name is", () => {
    expect(() => assertRunnerCredential("MODEL_KEY", `ghp_${"c".repeat(36)}`)).toThrow(RunnerCredentialError);
    expect(() => assertRunnerCredential("MODEL_KEY", `github_pat_${"d".repeat(30)}`)).toThrow(
      RunnerCredentialError,
    );
    expect(() => assertRunnerCredential("MODEL_KEY", `lin_api_${"e".repeat(30)}`)).toThrow(
      RunnerCredentialError,
    );
  });

  it("rejects a name that SDD section 30 forbids", () => {
    expect(() => assertRunnerCredential("PRODUCTION_MODEL_KEY", "plain-value")).toThrow(
      RunnerCredentialError,
    );
    expect(() => assertRunnerCredential("FACTOREE_MODEL_KEY", "plain-value")).toThrow(
      RunnerCredentialError,
    );
  });

  it("names the secret without ever naming its value", () => {
    const value = `ghp_${"f".repeat(36)}`;
    try {
      assertRunnerCredential("MODEL_KEY", value);
      expect.unreachable("the guard must reject a GitHub token");
    } catch (error) {
      expect((error as Error).message).toContain("MODEL_KEY");
      expect((error as Error).message).not.toContain(value);
    }
  });
});

describe("loadRunnerEnvironment", () => {
  it("returns the runner credentials only", async () => {
    const secrets = new MemorySecretStore({
      OPENCODE_API_KEY: { value: "zen-value", injectIntoImplementer: false, kind: "runner_credential" },
      FIXTURE_URL: { value: "https://fixture.test", injectIntoImplementer: true, kind: "test" },
      GITHUB_TOKEN: { value: `ghp_${"g".repeat(36)}`, injectIntoImplementer: false, kind: "publish" },
    });

    await expect(loadRunnerEnvironment(secrets, "t", "p")).resolves.toEqual({
      OPENCODE_API_KEY: "zen-value",
    });
  });

  it("returns an empty environment when the Project holds no runner credential", async () => {
    const secrets = new MemorySecretStore({ FIXTURE_URL: "https://fixture.test" });
    await expect(loadRunnerEnvironment(secrets, "t", "p")).resolves.toEqual({});
  });
});

describe("loadRepositoryReadToken", () => {
  it("returns the read-only repository token, and null without one", async () => {
    const withToken = new MemorySecretStore({
      GITHUB_READ_TOKEN: { value: "read-value", injectIntoImplementer: false, kind: "repository_read" },
    });
    await expect(loadRepositoryReadToken(withToken, "t", "p")).resolves.toBe("read-value");

    const without = new MemorySecretStore({ FIXTURE_URL: "https://fixture.test" });
    await expect(loadRepositoryReadToken(without, "t", "p")).resolves.toBeNull();
  });
});

describe("the runner credential fault type", () => {
  it("is a Run configuration fault, so no retry repeats it", () => {
    try {
      assertRunnerCredential("MODEL_KEY", `ghp_${"h".repeat(36)}`);
      expect.unreachable("the guard must reject a GitHub token");
    } catch (error) {
      expect(error).toBeInstanceOf(RunConfigurationError);
      // The Temporal converter reads the name, and the workflow lists it as non-retryable.
      expect((error as Error).name).toBe(RUN_CONFIGURATION_ERROR_TYPE);
    }
  });
});
