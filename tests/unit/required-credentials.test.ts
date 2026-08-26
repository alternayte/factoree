import { describe, expect, it } from "vitest";
import {
  REQUIRED_LIVE_CREDENTIALS,
  missingCredentials,
} from "../live/required-credentials.js";
import {
  credentialsFor,
  LOCAL_DEPENDENCIES,
  LOCAL_EXCLUDED_DEPENDENCIES,
  LOCAL_REPLACEMENT_CREDENTIALS,
} from "../live/profile.js";

describe("the live acceptance credential list", () => {
  it("names one credential for every live dependency of SDD section 66", () => {
    // SDD section 66 lists seven live dependencies. Every one needs at least one credential
    // or endpoint, or the live test cannot reach it.
    const dependencies = new Set(REQUIRED_LIVE_CREDENTIALS.map((entry) => entry.dependency));
    expect([...dependencies].sort()).toEqual([
      "backstage",
      "fly-sprites",
      "github",
      "linear",
      "mcp",
      "runner",
      "temporal",
    ]);
  });

  it("reports every absent credential", () => {
    expect(missingCredentials({})).toHaveLength(REQUIRED_LIVE_CREDENTIALS.length);
  });

  it("reports nothing when every credential is present", () => {
    const env: NodeJS.ProcessEnv = {};
    for (const entry of REQUIRED_LIVE_CREDENTIALS) env[entry.name] = "value";
    expect(missingCredentials(env)).toEqual([]);
  });

  it("treats an empty string as absent", () => {
    const env: NodeJS.ProcessEnv = {};
    for (const entry of REQUIRED_LIVE_CREDENTIALS) env[entry.name] = "value";
    env[REQUIRED_LIVE_CREDENTIALS[0]!.name] = "";
    expect(missingCredentials(env).map((entry) => entry.name)).toEqual([
      REQUIRED_LIVE_CREDENTIALS[0]!.name,
    ]);
  });

  it("documents every credential in .env.example", async () => {
    // A credential nobody documented is a credential the operator cannot supply. SDD section
    // 66 requires the list in `.env.example`.
    const { readFile } = await import("node:fs/promises");
    const example = await readFile(new URL("../../.env.example", import.meta.url), "utf8");
    for (const entry of REQUIRED_LIVE_CREDENTIALS) {
      expect(example, `${entry.name} is absent from .env.example`).toContain(entry.name);
    }
  });

  it("documents every credential in docs/live-acceptance.md", async () => {
    const { readFile } = await import("node:fs/promises");
    const document = await readFile(
      new URL("../../docs/live-acceptance.md", import.meta.url),
      "utf8",
    );
    for (const entry of REQUIRED_LIVE_CREDENTIALS) {
      expect(document, `${entry.name} is absent from docs/live-acceptance.md`).toContain(entry.name);
    }
  });

  it("reports every absent credential of the full profile, still", () => {
    // The full profile must keep demanding all 14 values. This guards the exit-78 path.
    expect(missingCredentials({})).toHaveLength(credentialsFor("full").length);
    expect(missingCredentials({})).toHaveLength(14);
  });

  it("accounts for every dependency of the full list in the local profile build", () => {
    // A future dependency kind that falls into neither LOCAL_DEPENDENCIES,
    // LOCAL_REPLACEMENT_CREDENTIALS, nor LOCAL_EXCLUDED_DEPENDENCIES vanishes from the
    // local list silently. This test fails loudly instead.
    const fullDependencies = new Set(REQUIRED_LIVE_CREDENTIALS.map((entry) => entry.dependency));
    const replacementDependencies = new Set(
      LOCAL_REPLACEMENT_CREDENTIALS.map((entry) => entry.dependency),
    );
    const accountedFor = new Set([
      ...LOCAL_DEPENDENCIES,
      ...replacementDependencies,
      ...LOCAL_EXCLUDED_DEPENDENCIES,
    ]);
    const unaccounted = [...fullDependencies].filter((dependency) => !accountedFor.has(dependency));
    expect(unaccounted, `unaccounted dependency: ${unaccounted.join(", ")}`).toEqual([]);
  });

  it(
    "documents every local credential in .env.local.example",
    async () => {
      const { readFile } = await import("node:fs/promises");
      const example = await readFile(
        new URL("../../.env.local.example", import.meta.url),
        "utf8",
      );
      for (const entry of credentialsFor("local")) {
        expect(example, `${entry.name} is absent from .env.local.example`).toContain(entry.name);
      }
    },
  );
});
