import { describe, expect, it } from "vitest";
import { ActionDeniedError, buildActionPolicy } from "~/domain/policy/action-policy.js";

describe("buildActionPolicy", () => {
  it("uses the SDD section 29 default table", () => {
    const policy = buildActionPolicy();
    expect(policy.decide("readPrimaryRepository")).toBe("allow");
    expect(policy.decide("writePrimaryWorktree")).toBe("allow");
    expect(policy.decide("readReferenceRepository")).toBe("allow");
    expect(policy.decide("writeReferenceRepository")).toBe("deny");
    expect(policy.decide("runProjectCommands")).toBe("allow");
    expect(policy.decide("installApprovedDependencies")).toBe("allow");
    expect(policy.decide("arbitraryOutboundNetwork")).toBe("deny");
    expect(policy.decide("approvedRegistries")).toBe("allow");
    expect(policy.decide("approvedTestServices")).toBe("allow");
    expect(policy.decide("stagingRead")).toBe("deny");
    expect(policy.decide("stagingWrite")).toBe("deny");
    expect(policy.decide("gitRemoteWriteFromAgent")).toBe("deny");
    expect(policy.decide("productionAccess")).toBe("deny");
    expect(policy.decide("merge")).toBe("deny");
  });

  it("allows staging read only when the Project configures it", () => {
    expect(buildActionPolicy({ stagingRead: true }).decide("stagingRead")).toBe("allow");
  });

  it("never allows an override of a denied action other than staging read", () => {
    const policy = buildActionPolicy({ stagingRead: true });
    expect(policy.decide("productionAccess")).toBe("deny");
    expect(policy.decide("merge")).toBe("deny");
    expect(policy.decide("gitRemoteWriteFromAgent")).toBe("deny");
  });

  it("throws ActionDeniedError from assertAllowed for a denied action", () => {
    expect(() => buildActionPolicy().assertAllowed("gitRemoteWriteFromAgent")).toThrow(ActionDeniedError);
  });

  it("returns without throwing from assertAllowed for an allowed action", () => {
    expect(() => buildActionPolicy().assertAllowed("writePrimaryWorktree")).not.toThrow();
  });

  it("exposes a human readable table for the Implementer prompt", () => {
    const lines = buildActionPolicy().describe();
    expect(lines).toContain("deny: write a reference repository");
    expect(lines).toContain("allow: write the primary worktree");
  });
});
