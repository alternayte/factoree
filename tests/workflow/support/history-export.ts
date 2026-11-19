/**
 * docs/specs/run-workflow-structure.md. With FACTOREE_EXPORT_HISTORIES set to a directory, the
 * harness writes the event history of every workflow a test starts, and of each child it starts,
 * to that directory. `tests/workflow/replay.workflow.test.ts` replays them, so a later change that
 * alters the command order of an open run fails a test. The suite only writes fixtures when a
 * human sets the variable; it never rewrites them on its own.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { temporal } from "@temporalio/proto";
import type { Client } from "@temporalio/client";
import { expect } from "vitest";

export const historyExportDirectory = (): string | null => {
  const directory = process.env["FACTOREE_EXPORT_HISTORIES"];
  return directory === undefined || directory === "" ? null : directory;
};

const recorded = new WeakMap<Client, Set<string>>();

/** Wraps `start` and `signalWithStart` of the client once, so every started workflow id is kept. */
export const trackStartedWorkflows = (client: Client): Set<string> => {
  const existing = recorded.get(client);
  if (existing !== undefined) return existing;
  const ids = new Set<string>();
  recorded.set(client, ids);
  const workflow = client.workflow;
  const start = workflow.start.bind(workflow);
  const signalWithStart = workflow.signalWithStart.bind(workflow);
  workflow.start = (async (...args: Parameters<typeof start>) => {
    const handle = await start(...args);
    ids.add(handle.workflowId);
    return handle;
  }) as typeof workflow.start;
  workflow.signalWithStart = (async (...args: Parameters<typeof signalWithStart>) => {
    const handle = await signalWithStart(...args);
    ids.add(handle.workflowId);
    return handle;
  }) as typeof workflow.signalWithStart;
  return ids;
};

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

/** Writes the history of each id, and of each child workflow its history starts, then forgets the ids. */
export const exportHistories = async (client: Client, ids: Set<string>, directory: string): Promise<void> => {
  const test = slug(expect.getState().currentTestName ?? "unnamed");
  const pending = [...ids];
  ids.clear();
  const seen = new Set<string>();
  await mkdir(directory, { recursive: true });
  while (pending.length > 0) {
    const workflowId = pending.shift() ?? "";
    if (seen.has(workflowId)) continue;
    seen.add(workflowId);
    let history: temporal.api.history.v1.IHistory;
    try {
      history = await client.workflow.getHandle(workflowId).fetchHistory();
    } catch (error) {
      // A test that polls for a long time writes a history over the 4 MB gRPC limit. It is no
      // fixture, and the test itself must not fail for it.
      process.stderr.write(`history export skipped ${workflowId}: ${String(error)}\n`);
      continue;
    }
    for (const event of history.events ?? []) {
      const child = event.startChildWorkflowExecutionInitiatedEventAttributes?.workflowId;
      if (child !== undefined && child !== null) pending.push(child);
    }
    const name = `${test}--${slug(workflowId)}.pb.gz`;
    await writeFile(join(directory, name), gzipSync(temporal.api.history.v1.History.encode(history).finish()));
  }
};
