import { describe, expect, it } from "vitest";
import { buildWorkflowId } from "~/temporal/workflow-id.js";

describe("buildWorkflowId", () => {
  it("uses the SDD section 26 format", () => {
    expect(buildWorkflowId("workspace-123", "session-1")).toBe("linear:workspace-123:session-1");
  });

  it("rejects an empty part", () => {
    expect(() => buildWorkflowId("", "session-1")).toThrow();
    expect(() => buildWorkflowId("workspace-123", "")).toThrow();
  });
});
