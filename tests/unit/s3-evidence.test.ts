import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { S3EvidenceStorage } from "~/adapters/evidence/s3-evidence-storage.js";
import { artifactLinkOf, isOpenLinkToken, openLinkToken } from "~/domain/evidence/artifact-links.js";
import { effectiveBucket, objectStoreFingerprint, objectStoreTested } from "~/domain/retro/transcript.js";
import { registerArtifactRoutes } from "~/http/artifacts.routes.js";
import type { StoredArtifactRecord } from "~/persistence/prisma/stored-artifact.prisma.js";

// docs/specs/s3-object-store.md. Only a screenshot or a video opens without a sign-in, a member of
// another tenant sees nothing, and every link Factoree writes is stable.

const KEY = "0".repeat(64);
const PUBLIC = "https://factoree.example";

const record = (overrides: Partial<StoredArtifactRecord> = {}): StoredArtifactRecord => ({
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "tenant-a",
  runId: "run-1",
  kind: "screenshot",
  name: "VAL-1.png",
  contentType: "image/png",
  objectKey: "evidence/tenant-a/run-1/x-VAL-1.png",
  bytes: 3,
  sha256: "s",
  deletedAt: null,
  createdAt: new Date(),
  ...overrides,
});

describe("artifact links", () => {
  it("gives a screenshot or a video an open link, and any other kind the sign-in link", () => {
    expect(artifactLinkOf(PUBLIC, KEY, { id: "a1", kind: "video" })).toBe(`${PUBLIC}/artifacts/a1/${openLinkToken(KEY, "a1")}`);
    expect(artifactLinkOf(PUBLIC, KEY, { id: "a1", kind: "trace" })).toBe(`${PUBLIC}/artifacts/a1`);
    expect(isOpenLinkToken(KEY, "a1", openLinkToken(KEY, "a1"))).toBe(true);
    expect(isOpenLinkToken(KEY, "a2", openLinkToken(KEY, "a1"))).toBe(false);
    expect(isOpenLinkToken("1".repeat(64), "a1", openLinkToken(KEY, "a1"))).toBe(false);
  });
});

describe("the S3 evidence store", () => {
  it("stores the object under the tenant and run, and a retry reuses it", async () => {
    const puts: string[] = [];
    const rows: StoredArtifactRecord[] = [];
    const storage = new S3EvidenceStorage({
      objectStore: () => Promise.resolve({ put: (key) => (puts.push(key), Promise.resolve()), get: () => Promise.resolve(null), delete: () => Promise.resolve() }),
      artifacts: {
        findSame: (runId, name, sha256) => Promise.resolve(rows.find((row) => row.runId === runId && row.name === name && row.sha256 === sha256) ?? null),
        create: (row) => {
          const created = { ...row, deletedAt: null, createdAt: new Date() };
          rows.push(created);
          return Promise.resolve(created);
        },
      },
      publicUrl: PUBLIC,
      masterKey: KEY,
    });
    const input = { tenantId: "tenant-a", runId: "run-1", name: "trace.zip", contentType: "application/zip", bytes: new Uint8Array([1, 2]), kind: "trace" };
    const first = await storage.put(input);
    const again = await storage.put(input);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatch(/^evidence\/tenant-a\/run-1\/[0-9a-f-]{36}-trace\.zip$/);
    expect(first.storageRef).toBe(`${PUBLIC}/artifacts/${rows[0]!.id}`);
    expect(again.storageRef).toBe(first.storageRef);
  });
});

describe("the artifact routes", () => {
  const build = (principal: { memberships: Array<{ tenantId: string }> } | null, artifact: StoredArtifactRecord) => {
    const app = Fastify();
    registerArtifactRoutes(app, {
      artifacts: { byId: (id) => Promise.resolve(id === artifact.id ? artifact : null) },
      objectStore: () => Promise.resolve({ presignGet: (key) => `https://bucket.example/${key}?X-Amz-Signature=x` }),
      principal: () => Promise.resolve(principal as never),
      masterKey: KEY,
    });
    return app;
  };

  it("sends a signed-out reader to the sign-in, and a member of another tenant gets 404", async () => {
    const artifact = record({ kind: "check_log", contentType: "text/plain" });
    const signedOut = await build(null, artifact).inject({ url: `/artifacts/${artifact.id}` });
    expect(signedOut.statusCode).toBe(302);
    expect(signedOut.headers.location).toBe(`/sign-in?next=${encodeURIComponent(`/artifacts/${artifact.id}`)}`);
    expect((await build({ memberships: [{ tenantId: "tenant-b" }] }, artifact).inject({ url: `/artifacts/${artifact.id}` })).statusCode).toBe(404);
    const member = await build({ memberships: [{ tenantId: "tenant-a" }] }, artifact).inject({ url: `/artifacts/${artifact.id}` });
    expect(member.statusCode).toBe(302);
    expect(member.headers.location).toContain("bucket.example/evidence/tenant-a/run-1/");
  });

  it("opens a screenshot through its open link, and never a trace or a wrong token", async () => {
    const screenshot = record();
    expect((await build(null, screenshot).inject({ url: `/artifacts/${screenshot.id}/${openLinkToken(KEY, screenshot.id)}` })).statusCode).toBe(302);
    expect((await build(null, screenshot).inject({ url: `/artifacts/${screenshot.id}/${openLinkToken(KEY, "other")}` })).statusCode).toBe(404);
    const trace = record({ kind: "trace", contentType: "application/zip" });
    expect((await build(null, trace).inject({ url: `/artifacts/${trace.id}/${openLinkToken(KEY, trace.id)}` })).statusCode).toBe(404);
    const deleted = record({ deletedAt: new Date() });
    expect((await build(null, deleted).inject({ url: `/artifacts/${deleted.id}/${openLinkToken(KEY, deleted.id)}` })).statusCode).toBe(404);
  });
});

describe("the object store settings", () => {
  const stored = { endpoint: "https://s3.example", bucket: "stored", region: null, accessKey: "AK", secretKey: "SK" };

  it("takes FACTOREE_S3_* over the 0.23 alias, and the alias over the stored field", () => {
    expect(effectiveBucket(stored, { FACTOREE_TRANSCRIPT_S3_BUCKET: "alias" }).bucket).toBe("alias");
    expect(effectiveBucket(stored, { FACTOREE_TRANSCRIPT_S3_BUCKET: "alias", FACTOREE_S3_BUCKET: "new" }).bucket).toBe("new");
  });

  it("counts as tested only while the settings match the ones that passed", () => {
    const sha = objectStoreFingerprint(stored);
    expect(objectStoreTested(stored, sha, {})).toBe(true);
    expect(objectStoreTested({ ...stored, secretKey: "other" }, sha, {})).toBe(false);
    expect(objectStoreTested(stored, sha, { FACTOREE_S3_BUCKET: "other" })).toBe(false);
  });
});
