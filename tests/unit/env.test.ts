import { describe, expect, it } from "vitest";
import { loadEnv } from "~/config/env.js";

const base = {
  DATABASE_URL: "postgresql://factoree:factoree@localhost:5432/factoree",
  FACTOREE_SECRET_KEY: "3f9a1c7e52b04d86a1e9c3f7b2d50e48".repeat(2),
  ADMIN_API_TOKEN: "k3Jx9QvT2mWb7RzL5nYc8HdF4pGs1AeU",
  LINEAR_WEBHOOK_SECRET: "webhook-secret",
  SPRITES_TOKEN: "sprites-token",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: Buffer.from(
    "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  ).toString("base64"),
  GITHUB_WEBHOOK_SECRET: "github-webhook-secret",
};

const validEnv = () => ({ ...base });

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

  it("accepts a local sandbox adapter with no sprites token when the unsafe flag is set", () => {
    const env = loadEnv({
      ...base,
      SPRITES_TOKEN: undefined,
      SANDBOX_ADAPTER: "local",
      FACTOREE_UNSAFE_LOCAL_SANDBOX: "1",
    });
    expect(env.SANDBOX_ADAPTER).toBe("local");
  });

  it("refuses the local sandbox adapter without the unsafe flag", () => {
    // The local sandbox runs the agent as the worker user, which can read the worker environment.
    expect(() => loadEnv({ ...base, SANDBOX_ADAPTER: "local" })).toThrow(/FACTOREE_UNSAFE_LOCAL_SANDBOX/);
  });

  it("refuses the placeholder secret key of .env.example", () => {
    expect(() => loadEnv({ ...base, FACTOREE_SECRET_KEY: "0".repeat(64) })).toThrow(/placeholder/);
  });

  it("refuses the placeholder administration token of .env.example", () => {
    expect(() =>
      loadEnv({ ...base, ADMIN_API_TOKEN: "change-me-to-a-token-of-32-characters" }),
    ).toThrow(/placeholder/);
    expect(() => loadEnv({ ...base, ADMIN_API_TOKEN: "a".repeat(32) })).toThrow(/placeholder/);
  });

  it("defaults the GitHub base URL", () => {
    const env = loadEnv(base);
    expect(env.GITHUB_BASE_URL).toBe("https://github.com");
  });

  it("rejects a GitHub base URL that is not a URL", () => {
    expect(() => loadEnv({ ...base, GITHUB_BASE_URL: "not-a-url" })).toThrow();
  });

  it("defaults the GitHub API base URL, the git author name, and the git author email", () => {
    const env = loadEnv(base);
    expect(env.GITHUB_API_BASE_URL).toBe("https://api.github.com");
    expect(env.FACTOREE_GIT_AUTHOR_NAME).toBe("Factoree");
    expect(env.FACTOREE_GIT_AUTHOR_EMAIL).toBe("factoree@users.noreply.github.com");
  });

  it("rejects a GitHub API base URL that is not a URL", () => {
    expect(() => loadEnv({ ...base, GITHUB_API_BASE_URL: "not-a-url" })).toThrow();
  });

  it("defaults the evidence storage to the filesystem adapter", () => {
    const env = loadEnv(base);
    expect(env.EVIDENCE_STORAGE).toBe("filesystem");
  });

  it("accepts the Linear evidence storage adapter", () => {
    const env = loadEnv({ ...base, EVIDENCE_STORAGE: "linear" });
    expect(env.EVIDENCE_STORAGE).toBe("linear");
  });

  it("rejects an unknown evidence storage adapter", () => {
    expect(() => loadEnv({ ...base, EVIDENCE_STORAGE: "s3" })).toThrow();
  });

  it("requires the three GitHub App values", () => {
    const base = validEnv();
    expect(() => loadEnv({ ...base, GITHUB_APP_ID: undefined })).toThrow();
    expect(() => loadEnv({ ...base, GITHUB_APP_PRIVATE_KEY: undefined })).toThrow();
    expect(() => loadEnv({ ...base, GITHUB_WEBHOOK_SECRET: undefined })).toThrow();
  });

  it("rejects a private key that is not base64", () => {
    expect(() => loadEnv({ ...validEnv(), GITHUB_APP_PRIVATE_KEY: "not base64!" })).toThrow();
  });

  it("accepts a base64 private key", () => {
    const pem = Buffer.from("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n").toString(
      "base64",
    );
    expect(loadEnv({ ...validEnv(), GITHUB_APP_PRIVATE_KEY: pem }).GITHUB_APP_PRIVATE_KEY).toBe(pem);
  });
});
