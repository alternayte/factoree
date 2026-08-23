import { describe, expect, it } from "vitest";
import { topicsOf } from "~/domain/context/topics.js";

describe("topicsOf", () => {
  it("keeps a significant word of the goal", () => {
    expect(topicsOf({ goal: "Retry webhook deliveries", acceptanceCriteria: [] })).toEqual([
      "deliveries",
      "retry",
      "webhook",
    ]);
  });

  it("removes a stop word", () => {
    expect(topicsOf({ goal: "Retry the delivery when it fails", acceptanceCriteria: [] })).toEqual([
      "delivery",
      "fails",
      "retry",
    ]);
  });

  it("removes a word shorter than four characters", () => {
    expect(topicsOf({ goal: "Fix the api now", acceptanceCriteria: [] })).toEqual([]);
  });

  it("reads the acceptance criteria as well", () => {
    expect(topicsOf({ goal: "Retry", acceptanceCriteria: ["Notification is queued"] })).toEqual([
      "notification",
      "queued",
      "retry",
    ]);
  });

  it("returns each topic once, sorted", () => {
    expect(topicsOf({ goal: "Retry retry RETRY", acceptanceCriteria: ["retry"] })).toEqual(["retry"]);
  });

  it("splits on punctuation and on a hyphen", () => {
    expect(topicsOf({ goal: "notification-service, please", acceptanceCriteria: [] })).toEqual([
      "notification",
      "please",
      "service",
    ]);
  });

  it("returns nothing for an empty Work Item", () => {
    expect(topicsOf({ goal: "", acceptanceCriteria: [] })).toEqual([]);
  });
});
