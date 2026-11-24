import { describe, expect, it } from "vitest";
import { mentionsApp } from "~/domain/pull-requests/pull-request-event.js";

// docs/specs/pr-feedback-loop.md, DI-21.204. A mention of the Factoree app is a human decision.
describe("mentionsApp", () => {
  it("finds the app slug, with or without [bot], in any case", () => {
    expect(mentionsApp("@factoreetemp rename the prop to label", "factoreetemp")).toBe(true);
    expect(mentionsApp("Please, @FactoreeTemp[bot], use the shared button.", "factoreetemp")).toBe(true);
    expect(mentionsApp("first line\n@factoreetemp: why does this skip the cache?", "factoreetemp")).toBe(true);
  });

  it("refuses a longer slug, an email address, a quote, inline code and a fenced block", () => {
    expect(mentionsApp("@factoreetemp-staging fix it", "factoreetemp")).toBe(false);
    expect(mentionsApp("mail ops@factoreetemp.dev", "factoreetemp")).toBe(false);
    expect(mentionsApp("> @factoreetemp rename it\nThanks, done.", "factoreetemp")).toBe(false);
    expect(mentionsApp("Run `@factoreetemp review` later.", "factoreetemp")).toBe(false);
    expect(mentionsApp("```\n@factoreetemp rename\n```", "factoreetemp")).toBe(false);
  });

  it("finds no mention before setup names the app", () => {
    expect(mentionsApp("@factoreetemp rename", null)).toBe(false);
  });
});
