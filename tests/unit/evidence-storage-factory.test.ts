import { describe, expect, it } from "vitest";
import { createEvidenceStorage } from "~/adapters/evidence/evidence-storage-factory.js";
import type { LinearFileUploadApi } from "~/adapters/linear/linear-evidence-storage.js";

const artifact = {
  tenantId: "tenant-1",
  runId: "run-1",
  name: "VAL-UI-001-screenshot.png",
  contentType: "image/png",
  bytes: new Uint8Array([1, 2, 3]),
};

const neverCalled = (): Promise<LinearFileUploadApi> => {
  throw new Error("the filesystem selection must not build a Linear port");
};

describe("createEvidenceStorage", () => {
  it("selects the filesystem adapter by default", () => {
    const storage = createEvidenceStorage({
      storage: "filesystem",
      localRoot: "/tmp/factoree-evidence-selection-test",
      linearApiForTenant: neverCalled,
    });
    expect(storage.name).toBe("filesystem");
  });

  it("selects the Linear adapter and resolves the port for the tenant of the artifact", async () => {
    const tenants: string[] = [];
    const uploads: string[] = [];
    const api: LinearFileUploadApi = {
      fileUpload: (contentType, filename) => {
        uploads.push(`${contentType} ${filename}`);
        return Promise.resolve({
          success: true,
          uploadFile: {
            uploadUrl: "https://upload.example/slot",
            assetUrl: "https://assets.example/a.png",
            headers: [],
          },
        });
      },
    };

    const storage = createEvidenceStorage({
      storage: "linear",
      localRoot: "/tmp/factoree-evidence-selection-test",
      linearApiForTenant: (tenantId) => {
        tenants.push(tenantId);
        return Promise.resolve(api);
      },
    });

    expect(storage.name).toBe("linear");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response(null, { status: 200 }));
    try {
      const stored = await storage.put(artifact);
      expect(stored.storageRef).toBe("https://assets.example/a.png");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(tenants).toEqual(["tenant-1"]);
    expect(uploads).toEqual(["image/png VAL-UI-001-screenshot.png"]);
  });
});
