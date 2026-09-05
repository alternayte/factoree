import { describe, expect, it } from "vitest";
import { assertSecretKindAndMark, ProjectSecretKindError } from "~/domain/products/secret-store.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";

describe("the Project secret kind", () => {
  it("permits the injection mark on a test secret", () => {
    expect(() => assertSecretKindAndMark("test", true)).not.toThrow();
    expect(() => assertSecretKindAndMark("test", false)).not.toThrow();
  });

  it("refuses the injection mark on every other kind", () => {
    expect(() => assertSecretKindAndMark("runner_credential", true)).toThrow(ProjectSecretKindError);
    expect(() => assertSecretKindAndMark("repository_read", true)).toThrow(ProjectSecretKindError);
    expect(() => assertSecretKindAndMark("publish", true)).toThrow(ProjectSecretKindError);
    expect(() => assertSecretKindAndMark("runner_credential", false)).not.toThrow();
  });

  it("refuses the combination at the store, so no row can hold it", async () => {
    const secrets = new MemorySecretStore();
    await expect(
      secrets.put("t", "p", "OPENCODE_API_KEY", "zen-value", {
        kind: "runner_credential",
        injectIntoImplementer: true,
      }),
    ).rejects.toThrow(ProjectSecretKindError);
  });

  it("defaults a secret to the test kind", async () => {
    const secrets = new MemorySecretStore();
    await secrets.put("t", "p", "FIXTURE_URL", "https://fixture.test");
    await expect(secrets.list()).resolves.toEqual([
      { name: "FIXTURE_URL", injectIntoImplementer: false, kind: "test" },
    ]);
  });
});
