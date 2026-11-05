import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalProcessSandbox } from "~/adapters/sandbox/local/local-process-sandbox.js";
import { runUserValidation } from "~/domain/validation/user-validator.js";
import type { UserValidatorDependencies } from "~/domain/validation/user-validator.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import type { BrowserDriver } from "~/domain/validation/browser-driver.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import { writePreviewFixtureApp } from "./support/preview-fixture-app.js";
import { pickPort, realHttpFetch, realProbe } from "./support/preview-fixture-helpers.js";

/** A BrowserDriver double that fails the test if the http-only contract below ever calls it. */
class UnusedBrowserDriver implements BrowserDriver {
  signIn = (): Promise<never> => Promise.reject(new Error("this fake signs in no account"));
  readonly name = "unused";
  run(): ReturnType<BrowserDriver["run"]> {
    throw new Error("AT-19 holds no browser assertion; the driver must never run.");
  }
}

const SECRET_BODY_VALUE = "super-secret-value";
const SECRET_HEADER_VALUE = "shhh-token-do-not-persist";

/**
 * AT-19, SDD section 38. One HTTP assertion against a real preview process records the method,
 * the path, the sanitized request, the response status, and the pass or fail result, and a
 * sensitive value never reaches the evidence bytes.
 */
describe("AT-19 — HTTP evidence records sanitized request and response fields", () => {
  let root: string;
  let sandboxRoot: string;
  let sandbox: LocalProcessSandbox;

  afterEach(async () => {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("records the method, the path, the sanitized request, the status, and the result, and holds no secret", async () => {
    const port = await pickPort();
    sandboxRoot = await mkdtemp(join(tmpdir(), "factoree-at19-sandbox-"));
    sandbox = new LocalProcessSandbox({ rootDirectory: sandboxRoot });
    const ref = await sandbox.create({ runId: "at19-run", tenantId: "at19-tenant", productId: "at19-project" });
    root = ref.workspacePath;
    await writePreviewFixtureApp({ root, persistName: true });

    const redactor = new Redactor();
    redactor.addSecret(SECRET_BODY_VALUE);

    const contract: ValidationContract = {
      version: 1,
      runId: "at19-run",
      workItem: "AT-19",
      goal: "An editor request without an editor header is refused.",
      assertions: [
        {
          id: "VAL-API-001",
          requirement: "AC-1",
          statement: "PATCH /projects/1 without an x-editor header returns 403.",
          method: "http",
          evidence: ["request-response"],
          preconditions: [],
        },
      ],
    };

    const planText = JSON.stringify({
      version: 1,
      entries: [
        {
          assertionId: "VAL-API-001",
          kind: "http",
          request: {
            method: "PATCH",
            path: "/projects/1",
            headers: {
              Authorization: `Bearer ${SECRET_HEADER_VALUE}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ note: SECRET_BODY_VALUE }),
            expectStatus: 403,
            expectBodyContains: null,
          },
        },
      ],
    });

    const dependencies: UserValidatorDependencies = {
      sandbox,
      browser: new UnusedBrowserDriver(),
      fetchImpl: realHttpFetch,
      probe: realProbe,
      redactor,
      logger: createLogger({ level: "error", redactor, sink: () => undefined }),
    };

    try {
      const outcome = await runUserValidation(dependencies, {
        runId: "at19-run",
        tenantId: "at19-tenant",
        ref,
        primaryPath: root,
        contract,
        preview: {
          enabled: true,
          command: "node server.cjs",
          readyUrl: `http://127.0.0.1:${port}/health`,
          timeoutSeconds: 30,
        },
        planText,
        environment: { PORT: String(port) },
        timeoutMs: 30_000,
      });

      expect(outcome.outcomes).toHaveLength(1);
      expect(outcome.outcomes[0]!.result).toBe("PASS");

      const artifact = outcome.outcomes[0]!.artifacts.find((a) => a.kind === "request-response");
      expect(artifact).toBeDefined();
      expect(artifact!.metadata).toMatchObject({
        method: "PATCH",
        path: "/projects/1",
        status: 403,
        expectStatus: 403,
        passed: true,
      });

      // SDD section 38. A sensitive value never reaches persistence.
      const text = new TextDecoder().decode(artifact!.bytes);
      expect(text).not.toContain(SECRET_BODY_VALUE);
      expect(text).not.toContain(SECRET_HEADER_VALUE);
      expect(text).toContain("[REDACTED]");
      expect(text.toLowerCase()).toContain("redacted");
    } finally {
      await sandbox.destroy(ref);
    }
  }, 60_000);
});
