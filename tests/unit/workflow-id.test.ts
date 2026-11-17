import { describe, expect, it } from "vitest";
import { buildPrFollowUpWorkflowId, buildWorkflowId, isPrFollowUpWorkflowId, parseWorkflowId } from "~/temporal/workflow-id.js";

describe("buildWorkflowId", () => {
  it("uses the SDD section 26 format", () => {
    expect(buildWorkflowId("workspace-123", "session-1")).toBe("linear:workspace-123:session-1");
  });

  it("rejects an empty part", () => {
    expect(() => buildWorkflowId("", "session-1")).toThrow();
    expect(() => buildWorkflowId("workspace-123", "")).toThrow();
  });
});

describe("parseWorkflowId", () => {
  it("reads back the parts of a built identifier", () => {
    expect(parseWorkflowId(buildWorkflowId("workspace-123", "session-1"))).toEqual({
      workspaceId: "workspace-123",
      agentSessionId: "session-1",
    });
  });

  it("rejects a malformed identifier", () => {
    expect(() => parseWorkflowId("linear:workspace-123")).toThrow();
    expect(() => parseWorkflowId("other:workspace-123:session-1")).toThrow();
    expect(() => parseWorkflowId("linear::session-1")).toThrow();
    expect(() => parseWorkflowId("linear:workspace-123:session-1:extra")).toThrow();
  });

  // D6. The worker resolves the Linear workspace of a PR follow-up run from its workflow id.
  it("parses the workflow id of a PR follow-up run", () => {
    const id = buildPrFollowUpWorkflowId("workspace-123", "session-1", "0123abcd");
    expect(parseWorkflowId(id)).toEqual({ workspaceId: "workspace-123", agentSessionId: "session-1" });
    expect(isPrFollowUpWorkflowId(id)).toBe(true);
    expect(isPrFollowUpWorkflowId(buildWorkflowId("workspace-123", "session-1"))).toBe(false);
    expect(() => buildPrFollowUpWorkflowId("workspace-123", "session-1", "a:b")).toThrow();
  });
});
