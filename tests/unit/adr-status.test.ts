import { describe, expect, it } from "vitest";
import { readAdrStatus } from "~/domain/context/adr-status.js";

describe("readAdrStatus (GitHub issue 60)", () => {
  it("reads a plain status line", () => {
    expect(readAdrStatus("# ADR 31\n\nStatus: accepted\n")).toEqual({ kind: "accepted" });
  });

  it("reads a bold status bullet and the first word of a longer value", () => {
    const record = "# Durable orchestration\n\n- **Status:** Proposed. Requires architect review.\n- **Date:** 2026-09-25\n";
    expect(readAdrStatus(record)).toEqual({ kind: "not_accepted", status: "proposed" });
  });

  it("reads YAML front matter", () => {
    expect(readAdrStatus("---\ntitle: Queue\nstatus: superseded by ADR-7\n---\n# Queue\n")).toEqual({
      kind: "not_accepted",
      status: "superseded",
    });
  });

  it("reads JSON metadata in an HTML comment", () => {
    const record = '<!--\n---\n{\n  "title": "ADR-002",\n  "status": "In Review",\n  "approvals": []\n}\n---\n-->\n# ADR-002\n';
    expect(readAdrStatus(record)).toEqual({ kind: "not_accepted", status: "in review" });
  });

  it("reads a status heading", () => {
    expect(readAdrStatus("# 7. Use a queue\n\n## Status\n\nDeprecated\n\n## Context\n")).toEqual({
      kind: "not_accepted",
      status: "deprecated",
    });
  });

  it("reads a status column of a metadata table", () => {
    const record = "# ADR-001\n\n| **Creation Date** | **Status** |\n| :---------------: | :--------: |\n|    2026-02-06     |  Accepted  |\n";
    expect(readAdrStatus(record)).toEqual({ kind: "accepted" });
  });

  it("treats approved as accepted", () => {
    expect(readAdrStatus('{ "status": "Approved" }')).toEqual({ kind: "accepted" });
  });

  it("reports a record without a status as unstated", () => {
    expect(readAdrStatus("# Queue\n\nWe use a queue.\n")).toEqual({ kind: "unstated" });
  });

  it("reports a status it does not know as unstated, so the path keeps deciding", () => {
    expect(readAdrStatus("Status: the service status is green\n")).toEqual({ kind: "unstated" });
  });

  it("reads only the header of a record", () => {
    const record = `# Queue\n\n${"Body line.\n".repeat(80)}Status: rejected\n`;
    expect(readAdrStatus(record)).toEqual({ kind: "unstated" });
  });
});
