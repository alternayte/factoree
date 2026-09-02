import { describe, expect, it } from "vitest";
import { Redactor } from "~/telemetry/redaction.js";
import { renderProofPack } from "~/domain/evidence/proof-pack.js";
import { createLogger } from "~/telemetry/logger.js";
import { registerProjectSecrets } from "~/domain/projects/redaction-loader.js";
import type { SecretStore } from "~/domain/projects/secret-store.js";

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

  it("keeps a bearer token out of a free-text log message", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      redactor: new Redactor(),
      sink: (line) => lines.push(line),
    });
    logger.info("agent ran: curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345' https://api.example.com");
    expect(lines.join("")).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
  });

  it("AT-32: a Project secret loaded from the SecretStore never reaches a log line", async () => {
    const redactor = new Redactor();
    const store: SecretStore = {
      put: () => Promise.resolve(),
      get: () => Promise.resolve("fixture-secret-value"),
      listNames: () => Promise.resolve(["FIXTURE"]),
      list: () => Promise.resolve([{ name: "FIXTURE", injectIntoImplementer: false, kind: "test" as const }]),
      remove: () => Promise.resolve(true),
    };
    await registerProjectSecrets(redactor, store, "tenant-1", "project-1");
    const lines: string[] = [];
    const logger = createLogger({ level: "info", redactor, sink: (line) => lines.push(line) });
    logger.info("the agent printed fixture-secret-value");
    expect(lines.join("\n")).not.toContain("fixture-secret-value");
  });
});

describe("AT-32 redaction in the Proof Pack", () => {
  it("keeps a deliberately printed fixture secret out of the Proof Pack", () => {
    const redactor = new Redactor(["fixture-secret-value-12345"]);
    // Every free text field a Proof Pack can carry holds the fixture secret. A field the
    // renderer forgets would let the secret escape a real Run, so all of them are loaded here.
    const body = redactor.redactText(
      renderProofPack({
        runId: "run-1",
        workItem: { title: "fixture-secret-value-12345", url: null },
        pullRequestUrl: "https://github.com/acme/fixture/pull/1",
        assertions: [
          {
            id: "VAL-API-001",
            requirement: "AC-1",
            statement: "fixture-secret-value-12345",
            method: "http",
            requiredEvidence: ["request-response"],
            result: "PASS",
            reason: "fixture-secret-value-12345",
            evidence: [
              {
                kind: "request-response",
                source: "fixture-secret-value-12345",
                sha256: "a".repeat(64),
                storageRef: "fixture-secret-value-12345",
              },
            ],
          },
        ],
        checks: [
          {
            name: "unit",
            command: "echo fixture-secret-value-12345",
            exitCode: 0,
            passed: true,
            durationMs: 1,
            stdoutSha256: "b".repeat(64),
            stderrSha256: "c".repeat(64),
          },
        ],
        reviewVerdict: "pass",
        reviewPasses: 1,
        findings: [
          {
            id: "RV-2",
            severity: "low",
            category: "style",
            requirement: "AC-1",
            evidence: "fixture-secret-value-12345",
            description: "fixture-secret-value-12345",
            blocking: false,
            decisionReason: "fixture-secret-value-12345",
            attempt: 1,
          },
        ],
        contextItems: [
          {
            ref: "fixture-secret-value-12345",
            authority: "repository_readme",
            classification: "required",
            sourceVersion: "fixture-secret-value-12345",
            contentSha256: null,
            reason: "fixture-secret-value-12345",
          },
        ],
        discoverableItemCount: 0,
        conflicts: [
          {
            id: "CTX-1",
            subject: "fixture-secret-value-12345",
            winnerRef: "fixture-secret-value-12345",
            loserRef: "fixture-secret-value-12345",
            reason: "fixture-secret-value-12345",
          },
        ],
        changedFiles: ["fixture-secret-value-12345.ts"],
        patchByteLength: 1,
        previewUrl: "http://localhost:1/fixture-secret-value-12345",
        baseSha: "d".repeat(40),
        patchSha256: "e".repeat(64),
        commitSha: "f".repeat(40),
        repairCount: 0,
        repairLimit: 2,
      }),
    );
    expect(body).not.toContain("fixture-secret-value-12345");
  });
});
