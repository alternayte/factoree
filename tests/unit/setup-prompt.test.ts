import { describe, expect, it } from "vitest";
import {
  parseFactoreeConfig,
  PREVIEW_TIMEOUT_MAX_SECONDS,
  SERVICES_WAIT_TIMEOUT_MAX_SECONDS,
} from "~/domain/products/factoree-config.js";
import { CONFIG_SHAPE, renderSetupPrompt } from "~/prompts/setup.js";
import type { SetupPromptFields } from "~/prompts/setup.js";

const SAMPLE: SetupPromptFields = {
  repository: "acme/shop",
  primaryRepositoryPath: "/workspace/primary",
  productSlug: "shop",
  linearTeamKey: "SHOP",
  testSecretNames: [],
  ecosystemHosts: ["registry.npmjs.org"],
  appChangesPath: "/workspace/app-changes.md",
  existingConfig: null,
  previousNotProven: [],
  requestedChanges: [],
  previousProven: [],
  repositoryInstructions: null,
};

describe("renderSetupPrompt", () => {
  it("shows an example configuration that the config parser accepts", () => {
    const example = CONFIG_SHAPE.replace("<product>", "shop").replace("<team key>", "SHOP");

    expect(() => parseFactoreeConfig(example)).not.toThrow();
  });

  it("states the timeout limits of the config schema", () => {
    const prompt = renderSetupPrompt(SAMPLE);

    expect(prompt).toContain(`preview.timeoutSeconds is at most ${PREVIEW_TIMEOUT_MAX_SECONDS}`);
    expect(prompt).toContain(`services.waitTimeoutSeconds is at most ${SERVICES_WAIT_TIMEOUT_MAX_SECONDS}`);
  });

  it("tells the agent to restore with the NuGet file Factoree wrote, and only then (nuget-private-feed-mapping.md)", () => {
    expect(renderSetupPrompt(SAMPLE)).not.toContain("Private NuGet feed");
    const prompt = renderSetupPrompt({
      ...SAMPLE,
      nugetFeed: { configPath: ".factoree/nuget.config", replacedHost: "nuget.frontiersin.net", mirror: "nuget.pkg.github.com/frontiersin", mirroredIds: ["Frontiers.Core"] },
    });
    expect(prompt).toContain("## Private NuGet feed");
    expect(prompt).toContain("dotnet restore --configfile .factoree/nuget.config");
    expect(prompt).toContain("--no-restore");
    expect(prompt).toContain("Frontiers.Core");
    expect(prompt).toContain("Factoree writes it again after your session");
  });
});
