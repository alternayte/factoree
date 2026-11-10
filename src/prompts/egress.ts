import type { EgressFacts } from "~/domain/runs/egress.js";

/**
 * docs/specs/egress-honesty-and-issue-status.md, DI-21.46. The body of the "Network access" section
 * of the refiner, implementer and user validator prompts. It names the effective allow list of the
 * sandbox, says that the bootstrap list reached the bootstrap only, and says what a denied host
 * looks like, because E2B gives no egress log and resets a denied TLS connection.
 */
export const egressBody = (facts: EgressFacts, whenMissing: string): string =>
  [
    facts.allowed.length === 0
      ? "This sandbox reaches no host on the network."
      : `This sandbox reaches only these hosts. Factoree denies every other host:\n${facts.allowed.map((host) => `- ${host}`).join("\n")}`,
    "",
    facts.bootstrapOnly.length === 0
      ? "`bootstrap.allowedDomains` in `.factoree/config.yaml` applies to the bootstrap only. It adds no host here."
      : "`bootstrap.allowedDomains` in `.factoree/config.yaml` applies to the bootstrap only. Factoree ran the bootstrap before " +
        `this session, and these hosts are denied now: ${facts.bootstrapOnly.join(", ")}.`,
    "",
    "A denied host can appear as a connection reset, a TLS error or a timeout. That error is a policy block, not a transient fault. " +
      "A retry fails the same way.",
    whenMissing,
  ].join("\n");
