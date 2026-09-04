import { describe, expect, it } from "vitest";
import { createContextActivities } from "~/activities/context.activities.js";
import { ContextResolver } from "~/domain/context/context-resolver.js";
import { ContextSourceRegistry } from "~/domain/context/context-source-registry.js";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import { RepositoryContextSource } from "~/domain/context/repository-source.js";
import { FakeContextContractStore } from "../support/fake-context-contract-store.js";
import { FakeRepositoryReader } from "../support/fake-repository-reader.js";
import { createLogger } from "~/telemetry/logger.js";
import { metrics } from "~/telemetry/metrics.js";
import { Redactor } from "~/telemetry/redaction.js";
import type { RunRepository } from "~/domain/runs/run-repository.js";
import type { ResolveContextActivityInput } from "~/activities/context.activities.js";
import { MemorySecretStore } from "../support/memory-secret-store.js";

const PRIMARY_URL = "https://git/acme/webhook-service";
const SHA_A = "a".repeat(40);

const build = (
  files: Record<string, string>,
  secrets = new MemorySecretStore(),
  tokens: { tokenForInstallation: (id: string, scope?: Record<string, string>) => Promise<string> } = {
    tokenForInstallation: () => Promise.reject(new Error("no installation configured in this fixture")),
  },
  redactor = new Redactor(),
) => {
  const reader = new FakeRepositoryReader({ [PRIMARY_URL]: { sha: SHA_A, files } });
  const contracts = new FakeContextContractStore();
  const versions: Array<{ tenantId: string; runId: string; version: string }> = [];
  const runs = {
    setContextContractVersion: (tenantId: string, runId: string, version: string): Promise<void> => {
      versions.push({ tenantId, runId, version });
      return Promise.resolve();
    },
  } as unknown as RunRepository;
  const activities = createContextActivities({
    resolver: new ContextResolver(),
    contracts,
    runs,
    logger: createLogger({ level: "error", redactor: new Redactor() }),
    sources: {
      sourcesFor: () =>
        Promise.resolve(
          new ContextSourceRegistry([
            new LinearContextSource(),
            new RepositoryContextSource({ reader }),
          ]),
        ),
    },
    repositoryReader: reader,
    secrets,
    tokens,
    redactor,
  });
  return { activities, contracts, versions, reader };
};

const input = (over: Partial<ResolveContextActivityInput> = {}): ResolveContextActivityInput => ({
  runId: "run-1",
  tenantId: "tenant-1",
  productId: "project-1",
  goal: "Retry a failed notification delivery.",
  acceptanceCriteria: ["A failed notification is retried."],
  primaryRepository: { slug: "acme/webhook-service", url: PRIMARY_URL, ref: "main" },
  referenceRepositories: [],
  workItemReferences: [],
  decisions: [],
  githubInstallationId: "",
  ...over,
});

const files = {
  "README.md": "# Service\n\nThe README claims notification retry lives here.\n",
  "docs/ADR-031.md": "Status: accepted. Notification retry lives elsewhere.\n",
  "src/retry.ts": "export const retry = () => undefined;\n",
};

const threeWayFiles = {
  "docs/ADR-031.md": "Status: accepted. Notification retry lives here.\n",
  "docs/ADR-042.md": "Status: accepted. Notification retry lives elsewhere.\n",
  "docs/ADR-055.md": "Status: accepted. Notification retry lives in a third place.\n",
};

const decision = {
  questionId: "CTX-1",
  question: "Which ADR governs notification retry?",
  answer: "ADR-031 governs notification retry.",
  // SDD section 23. The answer settles this subject in this authority domain, and no other pair.
  subject: "notification",
  domain: "architecture_intent" as const,
};

/**
 * Reads the recorded value of the counter from the registry. The test proves the value, not the
 * call, so a spy is not enough.
 */
const conflictTotal = async (tenantId: string): Promise<number> => {
  const all = await metrics.registry.getMetricsAsJSON();
  const metric = all.find((entry) => entry.name === "factoree_context_conflicts_total") as
    | { values: Array<{ labels: Record<string, string>; value: number }> }
    | undefined;
  return (metric?.values ?? [])
    .filter((entry) => entry.labels.tenant_id === tenantId)
    .reduce((total, entry) => total + entry.value, 0);
};

const conflictedFiles = {
  "docs/ADR-031.md": "Status: accepted. Notification retry lives here.\n",
  "docs/ADR-042.md": "Status: accepted. Notification retry lives elsewhere.\n",
};

describe("resolveContext activity", () => {
  it("returns the pinned SHA of the primary repository", async () => {
    const { activities } = build(files);
    const output = await activities.resolveContext(input());
    expect(output.primary).toEqual({ slug: "acme/webhook-service", sha: SHA_A });
  });

  it("persists the contract and records its hash on the Run", async () => {
    const { activities, contracts, versions } = build(files);
    const output = await activities.resolveContext(input());
    expect(contracts.all()).toHaveLength(1);
    expect(contracts.all()[0]?.sha256).toBe(output.sha256);
    expect(versions).toEqual([
      { tenantId: "tenant-1", runId: "run-1", version: output.sha256 },
    ]);
  });

  it("writes one contract only when the activity runs twice", async () => {
    const { activities, contracts } = build(files);
    const first = await activities.resolveContext(input());
    const second = await activities.resolveContext(input());
    expect(contracts.all()).toHaveLength(1);
    expect(second.sha256).toBe(first.sha256);
    expect(second).toEqual(first);
  });

  it("returns the required context lines and the rendered document", async () => {
    const { activities } = build(files);
    const output = await activities.resolveContext(input());
    expect(output.document).toContain("# Context Contract");
    expect(output.requiredContext.length).toBeGreaterThan(0);
  });

  it("reports a resolved conflict in the summary and no unresolved conflict", async () => {
    const { activities } = build(files);
    const output = await activities.resolveContext(input());
    expect(output.conflictCount).toBeGreaterThan(0);
    expect(output.unresolvedConflict).toBeNull();
    expect(output.summary).toMatch(/conflict/i);
  });

  it("reports an unresolved conflict with one focused question", async () => {
    const { activities } = build(conflictedFiles);
    const output = await activities.resolveContext(input());
    expect(output.unresolvedConflict?.subject).toBe("notification");
    expect(output.unresolvedConflict?.question.endsWith("?")).toBe(true);
  });

  it("names every pinned repository in the summary", async () => {
    const { activities } = build(files);
    const output = await activities.resolveContext(input());
    expect(output.summary).toContain("acme/webhook-service");
    expect(output.summary).toContain(SHA_A.slice(0, 7));
  });

  it("freezes no contract while a conflict stays unresolved", async () => {
    const { activities, contracts, versions } = build(conflictedFiles);
    const output = await activities.resolveContext(input());
    expect(contracts.all()).toHaveLength(0);
    expect(versions).toHaveLength(0);
    expect(output.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(output.document).toContain("# Context Contract");
    expect(output.unresolvedConflict).not.toBeNull();
  });

  it("says in the summary that the contract is not frozen, and why", async () => {
    const { activities } = build(conflictedFiles);
    const output = await activities.resolveContext(input());
    expect(output.summary).toMatch(/did not freeze/i);
    expect(output.summary).toMatch(/conflict is unresolved/i);
    // Nothing reached the store, so the summary must not claim a record. It reports a find.
    expect(output.summary).toMatch(/\d+ conflicts? found\./);
    expect(output.summary).not.toMatch(/recorded/);
  });

  it("counts no conflict while the resolution stays unfrozen", async () => {
    const tenantId = "tenant-unfrozen";
    const { activities } = build(conflictedFiles);
    const before = await conflictTotal(tenantId);
    const output = await activities.resolveContext(input({ tenantId }));
    expect(output.unresolvedConflict).not.toBeNull();
    expect(await conflictTotal(tenantId)).toBe(before);
  });

  it("counts the conflict once when the settled contract is stored", async () => {
    const tenantId = "tenant-frozen";
    const { activities, contracts } = build(conflictedFiles);
    const before = await conflictTotal(tenantId);
    await activities.resolveContext(input({ tenantId, decisions: [decision] }));
    expect(contracts.all()).toHaveLength(1);
    const afterFirst = await conflictTotal(tenantId);
    expect(afterFirst).toBe(before + 1);
    // A Temporal retry repeats the work. The store writes nothing, so the counter must not move.
    await activities.resolveContext(input({ tenantId, decisions: [decision] }));
    expect(await conflictTotal(tenantId)).toBe(afterFirst);
  });

  it("agrees the noun with the count in the summary", async () => {
    const one = await build(conflictedFiles).activities.resolveContext(
      input({ decisions: [decision] }),
    );
    expect(one.summary).toContain("1 conflict recorded");

    const many = await build(threeWayFiles).activities.resolveContext(
      input({ decisions: [decision] }),
    );
    expect(many.summary).toMatch(/[2-9]\d* conflicts recorded/);
    expect(many.summary).toMatch(/\d+ context items/);
  });

  it("freezes the settled contract once the human answer arrives", async () => {
    const { activities, contracts, versions } = build(conflictedFiles);
    const unresolved = await activities.resolveContext(input());
    expect(contracts.all()).toHaveLength(0);

    const settled = await activities.resolveContext(
      input({
        decisions: [
          decision,
        ],
      }),
    );
    expect(settled.unresolvedConflict).toBeNull();
    expect(settled.sha256).not.toBe(unresolved.sha256);
    expect(contracts.all()).toHaveLength(1);
    expect(contracts.all()[0]?.sha256).toBe(settled.sha256);
    expect(versions).toEqual([
      { tenantId: "tenant-1", runId: "run-1", version: settled.sha256 },
    ]);
  });
});

describe("resolveContext, the private repository credential", () => {
  it("gives the reader the credential for the primary repository origin", async () => {
    const tokens = { tokenForInstallation: () => Promise.resolve("ghs_context_read_token") };
    const { activities, reader } = build({}, new MemorySecretStore(), tokens);

    await activities.resolveContext(input({ githubInstallationId: "install-1" }));

    expect(reader.credentialOrigins).toEqual(["https://git"]);
  });

  it("gives the reader no credential when the repository holds no installation", async () => {
    const { activities, reader } = build({});

    await activities.resolveContext(input());

    expect(reader.credentialOrigins).toEqual([]);
  });

  it("registers the minted discovery-read token with the redactor before it is used", async () => {
    const tokens = { tokenForInstallation: () => Promise.resolve("ghs_discovery_read_secret_value") };
    const redactor = new Redactor();
    const { activities, reader } = build({}, new MemorySecretStore(), tokens, redactor);

    await activities.resolveContext(input({ githubInstallationId: "install-1" }));

    expect(reader.mintedTokens).toEqual(["ghs_discovery_read_secret_value"]);
    expect(redactor.redact("a line holding ghs_discovery_read_secret_value")).not.toContain(
      "ghs_discovery_read_secret_value",
    );
  });
});
