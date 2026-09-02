import { describe, expect, it } from "vitest";
import { parseWorkItem } from "~/domain/refinement/work-item.js";

const source = (description: string, title = "Add a webhook retry") => ({
  issueId: "issue-1",
  title,
  description,
  url: "https://linear.app/acme/issue/ACME-1",
  labels: [] as string[],
});

const structured = `
## Goal

Deliveries must survive a transient receiver outage.

## Acceptance criteria

- AC-1: A failed delivery is retried three times.
- A delivery that never succeeds is recorded as failed.

## Constraints

- Do not change the public webhook payload.

## References

- https://example.com/adr/031
- acme/notification-service
`;

describe("parseWorkItem", () => {
  it("reads every documented section of SDD section 7", () => {
    const item = parseWorkItem(source(structured));
    expect(item.goal).toBe(
      "Add a webhook retry\n\nDeliveries must survive a transient receiver outage.",
    );
    expect(item.acceptanceCriteria).toEqual([
      { id: "AC-1", statement: "A failed delivery is retried three times.", source: "linear:issue-1" },
      {
        id: "AC-2",
        statement: "A delivery that never succeeds is recorded as failed.",
        source: "linear:issue-1",
      },
    ]);
    expect(item.constraints).toEqual(["Do not change the public webhook payload."]);
    expect(item.references).toEqual([
      { kind: "url", value: "https://example.com/adr/031" },
      { kind: "repository", value: "acme/notification-service" },
    ]);
    expect(item.openQuestions).toEqual([]);
  });

  it("treats a body with no heading as the goal", () => {
    const item = parseWorkItem(source("Retries are missing and deliveries are lost."));
    expect(item.goal).toBe("Add a webhook retry\n\nRetries are missing and deliveries are lost.");
    expect(item.acceptanceCriteria).toEqual([]);
  });

  it("uses the title alone when the body is empty", () => {
    expect(parseWorkItem(source("")).goal).toBe("Add a webhook retry");
  });

  it("folds a preamble before the first heading into the goal, with no goal heading present", () => {
    const item = parseWorkItem(
      source("This must handle timeouts.\n\n## Constraints\n\n- keep API stable\n"),
    );
    expect(item.goal).toBe("Add a webhook retry\n\nThis must handle timeouts.");
    expect(item.constraints).toEqual(["keep API stable"]);
  });

  it("puts a preamble before the first heading ahead of the goal section text", () => {
    const item = parseWorkItem(source("Preamble line.\n\n## Goal\n\nGoal text.\n"));
    expect(item.goal).toBe("Add a webhook retry\n\nPreamble line.\n\nGoal text.");
  });

  it("keeps an unrecognised heading inside the section it follows", () => {
    const item = parseWorkItem(source("## Goal\n\nFix it.\n\n### Background\n\nIt broke.\n"));
    expect(item.goal).toBe("Add a webhook retry\n\nFix it.\n\n### Background\n\nIt broke.");
  });

  it("reads a heading of any level and ignores its punctuation and case", () => {
    const item = parseWorkItem(source("#### ACCEPTANCE CRITERIA:\n\n- It works.\n"));
    expect(item.acceptanceCriteria).toEqual([
      { id: "AC-1", statement: "It works.", source: "linear:issue-1" },
    ]);
  });

  it("numbers an unmarked criterion by its position over the whole section", () => {
    const item = parseWorkItem(source("## Acceptance criteria\n\n- One.\n- AC-7: Seven.\n- Three.\n"));
    expect(item.acceptanceCriteria.map((criterion) => criterion.id)).toEqual(["AC-1", "AC-7", "AC-3"]);
  });

  it("marks the source as unknown when the issue has no identifier", () => {
    const item = parseWorkItem({
      issueId: null,
      title: "T",
      description: "## Acceptance criteria\n\n- One.\n",
      url: null,
      labels: [],
    });
    expect(item.acceptanceCriteria[0]?.source).toBe("linear:unknown");
  });

  it("reads a constraints section that uses plain lines", () => {
    const item = parseWorkItem(source("## Constraints\n\nKeep the API stable.\nDo not add a dependency.\n"));
    expect(item.constraints).toEqual(["Keep the API stable.", "Do not add a dependency."]);
  });

  it("reads a markdown link target as a reference", () => {
    const item = parseWorkItem(source("## References\n\n- [ADR 31](https://example.com/adr/031)\n"));
    expect(item.references).toEqual([{ kind: "url", value: "https://example.com/adr/031" }]);
  });

  it("rejects a slug half that is a dot segment", () => {
    const item = parseWorkItem(source("## References\n\n- owner/.\n- ../repo\n"));
    expect(item.references).toEqual([{ kind: "text", value: "owner/." }, { kind: "text", value: "../repo" }]);
  });

  it("collects an open questions section", () => {
    const item = parseWorkItem(source("## Open questions\n\n- Which queue do we use?\n"));
    expect(item.openQuestions).toEqual(["Which queue do we use?"]);
  });

  it("collects a question mark line from the goal", () => {
    const item = parseWorkItem(source("## Goal\n\nRetry deliveries.\nDo we retry a 4xx response?\n"));
    expect(item.openQuestions).toEqual(["Do we retry a 4xx response?"]);
  });

  it("collects a question mark line from the acceptance criteria", () => {
    const item = parseWorkItem(source("## Acceptance criteria\n\n- How many retries?\n"));
    expect(item.openQuestions).toEqual(["How many retries?"]);
  });

  it("keeps the labels of the source", () => {
    const item = parseWorkItem({ ...source(""), labels: ["security", "backend"] });
    expect(item.labels).toEqual(["security", "backend"]);
  });

  it("returns no empty string in any list", () => {
    const item = parseWorkItem(source("## Constraints\n\n-\n-   \n- Real.\n"));
    expect(item.constraints).toEqual(["Real."]);
  });
});

describe("parseWorkItem, a section title without a markdown heading", () => {
  // The Linear editor stores a heading a human typed as ordinary text, so an issue that reads
  // correctly in Linear arrives with `## Acceptance criteria` flattened. A real Run proved the
  // cost: refinement found no criteria and derived one from every sentence, the title included,
  // and each needed a human.
  const parse = (description: string) =>
    parseWorkItem({
      title: "Show the app version in the dashboard footer",
      description,
      labels: [],
      issueId: "issue-1",
      url: "https://linear.app/factoree/issue/issue-1",
    });

  it("reads a bare section title as a section", () => {
    const item = parse(
      [
        "Add the package version to the footer component.",
        "",
        "Acceptance criteria",
        "",
        "* The command `npm run type-check` exits with code 0.",
        "* The command `npm test` exits with code 0.",
      ].join("\n"),
    );

    expect(item.acceptanceCriteria.map((criterion) => criterion.statement)).toEqual([
      "The command `npm run type-check` exits with code 0.",
      "The command `npm test` exits with code 0.",
    ]);
    expect(item.goal).not.toContain("npm run type-check");
  });

  it("reads a bare title that carries emphasis or a colon", () => {
    for (const heading of ["**Acceptance criteria**", "Acceptance criteria:", "ACCEPTANCE CRITERIA"]) {
      const item = parse([`Do the thing.`, "", heading, "", "- The command `npm test` exits with code 0."].join("\n"));
      expect(item.acceptanceCriteria, heading).toHaveLength(1);
    }
  });

  it("leaves a sentence that merely mentions the words as ordinary text", () => {
    const item = parse(
      ["The acceptance criteria of the parent issue still apply here.", "", "## Constraints", "", "- Touch one file."].join("\n"),
    );

    expect(item.acceptanceCriteria).toEqual([]);
    expect(item.goal).toContain("acceptance criteria of the parent issue");
    expect(item.constraints).toEqual(["Touch one file."]);
  });
});
