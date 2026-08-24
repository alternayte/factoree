import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemEvidenceStorage } from "~/adapters/evidence/filesystem-evidence-storage.js";
import { LinearEvidenceStorage, EvidenceStorageError } from "~/adapters/linear/linear-evidence-storage.js";
import type { LinearFileUploadApi } from "~/adapters/linear/linear-evidence-storage.js";
import type { PutArtifactInput } from "~/domain/evidence/evidence-storage.js";

describe("FilesystemEvidenceStorage", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "factoree-evidence-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores the bytes and returns a reference and their hash", async () => {
    const storage = new FilesystemEvidenceStorage({ rootDirectory: root });
    const bytes = new TextEncoder().encode("hello");

    const stored = await storage.put({
      tenantId: "t",
      runId: "r",
      name: "a.txt",
      contentType: "text/plain",
      bytes,
    });

    expect(stored.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(stored.byteLength).toBe(5);
    expect(await readFile(stored.storageRef.replace("file://", ""), "utf8")).toBe("hello");
  });

  it("keeps one tenant's artefacts out of another tenant's directory", async () => {
    const storage = new FilesystemEvidenceStorage({ rootDirectory: root });
    const bytes = new TextEncoder().encode("hello");

    const first = await storage.put({
      tenantId: "tenant-a",
      runId: "r",
      name: "a.txt",
      contentType: "text/plain",
      bytes,
    });
    const second = await storage.put({
      tenantId: "tenant-b",
      runId: "r",
      name: "a.txt",
      contentType: "text/plain",
      bytes,
    });

    expect(first.storageRef).not.toBe(second.storageRef);
    expect(first.storageRef).toContain("tenant-a");
    expect(second.storageRef).toContain("tenant-b");
  });
});

describe("LinearEvidenceStorage", () => {
  const input: PutArtifactInput = {
    tenantId: "t",
    runId: "r",
    name: "after-reload.png",
    contentType: "image/png",
    bytes: new TextEncoder().encode("png-bytes"),
  };

  it("uploads through Linear when the Linear adapter is active", async () => {
    const calls: Array<{ contentType: string; filename: string; size: number }> = [];
    const putCalls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const fakeApi: LinearFileUploadApi = {
      fileUpload: (contentType, filename, size) => {
        calls.push({ contentType, filename, size });
        return Promise.resolve({
          success: true,
          uploadFile: {
            uploadUrl: "https://uploads.linear.app/put-1",
            assetUrl: "https://uploads.linear.app/asset-1",
            headers: [
              { key: "x-amz-acl", value: "private" },
              { key: "content-type", value: contentType },
            ],
          },
        });
      },
    };
    const fakeFetch = (url: string | URL, init?: RequestInit) => {
      putCalls.push({
        url: url.toString(),
        body: init?.body,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return Promise.resolve(new Response(null, { status: 200 }));
    };

    const storage = new LinearEvidenceStorage(fakeApi, fakeFetch);
    const stored = await storage.put(input);

    expect(stored.storageRef).toBe("https://uploads.linear.app/asset-1");
    expect(calls[0]).toMatchObject({
      contentType: "image/png",
      size: input.bytes.byteLength,
    });
    expect(putCalls[0]?.url).toBe("https://uploads.linear.app/put-1");
    expect(putCalls[0]?.headers).toMatchObject({
      "x-amz-acl": "private",
      "content-type": "image/png",
    });
  });

  it("reports a Linear upload failure as an error the caller can survive", async () => {
    const failingApi: LinearFileUploadApi = {
      fileUpload: () => Promise.resolve({ success: false, uploadFile: null }),
    };
    const fakeFetch = () => Promise.resolve(new Response(null, { status: 200 }));

    await expect(new LinearEvidenceStorage(failingApi, fakeFetch).put(input)).rejects.toThrow(
      EvidenceStorageError,
    );
  });

  it("reports a failed PUT as an error the caller can survive", async () => {
    const fakeApi: LinearFileUploadApi = {
      fileUpload: () =>
        Promise.resolve({
          success: true,
          uploadFile: {
            uploadUrl: "https://uploads.linear.app/put-1",
            assetUrl: "https://uploads.linear.app/asset-1",
            headers: [],
          },
        }),
    };
    const fakeFetch = () => Promise.resolve(new Response(null, { status: 500 }));

    await expect(new LinearEvidenceStorage(fakeApi, fakeFetch).put(input)).rejects.toThrow(
      EvidenceStorageError,
    );
  });
});
