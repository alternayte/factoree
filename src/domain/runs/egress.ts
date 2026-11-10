// The workflow bundler resolves a relative path only, and this module imports nothing at run
// time but `./sandbox.js`, which imports nothing. The workflow renders the failure post from it.
import { allowListCovers } from "./sandbox.js";

/**
 * docs/specs/egress-honesty-and-issue-status.md. One host an agent needs and its egress allow list
 * does not hold, with the reason the agent gave. The refiner proposal and the implementer result
 * carry these as data, so Factoree can act on them (DI-21.47).
 */
export interface MissingHost {
  host: string;
  reason: string;
}

/**
 * The egress facts an agent prompt states (DI-21.46). `allowed` is the effective allow list of the
 * sandbox the agent runs in: the run's `allowedDomains` and the agent hosts. `bootstrapOnly` holds
 * the hosts `bootstrap.allowedDomains` adds for the bootstrap, and no agent reaches.
 */
export interface EgressFacts {
  allowed: string[];
  bootstrapOnly: string[];
}

const MAX_REASON_CHARACTERS = 300;

/**
 * The host part of what an agent named. An agent can write a URL, a host with a port or a host
 * with a trailing dot, and each names the same host (DI-21.47).
 */
export const normalizeHost = (named: string): string => {
  let text = named.trim().toLowerCase();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(text);
  if (scheme !== null) text = text.slice(scheme[0].length);
  text = text.split(/[/?#]/, 1)[0] ?? "";
  const at = text.lastIndexOf("@");
  if (at >= 0) text = text.slice(at + 1);
  text = text.replace(/:\d+$/, "").replace(/\.+$/, "");
  return text;
};

export interface MissingHostsGate {
  /** The hosts the effective allow list does not hold. Any one of them ends the Run. */
  missing: MissingHost[];
  /** The hosts the effective allow list already holds. The agent misread a fault. */
  dropped: MissingHost[];
}

/**
 * docs/specs/egress-honesty-and-issue-status.md, DI-21.48. Factoree drops a named host that the
 * effective allow list already holds, a wildcard entry included. Every other named host stays, and
 * one host is named once, with the first reason given for it. An empty name is no host.
 */
export const gateMissingHosts = (named: readonly MissingHost[], allowList: readonly string[]): MissingHostsGate => {
  const missing: MissingHost[] = [];
  const dropped: MissingHost[] = [];
  const seen = new Set<string>();
  for (const entry of named) {
    const host = normalizeHost(entry.host);
    if (host === "" || seen.has(host)) continue;
    seen.add(host);
    const reason = entry.reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARACTERS);
    (allowListCovers(allowList, host) ? dropped : missing).push({ host, reason });
  }
  return { missing, dropped };
};

/**
 * DI-21.48. The failure message of a Run that needs a host outside its allow list. It names each
 * host and its reason, and where to add the host. A repository list narrows the product list, so a
 * repository that declares a non-empty `sandbox.allowedDomains` needs the host there as well. The
 * configuration failure post appends the request for a reply (DI-21.32).
 */
export const renderMissingHostsFailure = (input: {
  role: "refiner" | "implementer";
  hosts: readonly MissingHost[];
  productSlug: string;
  productPageUrl: string | null;
  repositorySlug: string;
  repositoryListDeclared: boolean;
}): string => {
  const who = input.role === "refiner" ? "The Refiner" : "The Implementer";
  const page = input.productPageUrl === null ? "the product page" : `the product page ${input.productPageUrl}`;
  const one = input.hosts.length === 1;
  return [
    `Factoree stopped the Run, because the egress allow list of this Run does not hold ${one ? "a host" : "hosts"} the work needs. ` +
      `${who} named ${one ? "it" : "them"}:`,
    "",
    ...input.hosts.map((entry) => `- \`${entry.host}\`: ${entry.reason === "" ? "no reason given" : entry.reason}`),
    "",
    `Add ${one ? "the host" : "each host"} to the allow list of the product ${input.productSlug} on ${page}.` +
      (input.repositoryListDeclared
        ? ` The repository ${input.repositorySlug} declares \`sandbox.allowedDomains\` in \`.factoree/config.yaml\`, and that list narrows the product list, so add ${one ? "the host" : "each host"} there as well.`
        : ""),
    "`bootstrap.allowedDomains` applies to the bootstrap only, so a host there does not reach an agent. Factoree published nothing.",
  ].join("\n");
};
