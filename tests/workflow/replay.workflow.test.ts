import { readdir, readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { temporal } from "@temporalio/proto";
import { Worker } from "@temporalio/worker";
import { describe, expect, inject, it } from "vitest";

/**
 * docs/specs/run-workflow-structure.md. Each history in `tests/workflow/histories` comes from one
 * workflow that the suite started at the commit before the move (FACTOREE_EXPORT_HISTORIES, in
 * `support/history-export.ts`). A fresh test cannot see a change of command order in an open run;
 * a replay can, so every history must replay with the code of today.
 */
const HISTORIES = new URL("./histories/", import.meta.url).pathname;

describe("replay of recorded run histories", () => {
  it("replays every recorded history without a nondeterminism error", async () => {
    const files = (await readdir(HISTORIES)).filter((name) => name.endsWith(".pb.gz")).sort();
    expect(files.length).toBeGreaterThan(0);
    const code = await readFile(inject("agentRunWorkflowBundlePath"), "utf8");
    const histories = async function* () {
      for (const file of files) {
        const history = temporal.api.history.v1.History.decode(gunzipSync(await readFile(join(HISTORIES, file))));
        yield { workflowId: file, history };
      }
    };
    const failures: string[] = [];
    for await (const result of Worker.runReplayHistories({ workflowBundle: { code } }, histories())) {
      if (result.error !== undefined) failures.push(`${result.workflowId}: ${String(result.error)}`);
    }
    expect(failures).toEqual([]);
  });
});
