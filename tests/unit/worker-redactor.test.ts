import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `src/bin/worker.ts` builds the redactor that guards every log line, every activity error, and
 * every Temporal history record the worker process produces. This is the process that captures
 * agent output, sandbox output, and git output, so a secret the redactor does not hold reaches
 * the widest possible surface if it ever echoes.
 *
 * `src/bin/api.ts` already lists `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`. This test
 * proves the worker's redactor construction lists the identical set, rather than only the three
 * secrets that predate the GitHub App.
 */
describe("the worker's redactor", () => {
  it("holds the GitHub App private key and the webhook secret, not only the older secrets", () => {
    const source = readFileSync("src/bin/worker.ts", "utf8");
    const match = /const redactor = new Redactor\(\[([\s\S]*?)\]\);/.exec(source);
    expect(match).not.toBeNull();
    const body = match?.[1] ?? "";

    expect(body).toContain("env.ADMIN_API_TOKEN");
    expect(body).toContain("env.LINEAR_WEBHOOK_SECRET");
    expect(body).toContain("env.FACTOREE_SECRET_KEY");
    expect(body).toContain("env.GITHUB_APP_PRIVATE_KEY");
    expect(body).toContain("env.GITHUB_WEBHOOK_SECRET");
  });
});
