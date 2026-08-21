import { describe, expect, it } from "vitest";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";

describe("AT-32 redaction in logs", () => {
  it("keeps a configured project secret out of every log line", () => {
    const lines: string[] = [];
    const redactor = new Redactor(["fixture-secret-value-12345"]);
    const logger = createLogger({ level: "debug", redactor, sink: (line) => lines.push(line) });

    logger.info("agent printed fixture-secret-value-12345 to stdout", {
      run_id: "run-1",
      output: "echo fixture-secret-value-12345",
      headers: { authorization: "Bearer abcdefghijklmnop" },
    });
    logger.error("failure", { error: new Error("token fixture-secret-value-12345 rejected") });

    const all = lines.join("\n");
    expect(all).not.toContain("fixture-secret-value-12345");
    expect(all).not.toContain("Bearer abcdefghijklmnop");
    expect(all).toContain("run-1");
  });

  it("redacts a secret added after the logger was created", () => {
    const lines: string[] = [];
    const redactor = new Redactor();
    const logger = createLogger({ level: "debug", redactor, sink: (line) => lines.push(line) });
    redactor.addSecret("late-added-secret-value");
    logger.info("value late-added-secret-value");
    expect(lines.join("")).not.toContain("late-added-secret-value");
  });
});
