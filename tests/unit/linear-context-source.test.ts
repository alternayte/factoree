import { describe, expect, it } from "vitest";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import type { ContextDiscoveryRequest } from "~/domain/context/context-source.js";

const request = (over: Partial<ContextDiscoveryRequest> = {}): ContextDiscoveryRequest => ({
  runId: "run-1",
  goal: "Retry webhook deliveries.",
  topics: ["deliveries", "retry", "webhook"],
  primaryRepository: { slug: "acme/webhook-service", url: "https://git/acme/webhook-service", ref: "main" },
  referenceRepositories: [],
  workItemReferences: [],
  decisions: [],
  ...over,
});

describe("LinearContextSource", () => {
  it("identifies itself as linear", () => {
    expect(new LinearContextSource().id()).toBe("linear");
  });

  it("offers the Work Item as a required product intent item", async () => {
    const [candidate] = await new LinearContextSource().discover(request());
    expect(candidate?.reference).toEqual({
      sourceId: "linear",
      ref: "linear:issue:run-1",
      repository: null,
      sha: null,
      path: null,
    });
    expect(candidate?.authority).toBe("work_item_decision");
    expect(candidate?.suggestedClassification).toBe("required");
    expect(candidate?.priority).toBe(1);
    expect(candidate?.reason).toBe("the Work Item is the product intent of this Run");
  });

  it("offers every recorded human decision as a required item", async () => {
    const candidates = await new LinearContextSource().discover(
      request({
        decisions: [{ questionId: "Q-1", question: "Do we retry a 4xx response?", answer: "No." }],
      }),
    );
    const decision = candidates.find((candidate) => candidate.reference.ref === "linear:decision:Q-1");
    expect(decision?.authority).toBe("work_item_decision");
    expect(decision?.suggestedClassification).toBe("required");
    expect(decision?.reason).toBe('a human answered "Do we retry a 4xx response?"');
  });

  it("offers a declared link as a discoverable item", async () => {
    const candidates = await new LinearContextSource().discover(
      request({ workItemReferences: ["https://example.com/adr/031"] }),
    );
    const link = candidates.find((candidate) => candidate.reference.ref === "linear:reference:1");
    expect(link?.suggestedClassification).toBe("discoverable");
    expect(link?.authority).toBe("product_documentation");
  });

  it("returns the Work Item text from fetch", async () => {
    const source = new LinearContextSource();
    await source.discover(request());
    const document = await source.fetch({
      sourceId: "linear",
      ref: "linear:issue:run-1",
      repository: null,
      sha: null,
      path: null,
    });
    expect(document.content).toBe("Retry webhook deliveries.");
  });

  it("returns the answer text of a decision from fetch", async () => {
    const source = new LinearContextSource();
    await source.discover(
      request({ decisions: [{ questionId: "Q-1", question: "How many retries?", answer: "Three." }] }),
    );
    const document = await source.fetch({
      sourceId: "linear",
      ref: "linear:decision:Q-1",
      repository: null,
      sha: null,
      path: null,
    });
    expect(document.content).toBe("How many retries?\n\nThree.");
  });

  it("rejects a reference it never offered", async () => {
    const source = new LinearContextSource();
    await source.discover(request());
    await expect(
      source.fetch({ sourceId: "linear", ref: "linear:absent", repository: null, sha: null, path: null }),
    ).rejects.toThrow(/linear:absent/);
  });
});
