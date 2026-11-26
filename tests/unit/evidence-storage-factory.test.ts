import { describe, expect, it } from "vitest";
import { createEvidenceStorage } from "~/adapters/evidence/evidence-storage-factory.js";
import type { LinearFileUploadApi } from "~/adapters/linear/linear-evidence-storage.js";
import type { EvidenceStoreName } from "~/domain/settings/install-settings.js";

const artifact = {
  tenantId: "tenant-1",
  runId: "run-1",
  name: "VAL-UI-001-screenshot.png",
  contentType: "image/png",
  bytes: new Uint8Array([1, 2, 3]),
  kind: "screenshot",
};

// docs/specs/s3-object-store.md. Each upload goes to the store chosen at its time.
describe("createEvidenceStorage", () => {
  it("reads the evidence store for each upload", async () => {
    let store: EvidenceStoreName = "s3";
    const tenants: string[] = [];
    const api: LinearFileUploadApi = {
      fileUpload: () =>
        Promise.resolve({ success: true, uploadFile: { uploadUrl: "https://upload.example/slot", assetUrl: "https://assets.example/a.png", headers: [] } }),
    };
    const storage = createEvidenceStorage({
      store: () => Promise.resolve(store),
      localRoot: "/tmp/factoree-evidence-selection-test",
      linearApiForTenant: (tenantId) => {
        tenants.push(tenantId);
        return Promise.resolve(api);
      },
      s3: { name: "s3", put: () => Promise.resolve({ storageRef: "https://factoree.example/artifacts/a1/token", sha256: "x", byteLength: 3 }) },
    });
    expect((await storage.put(artifact)).storageRef).toBe("https://factoree.example/artifacts/a1/token");

    store = "linear";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response(null, { status: 200 }));
    try {
      expect((await storage.put(artifact)).storageRef).toBe("https://assets.example/a.png");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(tenants).toEqual(["tenant-1"]);
  });
});
