import { describe, expect, it } from "vitest";
import { registerProjectSecrets } from "~/domain/projects/redaction-loader.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";

const store = (values: Record<string, string>): SecretStore => ({
  put: () => Promise.resolve(),
  get: (_t, _p, name) => Promise.resolve(values[name] ?? null),
  listNames: () => Promise.resolve(Object.keys(values)),
  remove: () => Promise.resolve(true),
});

describe("registerProjectSecrets", () => {
  it("adds every Project secret value to the redactor", async () => {
    const redactor = new Redactor();
    const count = await registerProjectSecrets(redactor, store({ A: "alpha-secret", B: "beta-secret" }), "t", "p");
    expect(count).toBe(2);
    expect(redactor.redact("alpha-secret and beta-secret")).toBe("[REDACTED] and [REDACTED]");
  });

  it("skips a name whose value is missing", async () => {
    const redactor = new Redactor();
    const missing: SecretStore = { ...store({}), listNames: () => Promise.resolve(["A"]) };
    expect(await registerProjectSecrets(redactor, missing, "t", "p")).toBe(0);
  });

  it("registers a short secret, because a short secret still leaks", async () => {
    const redactor = new Redactor();
    await registerProjectSecrets(redactor, store({ A: "pw12" }), "t", "p");
    expect(redactor.redact("the value is pw12")).toBe("the value is [REDACTED]");
  });

  it("never returns the secret values to the caller", async () => {
    const redactor = new Redactor();
    const result = await registerProjectSecrets(redactor, store({ A: "alpha-secret" }), "t", "p");
    expect(typeof result).toBe("number");
  });
});
