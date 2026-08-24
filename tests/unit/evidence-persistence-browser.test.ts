import { describe, expect, it } from "vitest";
import { createEvidencePersistence } from "~/activities/evidence.activities.js";
import type {
  EvidenceRecord,
  EvidenceStore,
  RecordEvidenceInput,
} from "~/domain/evidence/evidence.js";
import type {
  EvidenceStorage,
  PutArtifactInput,
  StoredArtifact,
} from "~/domain/evidence/evidence-storage.js";
import type {
  RecordAssertionResultInput,
  ValidationAssertionResultRecord,
  ValidationResultStore,
} from "~/domain/validation/validation-result-store.js";
import type { AssertionOutcome } from "~/domain/validation/validation-result.js";
import { runUserValidation } from "~/domain/validation/user-validator.js";
import type { UserValidatorDependencies } from "~/domain/validation/user-validator.js";
import type {
  BrowserDriver,
  BrowserRunResult,
  BrowserScenario,
} from "~/domain/validation/browser-driver.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

/** An evidence store that keeps the SDD section 39 idempotency rule of the real store. */
class FakeEvidenceStore implements EvidenceStore {
  readonly rows: EvidenceRecord[] = [];
  private readonly byKey = new Map<string, EvidenceRecord>();

  record(input: RecordEvidenceInput): Promise<EvidenceRecord> {
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing !== undefined) return Promise.resolve(existing);
    const row: EvidenceRecord = {
      id: `evidence-${String(this.rows.length + 1)}`,
      tenantId: input.tenantId,
      runId: input.runId,
      validationAssertionId: input.validationAssertionId ?? null,
      kind: input.kind,
      source: input.source,
      createdAt: new Date(0),
      sha256: input.sha256,
      storageRef: input.storageRef ?? null,
      metadata: input.metadata,
    };
    this.rows.push(row);
    this.byKey.set(input.idempotencyKey, row);
    return Promise.resolve(row);
  }

  listForRun(): Promise<EvidenceRecord[]> {
    return Promise.resolve(this.rows);
  }
}

class FakeStorage implements EvidenceStorage {
  readonly name = "fake";
  readonly puts: PutArtifactInput[] = [];

  put(input: PutArtifactInput): Promise<StoredArtifact> {
    this.puts.push(input);
    return Promise.resolve({
      storageRef: `fake://${String(this.puts.length)}`,
      sha256: `sha-${String(this.puts.length)}`,
      byteLength: input.bytes.byteLength,
    });
  }
}

class FakeResultStore implements ValidationResultStore {
  record(input: RecordAssertionResultInput): Promise<ValidationAssertionResultRecord> {
    return Promise.resolve({
      id: "result-1",
      tenantId: input.tenantId,
      runId: input.runId,
      validationAssertionId: input.validationAssertionId,
      assertionKey: input.assertionKey,
      result: input.result,
      reason: input.reason,
      attempt: input.attempt,
      createdAt: new Date(0),
    });
  }

  listForRun(): Promise<ValidationAssertionResultRecord[]> {
    return Promise.resolve([]);
  }
}

const contract: ValidationContract = {
  version: 1,
  runId: "run-1",
  workItem: "FAC-1",
  goal: "Ship the dashboard.",
  assertions: [
    {
      id: "VAL-UI-001",
      requirement: "AC-1",
      statement: "The dashboard shows the name after reload.",
      method: "browser",
      evidence: ["screenshot"],
      preconditions: [],
    },
  ],
};

/** A run that captured one named screenshot and the final screenshot the driver always adds. */
class TwoScreenshotBrowserDriver implements BrowserDriver {
  readonly name = "two-screenshots";

  run(_scenario: BrowserScenario): Promise<BrowserRunResult> {
    void _scenario;
    return Promise.resolve({
      passed: true,
      steps: [{ index: 0, action: "goto", passed: true, detail: "navigated to /" }],
      consoleLines: [],
      network: [],
      artifacts: [
        {
          kind: "screenshot",
          name: "after-reload",
          contentType: "image/png",
          bytes: new Uint8Array([1]),
        },
        { kind: "screenshot", name: "final", contentType: "image/png", bytes: new Uint8Array([2]) },
      ],
      failureReason: null,
    });
  }
}

const planText = JSON.stringify({
  version: 1,
  entries: [
    {
      assertionId: "VAL-UI-001",
      kind: "browser",
      steps: [
        { action: "goto", path: "/" },
        { action: "expectText", selector: "h1", text: "Welcome" },
        { action: "screenshot", name: "after-reload" },
      ],
    },
  ],
});

const browserOutcome = async (): Promise<AssertionOutcome> => {
  const dependencies: UserValidatorDependencies = {
    sandbox: new FakeSandbox(),
    browser: new TwoScreenshotBrowserDriver(),
    fetchImpl: () => Promise.resolve({ status: 200, headers: {}, body: "ok" }),
    probe: () => Promise.resolve({ status: 200 }),
    redactor: new Redactor(),
    logger: createLogger({ level: "error", redactor: new Redactor() }),
  };
  const summary = await runUserValidation(dependencies, {
    runId: "run-1",
    tenantId: "tenant-1",
    ref: { id: "sandbox-1", adapter: "fake", workspacePath: "/workspace" },
    primaryPath: "/workspace/primary",
    contract,
    preview: {
      enabled: true,
      command: "npm run dev -- --port 8080",
      readyUrl: "http://127.0.0.1:8080/health",
      timeoutSeconds: 5,
    },
    planText,
    environment: {},
    timeoutMs: 5_000,
  });
  return summary.outcomes[0]!;
};

/**
 * SDD section 39. Each artefact records its own evidence row. The evidence idempotency key
 * derives from the artefact source, so two screenshots of one assertion must not share a source.
 */
describe("evidence persistence of a browser assertion", () => {
  it("writes one evidence row for the named screenshot and one for the final screenshot", async () => {
    const outcome = await browserOutcome();
    const screenshots = outcome.artifacts.filter((artifact) => artifact.kind === "screenshot");
    expect(screenshots).toHaveLength(2);
    expect(new Set(screenshots.map((artifact) => artifact.source)).size).toBe(2);

    const evidence = new FakeEvidenceStore();
    const storage = new FakeStorage();
    const persistence = createEvidencePersistence({
      evidence,
      storage,
      results: new FakeResultStore(),
      logger: createLogger({ level: "error", redactor: new Redactor() }),
    });

    await persistence.persistAssertionOutcome({
      tenantId: "tenant-1",
      runId: "run-1",
      validationAssertionId: "assertion-row-1",
      outcome,
      attempt: 1,
    });

    const screenshotRows = evidence.rows.filter((row) => row.kind === "screenshot");
    expect(screenshotRows).toHaveLength(2);
    expect(screenshotRows.map((row) => row.metadata["name"]).sort()).toEqual([
      "after-reload",
      "final",
    ]);
    expect(screenshotRows.map((row) => row.sha256).sort()).toEqual(["sha-1", "sha-2"]);
  });
});
