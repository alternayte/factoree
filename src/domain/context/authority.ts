/**
 * SDD section 22. Authority is domain-specific, so a class can be compared only with another
 * class of the same domain. Inside a domain the specification writes a ladder with `>`, except
 * for current implementation and system topology, which it writes as evidence joined with `+`.
 * Those two domains therefore have one rung, and `compareAuthority` reports `equal` for a pair
 * inside them. The members of those two domains are combined evidence under SDD section 22, so
 * they do not conflict with one another. `detectConflicts` skips such a pair. This corrects
 * DI-4.8, which a review overturned.
 */

export type AuthorityDomain =
  | "product_intent"
  | "architecture_intent"
  | "interface_contract"
  | "current_implementation"
  | "system_topology";

/**
 * The union is written out rather than derived, so the compiler keeps every class name a literal
 * type. A derived union over a nested array widens to `string`, and a widened authority class
 * lets a typing mistake reach the Context Contract.
 */
export type AuthorityClass =
  | "work_item_decision"
  | "approved_product_specification"
  | "product_documentation"
  | "accepted_adr"
  | "approved_architecture_specification"
  | "architecture_documentation"
  | "repository_readme"
  | "machine_readable_contract"
  | "contract_tests"
  | "api_documentation"
  | "prose_documentation"
  | "source_code"
  | "executable_tests"
  | "runtime_behavior"
  | "declarative_catalog"
  | "repository_configuration";

/** Each domain, highest authority first. A rung that holds two classes makes them equal. */
const LADDERS: Record<AuthorityDomain, readonly (readonly AuthorityClass[])[]> = {
  product_intent: [
    ["work_item_decision"],
    ["approved_product_specification"],
    ["product_documentation"],
  ],
  architecture_intent: [
    ["accepted_adr"],
    ["approved_architecture_specification"],
    ["architecture_documentation"],
    ["repository_readme"],
  ],
  interface_contract: [
    ["machine_readable_contract"],
    ["contract_tests"],
    ["api_documentation"],
    ["prose_documentation"],
  ],
  current_implementation: [["source_code", "executable_tests", "runtime_behavior"]],
  system_topology: [["declarative_catalog", "repository_configuration"]],
};

const DOMAIN_ORDER: readonly AuthorityDomain[] = [
  "product_intent",
  "architecture_intent",
  "interface_contract",
  "current_implementation",
  "system_topology",
];

export const AUTHORITY_CLASSES: readonly AuthorityClass[] = DOMAIN_ORDER.flatMap((domain) =>
  LADDERS[domain].flat(),
);

interface Placement {
  domain: AuthorityDomain;
  rank: number;
}

const PLACEMENTS = new Map<string, Placement>(
  DOMAIN_ORDER.flatMap((domain) =>
    LADDERS[domain].flatMap((rung, rank) =>
      rung.map((authority) => [authority, { domain, rank }] as const),
    ),
  ),
);

export const isAuthorityClass = (value: string): value is AuthorityClass => PLACEMENTS.has(value);

const DOMAIN_SET = new Set<string>(DOMAIN_ORDER);

/** A guard for a domain name a database column holds. The store never casts a stored string. */
export const isAuthorityDomain = (value: string): value is AuthorityDomain => DOMAIN_SET.has(value);

const placementOf = (authority: AuthorityClass): Placement => {
  const placement = PLACEMENTS.get(authority);
  if (placement === undefined) {
    throw new Error(`"${authority}" is not an authority class of SDD section 22.`);
  }
  return placement;
};

export const authorityDomainOf = (authority: AuthorityClass): AuthorityDomain =>
  placementOf(authority).domain;

/** The rung inside the domain. Zero is the highest authority. */
export const authorityRankOf = (authority: AuthorityClass): number => placementOf(authority).rank;

/**
 * SDD section 23 permits automatic resolution only when authority policy gives a clear winner.
 * `equal` and `unrelated` both mean no clear winner exists.
 */
export const compareAuthority = (
  a: AuthorityClass,
  b: AuthorityClass,
): "a" | "b" | "equal" | "unrelated" => {
  const left = placementOf(a);
  const right = placementOf(b);
  if (left.domain !== right.domain) return "unrelated";
  if (left.rank < right.rank) return "a";
  if (left.rank > right.rank) return "b";
  return "equal";
};
