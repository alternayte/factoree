import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitRepositoryReader } from "~/adapters/github/git-repository-reader.js";
import {
  ContextContractInvalidError,
  validateContextContract,
} from "~/domain/context/context-contract.js";
import type { ResolvedContext } from "~/domain/context/context-resolver.js";
import type { ContextFixture } from "./support/context-fixture-repository.js";
import { PRIMARY_SLUG, buildContextFixture } from "./support/context-fixture-repository.js";
import { resolveFixtureContext } from "./support/resolve-fixture-context.js";

let fixture: ContextFixture;
let resolved: ResolvedContext;
const reader = new GitRepositoryReader();

beforeAll(async () => {
  fixture = await buildContextFixture();
  resolved = await resolveFixtureContext({ fixture, reader, runId: "run-at-06" });
});

afterAll(() => {
  reader.close();
  fixture.cleanup();
});

/**
 * AT-06. Every selected Context Item carries a source, a version, an authority class, and a
 * reason. Absent provenance fails Context Contract validation.
 */
describe("AT-06 — context provenance", () => {
  it("gives every selected item complete provenance", () => {
    expect(resolved.contract.items.length).toBeGreaterThan(0);
    for (const item of resolved.contract.items) {
      expect(item.reference.sourceId.length).toBeGreaterThan(0);
      expect(item.reference.ref.length).toBeGreaterThan(0);
      expect(item.sourceVersion.length).toBeGreaterThan(0);
      expect(item.authority.length).toBeGreaterThan(0);
      expect(item.reason.length).toBeGreaterThan(0);
      expect(["required", "reference", "discoverable"]).toContain(item.classification);
    }
  });

  it("fails validation when any provenance field is absent", () => {
    const fields = ["sourceId", "sourceVersion", "authority", "reason"] as const;
    for (const field of fields) {
      const broken = structuredClone(resolved.contract);
      const item = broken.items[0];
      if (item === undefined) throw new Error("the fixture must select at least one item");
      if (field === "sourceId") item.reference = { ...item.reference, sourceId: "" };
      else if (field === "sourceVersion") item.sourceVersion = "";
      else if (field === "authority") item.authority = "" as typeof item.authority;
      else item.reason = "";
      expect(() => validateContextContract(broken)).toThrow(ContextContractInvalidError);
    }
    // The unbroken contract still validates, so the four failures above come from the removed
    // field and not from something else the clone changed.
    expect(() => validateContextContract(structuredClone(resolved.contract))).not.toThrow();
  });

  it("records the repository, the SHA, the path, and the content hash of a repository item", () => {
    const item = resolved.contract.items.find(
      (candidate) => candidate.reference.path === "docs/ADR-031.md",
    );
    expect(item?.reference.sourceId).toBe("repository");
    expect(item?.reference.repository).toBe(PRIMARY_SLUG);
    expect(item?.reference.sha).toBe(fixture.primarySha);
    expect(item?.sourceVersion).toBe(fixture.primarySha);
    expect(item?.authority).toBe("accepted_adr");
    expect(item?.classification).toBe("required");
    expect(item?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("names every provenance field of every item in the rendered contract", () => {
    for (const item of resolved.contract.items) {
      expect(resolved.document).toContain(`authority ${item.authority}`);
      expect(resolved.document).toContain(`Selected because ${item.reason}.`);
    }
  });
});
