import { describe, expect, it } from "vitest";
import {
  ActionDeniedError,
  buildActionPolicy,
  decideSiblingAction,
  McpToolDeniedError,
} from "~/domain/policy/action-policy.js";

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

describe("the MCP tool gate of SDD section 58", () => {
  it("denies every tool by default", () => {
    const policy = buildActionPolicy({});
    expect(policy.decideMcpTool("search_docs")).toBe("deny");
  });

  it("allows only a tool the Project allow-listed by name", () => {
    const policy = buildActionPolicy({ mcpAllowedTools: ["search_docs"] });
    expect(policy.decideMcpTool("search_docs")).toBe("allow");
    expect(policy.decideMcpTool("delete_everything")).toBe("deny");
  });

  it("treats a wildcard as a tool name, so it grants nothing broad", () => {
    const policy = buildActionPolicy({ mcpAllowedTools: ["*"] });
    expect(policy.decideMcpTool("search_docs")).toBe("deny");
  });

  it("throws with the tool name when a call is refused", () => {
    expect(() => buildActionPolicy({}).assertMcpTool("search_docs")).toThrow(/search_docs/);
    expect(() => buildActionPolicy({}).assertMcpTool("search_docs")).toThrow(McpToolDeniedError);
  });
});

describe("decideSiblingAction, the gate on a sibling repository of the Run's Product", () => {
  it("allows a read-only clone of a member repository", () => {
    expect(
      decideSiblingAction({ action: "clone_sibling", fullName: "acme/web", members: ["acme/api", "acme/web"] }),
    ).toBe("allow");
  });

  it("denies a clone of a repository outside the Product", () => {
    expect(
      decideSiblingAction({ action: "clone_sibling", fullName: "acme/other", members: ["acme/api", "acme/web"] }),
    ).toBe("deny");
  });

  it("denies a write to a sibling, even a member repository", () => {
    expect(
      decideSiblingAction({ action: "write_sibling", fullName: "acme/web", members: ["acme/api", "acme/web"] }),
    ).toBe("deny");
  });
});
