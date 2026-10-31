import { describe, expect, it } from "vitest";
import { loadEnv } from "~/config/env.js";

const base = {
  FACTOREE_DATABASE_URL: "postgresql://factoree:factoree@localhost:5432/factoree",
  FACTOREE_MASTER_KEY: "3f9a1c7e52b04d86a1e9c3f7b2d50e48".repeat(2),
  FACTOREE_PUBLIC_URL: "https://factoree.example.com/",
};

describe("loadEnv", () => {
  it("applies the documented defaults", () => {
    const env = loadEnv(base);
    expect(env.FACTOREE_TEMPORAL_ADDRESS).toBe("localhost:7233");
    expect(env.FACTOREE_TEMPORAL_NAMESPACE).toBe("default");
    expect(env.FACTOREE_TEMPORAL_TASK_QUEUE).toBe("factoree");
    expect(env.FACTOREE_PORT).toBe(3000);
    expect(env.FACTOREE_LOG_LEVEL).toBe("info");
    expect(env.FACTOREE_EVIDENCE_STORAGE).toBe("linear");
  });

  it("trims a trailing slash of the public URL, because every webhook and callback URL appends a path", () => {
    expect(loadEnv(base).FACTOREE_PUBLIC_URL).toBe("https://factoree.example.com");
  });

  it("rejects a missing database URL, master key or public URL", () => {
    expect(() => loadEnv({ ...base, FACTOREE_DATABASE_URL: undefined })).toThrow();
    expect(() => loadEnv({ ...base, FACTOREE_MASTER_KEY: undefined })).toThrow();
    expect(() => loadEnv({ ...base, FACTOREE_PUBLIC_URL: undefined })).toThrow();
  });

  it("rejects a master key that is not 32 bytes of hexadecimal", () => {
    expect(() => loadEnv({ ...base, FACTOREE_MASTER_KEY: "abc" })).toThrow();
  });

  it("refuses the placeholder master key of .env.example", () => {
    expect(() => loadEnv({ ...base, FACTOREE_MASTER_KEY: "0".repeat(64) })).toThrow(/placeholder/);
  });

  it("reads no setting that moved to the database, so an old value cannot shadow the UI", () => {
    const env = loadEnv({
      ...base,
      GITHUB_APP_ID: "123456",
      LINEAR_WEBHOOK_SECRET: "webhook-secret",
      SANDBOX_ADAPTER: "kiln",
      KILN_API_KEY: "kiln-key",
      OPENCODE_MODEL: "deepseek/deepseek-flash",
    });
    expect(Object.keys(env).every((key) => key.startsWith("FACTOREE_"))).toBe(true);
  });

  it("accepts the filesystem evidence storage and rejects an unknown one", () => {
    expect(loadEnv({ ...base, FACTOREE_EVIDENCE_STORAGE: "filesystem" }).FACTOREE_EVIDENCE_STORAGE).toBe("filesystem");
    expect(() => loadEnv({ ...base, FACTOREE_EVIDENCE_STORAGE: "s3" })).toThrow();
  });
});
