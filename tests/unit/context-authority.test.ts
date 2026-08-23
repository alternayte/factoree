import { describe, expect, it } from "vitest";
import {
  AUTHORITY_CLASSES,
  authorityDomainOf,
  authorityRankOf,
  compareAuthority,
} from "~/domain/context/authority.js";

describe("authority", () => {
  it("lists every class of SDD section 22", () => {
    expect([...AUTHORITY_CLASSES]).toEqual([
      "work_item_decision",
      "approved_product_specification",
      "product_documentation",
      "accepted_adr",
      "approved_architecture_specification",
      "architecture_documentation",
      "repository_readme",
      "machine_readable_contract",
      "contract_tests",
      "api_documentation",
      "prose_documentation",
      "source_code",
      "executable_tests",
      "runtime_behavior",
      "declarative_catalog",
      "repository_configuration",
    ]);
  });

  it("places each class in its SDD section 22 domain", () => {
    expect(authorityDomainOf("work_item_decision")).toBe("product_intent");
    expect(authorityDomainOf("accepted_adr")).toBe("architecture_intent");
    expect(authorityDomainOf("repository_readme")).toBe("architecture_intent");
    expect(authorityDomainOf("machine_readable_contract")).toBe("interface_contract");
    expect(authorityDomainOf("source_code")).toBe("current_implementation");
    expect(authorityDomainOf("declarative_catalog")).toBe("system_topology");
  });

  it("ranks the product intent ladder", () => {
    expect(authorityRankOf("work_item_decision")).toBe(0);
    expect(authorityRankOf("approved_product_specification")).toBe(1);
    expect(authorityRankOf("product_documentation")).toBe(2);
  });

  it("ranks the architecture intent ladder", () => {
    expect(authorityRankOf("accepted_adr")).toBe(0);
    expect(authorityRankOf("approved_architecture_specification")).toBe(1);
    expect(authorityRankOf("architecture_documentation")).toBe(2);
    expect(authorityRankOf("repository_readme")).toBe(3);
  });

  it("ranks the interface contract ladder", () => {
    expect(authorityRankOf("machine_readable_contract")).toBe(0);
    expect(authorityRankOf("contract_tests")).toBe(1);
    expect(authorityRankOf("api_documentation")).toBe(2);
    expect(authorityRankOf("prose_documentation")).toBe(3);
  });

  it("gives current implementation one rung, because SDD section 22 joins its evidence", () => {
    expect(authorityRankOf("source_code")).toBe(0);
    expect(authorityRankOf("executable_tests")).toBe(0);
    expect(authorityRankOf("runtime_behavior")).toBe(0);
  });

  it("gives system topology one rung", () => {
    expect(authorityRankOf("declarative_catalog")).toBe(0);
    expect(authorityRankOf("repository_configuration")).toBe(0);
  });

  it("lets an accepted ADR win over a repository README", () => {
    expect(compareAuthority("accepted_adr", "repository_readme")).toBe("a");
    expect(compareAuthority("repository_readme", "accepted_adr")).toBe("b");
  });

  it("reports two accepted ADRs as equal, so no automatic resolution exists", () => {
    expect(compareAuthority("accepted_adr", "accepted_adr")).toBe("equal");
  });

  it("reports two classes of different domains as unrelated", () => {
    expect(compareAuthority("accepted_adr", "work_item_decision")).toBe("unrelated");
  });

  it("reports source code and executable tests as equal", () => {
    expect(compareAuthority("source_code", "executable_tests")).toBe("equal");
  });
});
