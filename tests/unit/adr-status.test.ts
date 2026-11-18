import { describe, expect, it } from "vitest";
import { readAdrStatus } from "~/domain/context/adr-status.js";

describe("readAdrStatus", () => {
  it.each([
    ["a Nygard Status section", "# 1. Queue\n\nDate: 2020-01-02\n\n## Status\n\nAccepted\n\n## Context\n\nText.\n", "accepted"],
    ["a Nygard date and status", "# 1. Queue\n\n## Status\n\n2020-01-02 accepted\n", "accepted"],
    ["a MADR 2 bullet", "# Queue\n\n* Status: accepted\n* Deciders: team\n", "accepted"],
    ["a bold bullet", "# Queue\n\n- **Status:** Proposed\n", "documentation"],
    ["MADR 3 front matter", "---\nstatus: \"proposed\"\ndate: 2024-01-01\n---\n# Queue\n", "documentation"],
    ["upper-case quoted front matter", "---\nStatus: 'Accepted'\n---\n# Queue\n", "accepted"],
    ["a heading with a colon", "# Queue\n\n### Status:\n\nAccepted\n", "accepted"],
    ["a heading with the value", "# Queue\n\n## Status: Rejected\n", "excluded"],
    ["single-line JSON", '<!-- {"title":"x","status":"Approved"} -->\n# Queue\n', "accepted"],
    ["a checkbox", "# Queue\n\n## Status\n\n[x] Accepted\n", "accepted"],
    ["not accepted", "# Queue\n\n## Status\n\nNot accepted\n", "documentation"],
    ["superseded after accepted", "# Queue\n\nStatus: Accepted (superseded by ADR-12)\n", "excluded"],
    ["superseded on a later line", "# Queue\n\n## Status\n\nAccepted\n\nSuperseded by ADR-12\n\n## Context\n", "excluded"],
    ["supersedes another record", "# Queue\n\n## Status\n\nAccepted\n\nSupersedes ADR-3\n", "accepted"],
    ["deprecated", "# Queue\n\nStatus: Deprecated\n", "excluded"],
    ["no status", "# Queue\n\nWe use a queue.\n", "documentation"],
    ["an unknown status", "# Queue\n\nStatus: Pondering\n", "documentation"],
    ["CRLF and a byte-order mark", "﻿# Queue\r\n\r\n## Status\r\n\r\nAccepted\r\n", "accepted"],
  ])("reads %s", (_name, content, status) => {
    expect(readAdrStatus(content)).toBe(status);
  });

  it("ignores a status line in the body after the Status section", () => {
    const content = "# Queue\n\n## Status\n\nAccepted\n\n## Decision\n\n- status: pending is a field of the job\n";
    expect(readAdrStatus(content)).toBe("accepted");
  });

  it("ignores a status line in fenced code", () => {
    const content = "# Queue\n\n```yaml\nstatus: draft\n```\n\n## Status\n\nAccepted\n";
    expect(readAdrStatus(content)).toBe("accepted");
  });

  it("does not read a table of other records as its own status", () => {
    const content = "# Index\n\n## Status\n\nAccepted\n\n## Related\n\n| ADR | Status |\n|---|---|\n| 3 | Superseded |\n";
    expect(readAdrStatus(content)).toBe("accepted");
  });
});
