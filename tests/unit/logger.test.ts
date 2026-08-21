import { describe, expect, it } from "vitest";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";

const capture = () => {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
};

describe("createLogger", () => {
  it("writes one JSON object per line with level, message, and time", () => {
    const { lines, sink } = capture();
    createLogger({ level: "info", redactor: new Redactor(), sink }).info("started");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("started");
    expect(typeof entry.time).toBe("string");
  });

  it("keeps the required context fields", () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: "info", redactor: new Redactor(), sink });
    logger.child({ tenant_id: "t1", project_id: "p1", run_id: "r1" }).info("step", { step: "receive" });
    const entry = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(entry.tenant_id).toBe("t1");
    expect(entry.project_id).toBe("p1");
    expect(entry.run_id).toBe("r1");
    expect(entry.step).toBe("receive");
  });

  it("redacts secret values in the message and in the fields", () => {
    const { lines, sink } = capture();
    const redactor = new Redactor(["top-secret-value"]);
    const logger = createLogger({ level: "info", redactor, sink });
    logger.info("saw top-secret-value", { token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    const raw = lines[0] ?? "";
    expect(raw).not.toContain("top-secret-value");
    expect(raw).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("drops entries below the configured level", () => {
    const { lines, sink } = capture();
    createLogger({ level: "warn", redactor: new Redactor(), sink }).info("ignored");
    expect(lines).toHaveLength(0);
  });
});
