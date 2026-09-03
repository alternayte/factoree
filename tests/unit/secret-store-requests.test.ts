import { describe, expect, it } from "vitest";
import { assertRequestedSecretsExist, MissingSecretError } from "~/domain/products/secret-store.js";

describe("assertRequestedSecretsExist", () => {
  it("fails, and names every absent secret, when a repository requests one the Product lacks", () => {
    expect(() => assertRequestedSecretsExist(["A", "B"], ["A"])).toThrowError(/B/);
  });

  it("names every absent secret, not only the first", () => {
    try {
      assertRequestedSecretsExist(["A", "B", "C"], []);
      throw new Error("expected assertRequestedSecretsExist to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingSecretError);
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("A");
      expect(message).toContain("B");
      expect(message).toContain("C");
    }
  });

  it("passes when every requested secret exists", () => {
    expect(() => assertRequestedSecretsExist(["A"], ["A", "B"])).not.toThrow();
  });

  it("passes when a repository requests no secret", () => {
    expect(() => assertRequestedSecretsExist([], [])).not.toThrow();
  });
});
