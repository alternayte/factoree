import { describe, expect, it } from "vitest";
import { checkFinding, type RetroSessionInput } from "~/domain/retro/retro-finding.js";
import { renderSignalArguments } from "~/domain/retro/signal-source.js";

// docs/specs/retro-agent.md. An agent claim is never evidence: Factoree keeps a finding only when
// its citations name what the session read and the evidence its kind rests on.
const input: RetroSessionInput = {
  productId: "product-1",
  productNames: ["product-1", "c-dash"],
  runIds: new Set(["run-1", "run-2"]),
  signalResults: new Map([
    ["errors-1", "errors"],
    ["analytics-1", "analytics"],
  ]),
  webResults: new Set(["web-1"]),
  repositories: new Set(["alternayte/c-dash"]),
};

const finding = (overrides: Record<string, unknown>) => ({
  product: "c-dash",
  kind: "factory",
  title: "The verify command fails on a missing fake",
  description: "Three runs failed the same check.",
  runIds: ["run-1"],
  signalResultIds: [],
  repositories: ["alternayte/c-dash"],
  ...overrides,
});

const reasonOf = (raw: unknown): string | null => {
  const checked = checkFinding(raw, input);
  return "dropped" in checked ? checked.dropped.reason : null;
};

describe("the retro finding check", () => {
  it("keeps a factory finding that cites a run of the input", () => {
    expect(checkFinding(finding({}), input)).toMatchObject({ kept: { kind: "factory", runIds: ["run-1"] } });
  });

  it("drops a finding that cites a run outside the input", () => {
    expect(reasonOf(finding({ runIds: ["run-9"] }))).toMatch(/run-9/);
  });

  it("drops a finding that cites a signal result of another product", () => {
    expect(reasonOf(finding({ kind: "error", runIds: [], signalResultIds: ["errors-of-another-product"] }))).toMatch(/not in the retro input/);
  });

  it("drops a finding for another product", () => {
    expect(reasonOf(finding({ product: "anthology" }))).toMatch(/not the product/);
  });

  it("drops each kind that lacks its own evidence", () => {
    expect(reasonOf(finding({ runIds: [] }))).toMatch(/factory finding cites no run/);
    expect(reasonOf(finding({ kind: "error", signalResultIds: ["analytics-1"] }))).toMatch(/errors source/);
    expect(reasonOf(finding({ kind: "idea", runIds: ["run-1"] }))).toMatch(/no analytics result and no web result/);
    expect(reasonOf(finding({ kind: "error", signalResultIds: [], webResultIds: ["web-1"] }))).toMatch(/errors source/);
  });

  it("keeps an idea that cites analytics, and drops a repository the product does not hold", () => {
    expect(checkFinding(finding({ kind: "idea", runIds: [], signalResultIds: ["analytics-1"], repositories: ["alternayte/c-dash", "evil/repo"] }), input)).toMatchObject({
      kept: { kind: "idea", repositories: ["alternayte/c-dash"] },
    });
  });
});

describe("the web result citations", () => {
  // docs/specs/retro-web-research.md. An idea may rest on the web, and only on what the session received.
  it("keeps an idea that cites only a web result of the session", () => {
    expect(checkFinding(finding({ kind: "idea", runIds: [], webResultIds: ["web-1"] }), input)).toMatchObject({ kept: { kind: "idea", webResultIds: ["web-1"] } });
  });

  it("drops a finding that cites a web result of another session", () => {
    expect(reasonOf(finding({ webResultIds: ["web-of-another-session"] }))).toMatch(/did not receive/);
  });
});

describe("the signal query arguments", () => {
  it("replace {since} in every string, nested too", () => {
    const since = new Date("2026-11-18T09:00:00Z");
    expect(renderSignalArguments({ query: "is:unresolved firstSeen:>{since}", filters: [{ after: "{since}" }], limit: 20 }, since)).toEqual({
      query: "is:unresolved firstSeen:>2026-11-18T09:00:00.000Z",
      filters: [{ after: "2026-11-18T09:00:00.000Z" }],
      limit: 20,
    });
  });
});
