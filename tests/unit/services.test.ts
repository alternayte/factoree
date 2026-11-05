import { describe, expect, it } from "vitest";
import { listFakes } from "~/domain/runs/services.js";
import { parseFactoreeConfig } from "~/domain/products/factoree-config.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const ref = { id: "sandbox-1", adapter: "fake", workspacePath: "/workspace" };
const services = { compose: "docker-compose.yml", profiles: [], seed: null, waitTimeoutSeconds: 60 };

describe("listFakes (repository-setup-and-services.md)", () => {
  it("reads the factoree.fake label in map and list form from the merged config of both compose files", async () => {
    const sandbox = new FakeSandbox();
    sandbox.onExec = (command) => {
      if (command.file === "test") return { exitCode: 0, stdout: "", stderr: "" };
      if (command.file === "docker") {
        expect(command.args).toEqual(["compose", "-f", "docker-compose.yml", "-f", ".factoree/compose.yaml", "config", "--format", "json"]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            services: {
              postgres: { labels: { "com.example": "x" } },
              tmdb: { labels: { "factoree.fake": "TMDB API" } },
              mail: { labels: ["factoree.fake=Mailgun"] },
            },
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    expect(await listFakes(sandbox, ref, "/workspace/primary", services)).toEqual([
      { service: "mail", name: "Mailgun" },
      { service: "tmdb", name: "TMDB API" },
    ]);
  });
});

describe("accounts in .factoree/config.yaml (repository-setup-and-services.md)", () => {
  const base =
    "version: 1\nidentity:\n  product: shop\n  linear:\n    teamKey: SHP\nverify:\n  commands:\n    - name: test\n      run: npm test\n";
  const account = (name: string, path = "/login") =>
    `  - name: ${name}\n    username: a@example.test\n    password: pass\n    steps:\n      - action: goto\n        path: ${path}\n    check:\n      action: expectVisible\n      selector: "#profile"\n`;

  it("refuses two accounts with one name", () => {
    expect(() => parseFactoreeConfig(`${base}accounts:\n${account("member")}${account("member")}`)).toThrow(/duplicate name "member"/);
  });

  it("refuses a sign-in that leaves the preview", () => {
    expect(() => parseFactoreeConfig(`${base}accounts:\n${account("member", "//evil.example")}`)).toThrow(/not a relative preview path/);
  });
});
