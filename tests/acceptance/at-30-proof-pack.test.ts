import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProofPackActivities } from "~/activities/evidence.activities.js";
import type { PublishProofPackActivityInput } from "~/activities/evidence.activities.js";
import { hashValidationContract } from "~/domain/validation/validation-contract.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import { hashContextContract } from "~/domain/context/context-contract.js";
import type { ContextContract } from "~/domain/context/context-contract.js";
import { PrismaEvidenceStore } from "~/persistence/prisma/evidence.prisma.js";
import { PrismaValidationResultStore } from "~/persistence/prisma/validation-result.prisma.js";
import { PrismaValidationContractStore } from "~/persistence/prisma/validation-contract.prisma.js";
import { PrismaContextContractStore } from "~/persistence/prisma/context-contract.prisma.js";
import { PrismaReviewFindingStore } from "~/persistence/prisma/review-finding.prisma.js";
import { PrismaRunRepository } from "~/persistence/prisma/run-repository.prisma.js";
import {
  PrismaProductRegistry,
  PrismaRepositoryRegistry,
} from "~/persistence/prisma/product-registry.prisma.js";
import { createPrismaClient, type FactoreePrismaClient } from "~/persistence/prisma/client.js";
import { createLogger } from "~/telemetry/logger.js";
import { Redactor } from "~/telemetry/redaction.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";
import { startDatabase, seedTenantProjectAndRun } from "../integration/support/database.js";

let database: { url: string; stop: () => Promise<void> };
let prisma: FactoreePrismaClient;

beforeAll(async () => {
  database = await startDatabase();
  prisma = createPrismaClient(database.url);
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
  await database.stop();
});

const SECRET = "fixture-secret-value-12345";

/** Builds one Run whose persisted state is the state a successful L3 Run leaves behind. */
const seedProvedRun = async (
  options: { changedFileCount?: number; silentPassingReview?: boolean } = {},
) => {
  const { tenantId, runId, productId } = await seedTenantProjectAndRun(prisma);
  const contracts = new PrismaValidationContractStore(prisma);
  const contextContracts = new PrismaContextContractStore(prisma);
  const results = new PrismaValidationResultStore(prisma);
  const evidence = new PrismaEvidenceStore(prisma);
  const reviewFindings = new PrismaReviewFindingStore(prisma);
  const runs = new PrismaRunRepository(prisma);

  const contract: ValidationContract = {
    version: 1,
    runId,
    workItem: "ENG-143",
    goal: "Add the health endpoint.",
    assertions: [
      {
        id: "VAL-API-001",
        requirement: "AC-1",
        statement: "GET /health returns 200.",
        method: "http",
        evidence: ["request-response"],
        preconditions: [],
      },
      {
        id: "VAL-UI-001",
        requirement: "AC-2",
        statement: "The status page shows the healthy state after a reload.",
        method: "browser",
        evidence: ["screenshot"],
        preconditions: [],
      },
    ],
  };
  const storedContract = await contracts.save({
    tenantId,
    runId,
    contract,
    sha256: hashValidationContract(contract),
    document: "# Validation Contract\n",
  });

  const contextContract: ContextContract = {
    version: 1,
    runId,
    goal: "Add the health endpoint.",
    primaryRepository: { repo: "acme/fixture", sha: "0".repeat(40) },
    referenceRepositories: [],
    items: [
      {
        reference: {
          sourceId: "repository",
          ref: "github:acme/fixture/README.md",
          repository: "acme/fixture",
          sha: "0".repeat(40),
          path: "README.md",
        },
        sourceVersion: "0".repeat(40),
        authority: "repository_readme",
        reason: "it states the health endpoint contract",
        classification: "required",
        topics: ["health"],
        contentSha256: "c".repeat(64),
      },
      {
        reference: {
          sourceId: "repository",
          ref: "github:acme/fixture/docs/big.md",
          repository: "acme/fixture",
          sha: "0".repeat(40),
          path: "docs/big.md",
        },
        sourceVersion: "0".repeat(40),
        authority: "prose_documentation",
        reason: "it is too large to preload",
        classification: "discoverable",
        topics: ["health"],
        contentSha256: null,
      },
    ],
    conflicts: [
      {
        id: "CTX-4",
        subject: "notification ownership",
        authorityDomain: "architecture_intent",
        winnerRef: "ADR-031",
        loserRef: "README.md",
        reason: "an accepted ADR has higher architecture authority",
        resolution: "resolved",
      },
    ],
  };
  await contextContracts.save({
    tenantId,
    runId,
    contract: contextContract,
    sha256: hashContextContract(contextContract),
    document: "# Context Contract\n",
  });

  const api = storedContract.assertions.find((entry) => entry.id === "VAL-API-001")!;
  const ui = storedContract.assertions.find((entry) => entry.id === "VAL-UI-001")!;

  // Attempt 1 failed, and the repair of attempt 2 fixed it. The Proof Pack must report the
  // outcome of the last attempt only.
  await results.record({
    tenantId,
    runId,
    validationAssertionId: api.rowId,
    assertionKey: "VAL-API-001",
    result: "FAIL",
    reason: "The endpoint answered 500.",
    attempt: 1,
  });
  await results.record({
    tenantId,
    runId,
    validationAssertionId: api.rowId,
    assertionKey: "VAL-API-001",
    result: "PASS",
    reason: `The endpoint answered 200 while the token ${SECRET} was set.`,
    attempt: 2,
  });
  await results.record({
    tenantId,
    runId,
    validationAssertionId: ui.rowId,
    assertionKey: "VAL-UI-001",
    result: "PASS",
    reason: "The status page showed the healthy state after a reload.",
    attempt: 2,
  });

  // The failed attempt 1 of VAL-API-001 produced its own artefact. It stays in the database,
  // because SDD section 39 makes evidence immutable.
  await evidence.record({
    tenantId,
    runId,
    validationAssertionId: api.rowId,
    kind: "request-response",
    source: "http:VAL-API-001:request-response",
    sha256: "6".repeat(64),
    storageRef: "file:VAL-API-001-FAILED-attempt-1.json",
    metadata: { attempt: 1 },
    idempotencyKey: `run:${runId}:validation:1:VAL-API-001:http`,
  });
  await evidence.record({
    tenantId,
    runId,
    validationAssertionId: api.rowId,
    kind: "request-response",
    source: "http:VAL-API-001:request-response",
    sha256: "d".repeat(64),
    storageRef: "file:VAL-API-001-http-request-response.json",
    metadata: { attempt: 2 },
    idempotencyKey: `run:${runId}:validation:2:VAL-API-001:http`,
  });
  await evidence.record({
    tenantId,
    runId,
    validationAssertionId: ui.rowId,
    kind: "screenshot",
    source: "browser:VAL-UI-001:screenshot",
    sha256: "e".repeat(64),
    storageRef: "file:VAL-UI-001-browser-screenshot.png",
    metadata: { attempt: 2 },
    idempotencyKey: `run:${runId}:validation:2:VAL-UI-001:browser`,
  });
  // Attempt 1 failed its deterministic verification, and the repair of attempt 2 fixed it. Both
  // rows exist, exactly as `verify` writes them. The Proof Pack must report the last attempt.
  await evidence.record({
    tenantId,
    runId,
    validationAssertionId: null,
    kind: "deterministic_check",
    source: "verify:unit",
    sha256: "9".repeat(64),
    storageRef: null,
    metadata: {
      name: "unit",
      command: "npm test",
      exitCode: 1,
      passed: false,
      durationMs: 900,
      stdoutSha256: "7".repeat(64),
      stderrSha256: "8".repeat(64),
      attempt: 1,
      log: "IMPLEMENTER TRANSCRIPT LINE",
    },
    idempotencyKey: `run:${runId}:verify:1:unit`,
  });
  await evidence.record({
    tenantId,
    runId,
    validationAssertionId: null,
    kind: "deterministic_check",
    source: "verify:unit",
    sha256: "f".repeat(64),
    storageRef: null,
    metadata: {
      name: "unit",
      command: "npm test",
      exitCode: 0,
      passed: true,
      durationMs: 1200,
      stdoutSha256: "1".repeat(64),
      stderrSha256: "2".repeat(64),
      attempt: 2,
      // SDD section 47 forbids a raw log dump into Linear. The verify activity writes the
      // retained log here, so this value proves the rule rather than assume it.
      log: "IMPLEMENTER TRANSCRIPT LINE",
    },
    idempotencyKey: `run:${runId}:verify:2:unit`,
  });

  // The blocking finding of attempt 1 was repaired. The non-blocking finding of attempt 2 is a
  // known limitation a human must still weigh.
  await reviewFindings.record({
    tenantId,
    runId,
    attempt: 1,
    verdict: "fail",
    findingKey: "RV-1",
    severity: "blocker",
    category: "correctness",
    requirement: "AC-1",
    evidence: "src/health.ts:10",
    description: "The handler throws on an empty body.",
    blocking: true,
    decisionReason: "a blocker finding blocks by default",
  });
  if (options.silentPassingReview !== true) await reviewFindings.record({
    tenantId,
    runId,
    attempt: 2,
    verdict: "pass",
    findingKey: "RV-2",
    severity: "high",
    category: "performance",
    requirement: "AC-1",
    evidence: "src/health.ts:12",
    description: "The handler reads the whole table on every request.",
    blocking: false,
    decisionReason: "the finding names no mandatory requirement of this Work Item",
  });

  const redactor = new Redactor();
  const activities = createProofPackActivities({
    runs,
    products: new PrismaProductRegistry(prisma),
    repositories: new PrismaRepositoryRegistry(prisma),
    contextContracts,
    validationContracts: contracts,
    validationResults: results,
    evidence,
    reviewFindings,
    agentSession: {
      acknowledge: () => Promise.resolve(),
      progress: () => Promise.resolve(),
      elicit: () => Promise.resolve(),
      respond: (_sessionId: string, body: string) => {
        posted.push(body);
        return Promise.resolve();
      },
      fail: () => Promise.resolve(),
    },
    secrets: new MemorySecretStore({ API_TOKEN: SECRET }),
    redactor,
    logger: createLogger({ level: "error", redactor, sink: () => undefined }),
  });

  const changedFiles =
    options.changedFileCount === undefined
      ? ["src/health.ts", "tests/health.test.ts"]
      : Array.from({ length: options.changedFileCount }, (_, index) => `src/file-${index}.ts`);

  const input: PublishProofPackActivityInput = {
    runId,
    tenantId,
    productId,
    sessionId: "session-1",
    workItem: { title: "Add the health endpoint", url: "https://linear.app/acme/issue/ENG-143" },
    pullRequestUrl: "https://github.com/acme/fixture/pull/1",
    commitSha: "3".repeat(40),
    patchSha256: "4".repeat(64),
    baseSha: "5".repeat(40),
    changedFiles,
    patchByteLength: 812,
    previewUrl: null,
    repairCount: 1,
    repairLimit: 2,
    reviewVerdict: "pass",
    reviewPasses: 2,
    reviewAttempt: 2,
  };

  return { tenantId, runId, productId, activities, input, runs };
};

const posted: string[] = [];

/**
 * AT-30. A successful L3 Run creates one Proof Pack that carries the pull request, the
 * validation results, the evidence, the deterministic checks, the review result, the context
 * used, the context conflicts, the known limitations, the repair count, the base SHA, and the
 * patch hash. The test drives the real activity against a real database, so a missing section
 * cannot pass.
 */
describe("AT-30 — the Proof Pack of a successful L3 Run", () => {
  it("carries every one of the eleven AT-30 items", async () => {
    const before = posted.length;
    const seeded = await seedProvedRun();
    await seeded.activities.publishProofPack(seeded.input);
    const body = posted.slice(before).at(-1) ?? "";

    // 1. The pull request.
    expect(body).toContain("https://github.com/acme/fixture/pull/1");
    // 2. The validation results, one row per assertion.
    expect(body).toContain("| Assertion | Result | Evidence |");
    expect(body).toContain("| VAL-API-001 | PASS |");
    expect(body).toContain("| VAL-UI-001 | PASS |");
    // 3. The evidence of each assertion.
    expect(body).toContain("file:VAL-API-001-http-request-response.json");
    expect(body).toContain("file:VAL-UI-001-browser-screenshot.png");
    // 4. The deterministic checks.
    expect(body).toContain("npm test");
    expect(body).toContain("exit code 0");
    // 5. The review result.
    expect(body).toContain("The last Reviewer verdict was pass");
    expect(body).toContain("Blocking findings that remain: 0");
    // 6. The context used, with provenance.
    expect(body).toContain("github:acme/fixture/README.md");
    expect(body).toContain("authority repository_readme");
    // 7. The context conflicts.
    expect(body).toContain("CTX-4");
    expect(body).toContain("ADR-031");
    // 8. The known limitations.
    expect(body).toContain("RV-2");
    expect(body).toContain("the finding names no mandatory requirement");
    // 9. The repair count.
    expect(body).toContain("Repairs: 1 of 2");
    // 10. The base SHA.
    expect(body).toContain("5".repeat(40));
    // 11. The patch hash.
    expect(body).toContain("4".repeat(64));
  });

  it("states the success criterion of every assertion, so a human can audit it", async () => {
    const before = posted.length;
    const seeded = await seedProvedRun();
    await seeded.activities.publishProofPack(seeded.input);
    const body = posted.slice(before).at(-1) ?? "";

    expect(body).toContain("GET /health returns 200.");
    expect(body).toContain("The status page shows the healthy state after a reload.");
  });

  it("records the Proof Pack hash on the Run row", async () => {
    const seeded = await seedProvedRun();
    const output = await seeded.activities.publishProofPack(seeded.input);
    const run = await seeded.runs.findById(seeded.tenantId, seeded.runId);
    expect(run?.proofPackSha256).toBe(output.sha256);
    expect(run?.proofPackPostedAt).not.toBeNull();
  });

  it("reports the last attempt only, so a repaired defect is not reported as open", async () => {
    const before = posted.length;
    const seeded = await seedProvedRun();
    await seeded.activities.publishProofPack(seeded.input);
    const body = posted.slice(before).at(-1) ?? "";

    expect(body).not.toContain("RV-1");
    expect(body).not.toContain("The endpoint answered 500.");
  });

  it("keeps a project secret and the retained log out of the Proof Pack", async () => {
    const before = posted.length;
    const seeded = await seedProvedRun();
    await seeded.activities.publishProofPack(seeded.input);
    const body = posted.slice(before).at(-1) ?? "";

    // AT-32 and SDD section 60.
    expect(body).not.toContain(SECRET);
    // SDD section 47 forbids a raw log dump into Linear.
    expect(body).not.toContain("IMPLEMENTER TRANSCRIPT LINE");
  });

  it("reports the deterministic checks of the last attempt only", async () => {
    const before = posted.length;
    const seeded = await seedProvedRun();
    await seeded.activities.publishProofPack(seeded.input);
    const body = posted.slice(before).at(-1) ?? "";

    // A stale failing row of the repaired attempt would tell the human that a passing Run failed
    // its own verification.
    expect(body).toContain("exit code 0");
    expect(body).not.toContain("exit code 1");
    expect(body).not.toContain("Failed.");
    expect(body.match(/- unit:/g)).toHaveLength(1);
  });

  it("reports no open blocker when the last review passed and wrote no row", async () => {
    const before = posted.length;
    const seeded = await seedProvedRun({ silentPassingReview: true });
    await seeded.activities.publishProofPack(seeded.input);
    const body = posted.slice(before).at(-1) ?? "";

    // A passing review reports no finding, so it writes no row. Only the attempt 1 blocker
    // remains in the database. A Proof Pack that infers the last pass from the rows would tell
    // the human that a proved Run still carries a blocker.
    expect(body).toContain("Blocking findings that remain: 0");
    expect(body).not.toContain("RV-1");
    expect(body).toMatch(/### Known limitations\n\nNone\./);
  });

  it("shows the evidence of the last validation attempt only", async () => {
    const before = posted.length;
    const seeded = await seedProvedRun();
    await seeded.activities.publishProofPack(seeded.input);
    const body = posted.slice(before).at(-1) ?? "";

    // A failure artefact beside a PASS misleads the human who opens it.
    expect(body).toContain("file:VAL-API-001-http-request-response.json");
    expect(body).not.toContain("file:VAL-API-001-FAILED-attempt-1.json");
  });

  it("produces the same hash twice, because it is a function of recorded state", async () => {
    const seeded = await seedProvedRun();
    const first = await seeded.activities.publishProofPack(seeded.input);
    const second = await seeded.activities.publishProofPack(seeded.input);
    expect(second.sha256).toBe(first.sha256);
  });

  it("stays small enough for a human, even for a large change", async () => {
    const before = posted.length;
    const seeded = await seedProvedRun({ changedFileCount: 200 });
    await seeded.activities.publishProofPack(seeded.input);
    const body = posted.slice(before).at(-1) ?? "";

    // SDD section 47. The Proof Pack optimizes for one human decision, so it stays bounded.
    expect(body.length).toBeLessThan(60_000);
    expect(body).toContain("200 files");
    expect(body).toContain("150 more files");
  });
});
