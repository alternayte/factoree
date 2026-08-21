import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
  engines: { node: string };
};
const tsconfig = JSON.parse(readFileSync("tsconfig.json", "utf8")) as {
  compilerOptions: Record<string, unknown>;
};

describe("toolchain", () => {
  it("requires Node 24", () => {
    expect(pkg.engines.node).toBe(">=24 <25");
  });

  it("declares every required development command", () => {
    for (const name of ["lint", "typecheck", "test", "test:integration", "test:workflow", "build", "verify"]) {
      expect(pkg.scripts[name], `missing script ${name}`).toBeTypeOf("string");
    }
  });

  it("runs all required non-live checks in verify", () => {
    const verify = pkg.scripts.verify ?? "";
    for (const name of ["lint", "typecheck", "test", "test:integration", "test:workflow", "build"]) {
      expect(verify).toContain(name);
    }
  });

  it("enables the required strict compiler settings", () => {
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.noUncheckedIndexedAccess).toBe(true);
    expect(tsconfig.compilerOptions.exactOptionalPropertyTypes).toBe(true);
  });
});
