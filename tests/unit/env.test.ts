import { describe, expect, it } from "vitest";
import { loadEnv } from "~/config/env.js";

const base = {
  DATABASE_URL: "postgresql://factoree:factoree@localhost:5432/factoree",
  FACTOREE_SECRET_KEY: "0".repeat(64),
  ADMIN_API_TOKEN: "a".repeat(32),
  LINEAR_WEBHOOK_SECRET: "webhook-secret",
  SPRITES_TOKEN: "sprites-token",
};

describe("loadEnv", () => {
  it("applies the documented defaults", () => {
    const env = loadEnv(base);
    expect(env.TEMPORAL_ADDRESS).toBe("localhost:7233");
    expect(env.TEMPORAL_NAMESPACE).toBe("default");
    expect(env.TEMPORAL_TASK_QUEUE).toBe("factoree");
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("rejects a missing database URL", () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: undefined })).toThrow();
  });

  it("rejects a secret key that is not 32 bytes of hexadecimal", () => {
    expect(() => loadEnv({ ...base, FACTOREE_SECRET_KEY: "abc" })).toThrow();
  });

  it("rejects a short administration token", () => {
    expect(() => loadEnv({ ...base, ADMIN_API_TOKEN: "short" })).toThrow();
  });

  it("defaults the sandbox adapter to fly-sprites", () => {
    const env = loadEnv(base);
    expect(env.SANDBOX_ADAPTER).toBe("fly-sprites");
  });

  it("rejects a fly-sprites sandbox adapter with no sprites token", () => {
    expect(() => loadEnv({ ...base, SPRITES_TOKEN: undefined, SANDBOX_ADAPTER: "fly-sprites" })).toThrow();
  });

  it("accepts a local sandbox adapter with no sprites token", () => {
    const env = loadEnv({ ...base, SPRITES_TOKEN: undefined, SANDBOX_ADAPTER: "local" });
    expect(env.SANDBOX_ADAPTER).toBe("local");
  });

  it("defaults the GitHub base URL", () => {
    const env = loadEnv(base);
    expect(env.GITHUB_BASE_URL).toBe("https://github.com");
  });

  it("rejects a GitHub base URL that is not a URL", () => {
    expect(() => loadEnv({ ...base, GITHUB_BASE_URL: "not-a-url" })).toThrow();
  });
});
