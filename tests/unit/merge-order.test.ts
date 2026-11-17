import { describe, expect, it } from "vitest";
import { mergeOrderDecision, mergeOrderOf, type TargetEdge } from "~/domain/runs/merge-order.js";

const edge = (provider: string, consumer: string): TargetEdge => ({ provider, consumer, file: "src/client.ts", line: 3 });

describe("mergeOrderOf (docs/specs/change-sets.md, DI-21.141)", () => {
  it("places each provider before its consumers, and gives no place to a target no edge names", () => {
    const order = mergeOrderOf(["acme/web", "acme/api", "acme/docs", "acme/auth"], [edge("acme/api", "acme/web"), edge("acme/auth", "acme/api")]);
    expect(order).toEqual({
      kind: "ordered",
      places: [
        { repository: "acme/auth", place: 1 },
        { repository: "acme/api", place: 2 },
        { repository: "acme/web", place: 3 },
      ],
    });
  });

  it("gives no order without an edge", () => {
    expect(mergeOrderOf(["acme/api", "acme/web"], [])).toEqual({ kind: "none" });
  });

  it("gives no target a place when the edges form a cycle, and states that no safe order exists", () => {
    const edges = [edge("acme/api", "acme/web"), edge("acme/web", "acme/api")];
    const order = mergeOrderOf(["acme/api", "acme/web"], edges);
    expect(order).toEqual({ kind: "cycle", repositories: ["acme/api", "acme/web"] });
    expect(mergeOrderDecision(order, edges)?.reason).toContain("no safe merge order exists");
  });
});
