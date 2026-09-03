import { describe, expect, it } from "vitest";
import { FakeSandbox } from "../support/fake-sandbox.js";
import {
  REPOSITORY_INSTRUCTION_FILES,
  readRepositoryConfig,
  readRepositoryInstructions,
} from "~/domain/runs/repository-config-source.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";

const minimum = "version: 1\nidentity:\n  product: checkout-platform\n  linear:\n    teamKey: PAY\nverify:\n  commands:\n    - name: test\n      run: npm test\n";

const withFiles = async (files: Record<string, string>) => {
  const sandbox = new FakeSandbox();
  sandbox.onExec = (command) => {
    const path = command.args[command.args.length - 1] ?? "";
    const body = files[path];
    if (body === undefined) return { exitCode: 1, stdout: "", stderr: `cat: ${path}: No such file` };
    return { exitCode: 0, stdout: body, stderr: "" };
  };
  const ref = await sandbox.create({ runId: "r", tenantId: "t", projectId: "p" });
  return { sandbox, ref };
};

describe("readRepositoryConfig", () => {
  it("reads and parses the file from the primary checkout", async () => {
    const { sandbox, ref } = await withFiles({ "/w/primary/.factoree/config.yaml": minimum });
    const config = await readRepositoryConfig(sandbox, ref, "/w/primary");
    expect(config.verify.commands).toEqual([{ name: "test", run: "npm test" }]);
  });

  it("fails with a configuration error when the file is absent", async () => {
    const { sandbox, ref } = await withFiles({});
    await expect(readRepositoryConfig(sandbox, ref, "/w/primary")).rejects.toThrow(RunConfigurationError);
    await expect(readRepositoryConfig(sandbox, ref, "/w/primary")).rejects.toThrow(/\.factoree\/config\.yaml/);
  });

  it("fails with a configuration error when the file is invalid", async () => {
    const { sandbox, ref } = await withFiles({ "/w/primary/.factoree/config.yaml": `${minimum}plugins: []\n` });
    await expect(readRepositoryConfig(sandbox, ref, "/w/primary")).rejects.toThrow(RunConfigurationError);
  });

  it("tolerates a trailing slash on the checkout path", async () => {
    const { sandbox, ref } = await withFiles({ "/w/primary/.factoree/config.yaml": minimum });
    await expect(readRepositoryConfig(sandbox, ref, "/w/primary/")).resolves.toBeDefined();
  });
});

describe("readRepositoryInstructions", () => {
  it("reads the first instruction file that exists, in order", async () => {
    expect(REPOSITORY_INSTRUCTION_FILES[0]).toBe("AGENTS.md");
    const { sandbox, ref } = await withFiles({
      "/w/primary/CLAUDE.md": "claude\n",
      "/w/primary/CONTRIBUTING.md": "contributing\n",
    });
    expect(await readRepositoryInstructions(sandbox, ref, "/w/primary")).toBe("claude\n");
  });

  it("returns an empty text when no instruction file exists", async () => {
    const { sandbox, ref } = await withFiles({});
    expect(await readRepositoryInstructions(sandbox, ref, "/w/primary")).toBe("");
  });

  it("truncates a very large instruction file", async () => {
    const big = "x".repeat(70_000);
    const { sandbox, ref } = await withFiles({ "/w/primary/AGENTS.md": big });
    const text = await readRepositoryInstructions(sandbox, ref, "/w/primary");
    expect(text.length).toBeLessThan(big.length);
    expect(text).toContain("truncated");
  });
});
