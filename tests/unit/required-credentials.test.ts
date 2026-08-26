import { describe, expect, it } from "vitest";
import {
  REQUIRED_LIVE_CREDENTIALS,
  missingCredentials,
} from "../live/required-credentials.js";

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
});
