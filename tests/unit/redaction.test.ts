import { describe, expect, it } from "vitest";
import { Redactor } from "~/telemetry/redaction.js";

describe("Redactor", () => {
  it("removes an exact configured secret value", () => {
    const redactor = new Redactor(["s3cr3t-project-value"]);
    const result = redactor.redact({ note: "value is s3cr3t-project-value here" });
    expect(JSON.stringify(result)).not.toContain("s3cr3t-project-value");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("removes GitHub token patterns", () => {
    const redactor = new Redactor();
    const line = redactor.redact("token ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(line).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("removes model provider key patterns", () => {
    const redactor = new Redactor();
    const line = redactor.redact("key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(line).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("removes an authorization header field by name", () => {
    const redactor = new Redactor();
    const result = redactor.redact({ headers: { authorization: "Bearer abc123", "x-ok": "keep" } });
    expect(result.headers.authorization).toBe("[REDACTED]");
    expect(result.headers["x-ok"]).toBe("keep");
  });

  it("removes a Linear OAuth token pattern", () => {
    const redactor = new Redactor();
    const line = redactor.redact("lin_oauth_0123456789abcdef0123456789abcdef0123456789abcdef");
    expect(line).not.toContain("0123456789abcdef");
  });

  it("keeps unrelated content", () => {
    const redactor = new Redactor(["nope"]);
    expect(redactor.redact("plain message")).toBe("plain message");
  });

  it("ignores empty or very short secret values", () => {
    const redactor = new Redactor(["", "a"]);
    expect(redactor.redact("a plain message")).toBe("a plain message");
  });

  it("registers a four character secret and ignores a three character value", () => {
    const redactor = new Redactor(["pw12", "abc"]);
    expect(redactor.redact("pw12")).toBe("[REDACTED]");
    expect(redactor.redact("abc")).toBe("abc");
  });
});
