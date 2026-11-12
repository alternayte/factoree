import { describe, expect, it } from "vitest";
import { readStopRequest, stopResponse } from "~/domain/runs/run-stop.js";

// Issue #45. The stop message names where the stop came from, and a Linear stop keeps its wording.
describe("the final response of a stopped run", () => {
  it("keeps the Linear wording for a Linear stop and for a stop with no payload", () => {
    expect(stopResponse({ source: "linear" }, null)).toBe("Factoree stopped this Run at your request. No change was published.");
    expect(stopResponse(readStopRequest(undefined), "https://github.com/a/b/pull/1")).toBe(
      "Factoree stopped this Run at your request. The verified change is already published and waits for a human. " +
        "Pull request: https://github.com/a/b/pull/1.",
    );
  });

  it("names the Factoree UI and the admin for a Factoree UI stop", () => {
    expect(stopResponse(readStopRequest({ source: "factoree_ui", by: "Ada Admin" }), null)).toBe(
      "Stopped from the Factoree UI by Ada Admin. No change was published.",
    );
    expect(stopResponse(readStopRequest({ source: "factoree_ui", by: "" }), null)).toBe(
      "Stopped from the Factoree UI. No change was published.",
    );
  });

  it("reads an unknown source as no payload", () => {
    expect(readStopRequest({ source: "slack" })).toBeNull();
    expect(readStopRequest("stop")).toBeNull();
  });
});
