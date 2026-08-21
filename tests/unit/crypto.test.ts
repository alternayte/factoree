import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "~/domain/policy/crypto.js";

const key = "a".repeat(64);

describe("secret encryption", () => {
  it("returns the original value after a round trip", () => {
    const cipher = encryptSecret("super-secret", key);
    expect(decryptSecret(cipher, key)).toBe("super-secret");
  });

  it("never stores the plaintext in the cipher text", () => {
    expect(encryptSecret("super-secret", key)).not.toContain("super-secret");
  });

  it("produces a different cipher text for the same input", () => {
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });

  it("rejects a modified cipher text", () => {
    const cipher = encryptSecret("super-secret", key);
    const parts = cipher.split(".");
    const broken = [parts[0], parts[1], parts[2], Buffer.from("tampered").toString("base64")].join(".");
    expect(() => decryptSecret(broken, key)).toThrow();
  });

  it("rejects a key of the wrong size", () => {
    expect(() => encryptSecret("value", "abcd")).toThrow();
  });
});
