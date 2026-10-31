import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFactoreeConfig } from "~/domain/products/factoree-config.js";

// docs/specs/release-0-1-0.md. A new repository starts from a file in examples/. The parser is
// the contract, so each example must parse as it is published.
const read = (example: string): string =>
  readFileSync(new URL(`../../examples/${example}/.factoree/config.yaml`, import.meta.url), "utf8");

describe("examples/*/.factoree/config.yaml", () => {
  it("parses the Node web app example", () => {
    const config = parseFactoreeConfig(read("node-web-app"));
    expect(config.identity.linear.teamKey).toBe("WEB");
    expect(config.verify.commands.map((command) => command.name)).toEqual(["lint", "typecheck", "test", "build"]);
    expect(config.preview?.enabled).toBe(true);
  });

  it("parses the Go service example", () => {
    const config = parseFactoreeConfig(read("go-service"));
    expect(config.identity.linear.teamKey).toBe("PAY");
    expect(config.bootstrap?.command).toContain("go mod download");
    expect(config.verify.commands.map((command) => command.name)).toEqual(["vet", "test", "build"]);
  });
});
