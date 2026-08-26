import { describe, expect, it } from "vitest";
import {
  DRIVER_CREDENTIALS,
  COMMON_INFRASTRUCTURE_REQUIREMENTS,
  LOCAL_SANDBOX_REQUIREMENT,
  SPRITE_SANDBOX_REQUIREMENTS,
  unmetRequirementsFor,
} from "../live/required-credentials.js";
import { credentialsFor } from "../live/profile.js";

const fillPresent = (env: NodeJS.ProcessEnv, requirements: { name: string; kind: string; value?: string }[]): void => {
  for (const entry of requirements) {
    env[entry.name] = entry.kind === "equals" ? (entry.value ?? "value") : "value";
  }
};

describe("the live acceptance driver credentials", () => {
  it("names exactly the four values tests/live/scenario.ts reads", () => {
    const names = DRIVER_CREDENTIALS.map((entry) => entry.name).sort();
    expect(names).toEqual(
      [
        "LIVE_LINEAR_API_KEY",
        "LIVE_LINEAR_TEAM_ID",
        "LIVE_GITHUB_TOKEN",
        "LIVE_GITHUB_REPOSITORY",
      ].sort(),
    );
  });

  it("documents every driver credential in .env.example", async () => {
    const { readFile } = await import("node:fs/promises");
    const example = await readFile(new URL("../../.env.example", import.meta.url), "utf8");
    for (const entry of DRIVER_CREDENTIALS) {
      expect(example, `${entry.name} is absent from .env.example`).toContain(entry.name);
    }
  });
});

describe("unmetRequirementsFor", () => {
  it("reports every absent requirement", () => {
    const requirements = [...DRIVER_CREDENTIALS, ...COMMON_INFRASTRUCTURE_REQUIREMENTS];
    expect(unmetRequirementsFor({}, requirements)).toHaveLength(requirements.length);
  });

  it("reports nothing when every present requirement is supplied", () => {
    const env: NodeJS.ProcessEnv = {};
    fillPresent(env, DRIVER_CREDENTIALS);
    expect(unmetRequirementsFor(env, DRIVER_CREDENTIALS)).toEqual([]);
  });

  it("treats an empty string as absent", () => {
    const env: NodeJS.ProcessEnv = {};
    fillPresent(env, DRIVER_CREDENTIALS);
    env[DRIVER_CREDENTIALS[0]!.name] = "";
    expect(unmetRequirementsFor(env, DRIVER_CREDENTIALS).map((entry) => entry.requirement.name)).toEqual([
      DRIVER_CREDENTIALS[0]!.name,
    ]);
  });

  it("reports an equals requirement as unmet when the variable is absent", () => {
    const unmet = unmetRequirementsFor({}, [LOCAL_SANDBOX_REQUIREMENT]);
    expect(unmet).toHaveLength(1);
    expect(unmet[0]!.actual).toBeUndefined();
  });

  it("reports an equals requirement as unmet, with the actual value, when the value is wrong", () => {
    const unmet = unmetRequirementsFor({ SANDBOX_ADAPTER: "fly-sprites" }, [LOCAL_SANDBOX_REQUIREMENT]);
    expect(unmet).toHaveLength(1);
    expect(unmet[0]!.actual).toBe("fly-sprites");
  });

  it("reports an equals requirement as met when the value matches", () => {
    const unmet = unmetRequirementsFor({ SANDBOX_ADAPTER: "local" }, [LOCAL_SANDBOX_REQUIREMENT]);
    expect(unmet).toEqual([]);
  });

  it("keeps the sprite sandbox requirements at SANDBOX_ADAPTER and SPRITES_TOKEN", () => {
    const names = SPRITE_SANDBOX_REQUIREMENTS.map((entry) => entry.name).sort();
    expect(names).toEqual(["SANDBOX_ADAPTER", "SPRITES_TOKEN"]);
  });

  it("documents every common infrastructure requirement in .env.example", async () => {
    const { readFile } = await import("node:fs/promises");
    const example = await readFile(new URL("../../.env.example", import.meta.url), "utf8");
    for (const entry of COMMON_INFRASTRUCTURE_REQUIREMENTS) {
      expect(example, `${entry.name} is absent from .env.example`).toContain(entry.name);
    }
  });

  it("documents every driver credential in docs/live-acceptance.md", async () => {
    const { readFile } = await import("node:fs/promises");
    const document = await readFile(new URL("../../docs/live-acceptance.md", import.meta.url), "utf8");
    for (const entry of DRIVER_CREDENTIALS) {
      expect(document, `${entry.name} is absent from docs/live-acceptance.md`).toContain(entry.name);
    }
  });
});

describe("no invented LIVE_ variable remains", () => {
  it("keeps credentialsFor(full) to exactly the driver credentials plus common infrastructure plus sprite sandbox requirements", () => {
    expect(credentialsFor("full")).toHaveLength(
      DRIVER_CREDENTIALS.length + COMMON_INFRASTRUCTURE_REQUIREMENTS.length + SPRITE_SANDBOX_REQUIREMENTS.length,
    );
  });
});
