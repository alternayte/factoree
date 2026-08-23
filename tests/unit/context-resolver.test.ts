import { describe, expect, it } from "vitest";
import { ContextResolver, MAX_AUTOMATIC_REFERENCE_REPOSITORIES } from "~/domain/context/context-resolver.js";
import { ContextSourceRegistry } from "~/domain/context/context-source-registry.js";
import { LinearContextSource } from "~/domain/context/linear-source.js";
import { RepositoryContextSource } from "~/domain/context/repository-source.js";
import {
  CONTEXT_REQUIRED_MAX_BYTES,
  CONTEXT_REQUIRED_MAX_ITEMS,
} from "~/domain/context/context-contract.js";
import { FakeRepositoryReader } from "../support/fake-repository-reader.js";
import { DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION } from "~/domain/context/repository-context-configuration.js";
import type { ResolveContextInput } from "~/domain/context/context-resolver.js";
import type { ContextCandidate, ContextSource } from "~/domain/context/context-source.js";
import { DISCOVERY_PRIORITY } from "~/domain/context/context-source.js";

/**
 * A stub `ContextSource` that mimics a Backstage discovery pass. It reports one candidate per
 * configured repository, and every candidate carries `discoveredRepository`. The resolver, not
 * the source, decides whether the repository becomes a reference repository of the Run. The URL
 * it reports is the bare clone URL, matching what a real catalog entity carries, so the resolver
 * grows it into the checkout URL the same way `BackstageContextSource` does.
 */
const discoveringSource = (
  ...repositories: Array<{ slug: string; url: string }>
): ContextSource => {
  const bareUrl = (url: string): string => (url.endsWith(".git") ? url.slice(0, -4) : url);
  const id = "discovering-source";
  return {
    id: () => id,
    discover: (request): Promise<ContextCandidate[]> =>
      Promise.resolve(
        repositories.map((repository) => ({
          reference: {
            sourceId: id,
            ref: `discovering-source:${repository.slug}`,
            repository: null,
            sha: null,
            path: null,
          },
          sourceVersion: "1",
          authority: "declarative_catalog",
          reason: "the Backstage catalog names this repository as a location of a related component",
          priority: DISCOVERY_PRIORITY.backstage_relation,
          topics: request.topics,
          sizeBytes: null,
          suggestedClassification: "reference",
          discoveredRepository: { slug: repository.slug, url: bareUrl(repository.url) },
        })),
      ),
    fetch: () => Promise.reject(new Error("discoveringSource never offers fetchable content")),
  };
};

const PRIMARY_URL = "https://git/acme/webhook-service";
const REFERENCE_URL = "https://git/acme/notification-service";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const primaryFiles = {
  "README.md": "# Webhook service\n\nThe README says notification retry is owned here.\n",
  "docs/ADR-031.md": "# ADR 31\n\nStatus: accepted\n\nNotification retry is owned elsewhere.\n",
  "src/retry.ts": "export const retry = () => undefined;\n",
  "tests/retry.test.ts": "it('retries', () => undefined);\n",
};

const build = (
  over: {
    primary?: Record<string, string>;
    reference?: Record<string, string>;
  } = {},
) => {
  const reader = new FakeRepositoryReader({
    [PRIMARY_URL]: { sha: SHA_A, files: over.primary ?? primaryFiles },
    [REFERENCE_URL]: { sha: SHA_B, files: over.reference ?? { "openapi.yaml": "openapi: 3.1.0\n" } },
  });
  const registry = new ContextSourceRegistry([
    new LinearContextSource(),
    new RepositoryContextSource({ reader }),
  ]);
  const resolver = new ContextResolver();
  return {
    resolve: (partial: Omit<ResolveContextInput, "sources" | "contextConfiguration">) =>
      resolver.resolve({
        ...partial,
        sources: registry,
        contextConfiguration: DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION,
      }),
  };
};

const input = (
  over: Partial<Omit<ResolveContextInput, "sources" | "contextConfiguration">> = {},
): Omit<ResolveContextInput, "sources" | "contextConfiguration"> => ({
  runId: "run-1",
  goal: "Retry a failed notification delivery.",
  acceptanceCriteria: ["A failed notification is retried."],
  primaryRepository: { slug: "acme/webhook-service", url: PRIMARY_URL, ref: "main" },
  referenceRepositories: [{ slug: "acme/notification-service", url: REFERENCE_URL, ref: "main" }],
  workItemReferences: [],
  decisions: [],
  ...over,
});

describe("ContextResolver", () => {
  it("pins the primary repository and every reference repository to an explicit SHA", async () => {
    const resolved = await build().resolve(input());
    expect(resolved.pinned.primary).toEqual({ slug: "acme/webhook-service", sha: SHA_A });
    expect(resolved.pinned.references).toEqual([{ slug: "acme/notification-service", sha: SHA_B }]);
    expect(resolved.contract.primaryRepository.sha).toBe(SHA_A);
    expect(resolved.contract.referenceRepositories[0]?.sha).toBe(SHA_B);
  });

  it("produces a valid contract with a hash and a rendered document", async () => {
    const resolved = await build().resolve(input());
    expect(resolved.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(resolved.document).toContain("# Context Contract");
    expect(resolved.contract.version).toBe(1);
    expect(resolved.contract.runId).toBe("run-1");
  });

  it("gives every item complete provenance", async () => {
    const resolved = await build().resolve(input());
    expect(resolved.contract.items.length).toBeGreaterThan(0);
    for (const item of resolved.contract.items) {
      expect(item.reference.sourceId).not.toBe("");
      expect(item.reference.ref).not.toBe("");
      expect(item.sourceVersion).not.toBe("");
      expect(item.authority).not.toBe("");
      expect(item.reason).not.toBe("");
      expect(["required", "reference", "discoverable"]).toContain(item.classification);
    }
  });

  it("hashes the content of every required item", async () => {
    const resolved = await build().resolve(input());
    const required = resolved.contract.items.filter((item) => item.classification === "required");
    expect(required.length).toBeGreaterThan(0);
    for (const item of required) expect(item.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("classifies a repository itself as discoverable, so no prompt ever holds one", async () => {
    const resolved = await build().resolve(input());
    for (const slug of ["acme/webhook-service", "acme/notification-service"]) {
      const repository = resolved.contract.items.find(
        (item) => item.reference.ref === `repository:${slug}`,
      );
      expect(repository?.classification).toBe("discoverable");
      expect(repository?.contentSha256).toBeNull();
    }
  });

  it("finds an existing implementation pattern in the primary repository", async () => {
    const resolved = await build().resolve(input());
    const refs = resolved.contract.items.map((item) => item.reference.ref);
    expect(refs).toContain("repository:acme/webhook-service:src/retry.ts");
  });

  it("records the accepted ADR as the winner over the README", async () => {
    const resolved = await build().resolve(input());
    const conflict = resolved.contract.conflicts.find(
      (candidate) =>
        candidate.winnerRef === "repository:acme/webhook-service:docs/ADR-031.md" &&
        candidate.loserRef === "repository:acme/webhook-service:README.md",
    );
    expect(conflict?.resolution).toBe("resolved");
    expect(resolved.unresolvedConflict).toBeNull();
  });

  it("reports an unresolved conflict between two accepted ADRs", async () => {
    const resolved = await build({
      primary: {
        "docs/ADR-031.md": "Status: accepted. Notification retry lives here.\n",
        "docs/ADR-042.md": "Status: accepted. Notification retry lives elsewhere.\n",
      },
    }).resolve(input());
    expect(resolved.unresolvedConflict?.resolution).toBe("unresolved");
    expect(resolved.unresolvedConflict?.subject).toBe("notification");
  });

  it("keeps a human decision as a required product intent item", async () => {
    const resolved = await build().resolve(
      input({ decisions: [{ questionId: "Q-1", question: "Retry a 4xx?", answer: "No." }] }),
    );
    const decision = resolved.contract.items.find(
      (item) => item.reference.ref === "linear:decision:Q-1",
    );
    expect(decision?.classification).toBe("required");
    expect(decision?.authority).toBe("work_item_decision");
    expect(decision?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("demotes an item beyond the required item budget to discoverable", async () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < CONTEXT_REQUIRED_MAX_ITEMS + 10; index += 1) {
      many[`docs/ADR-${String(index).padStart(3, "0")}.md`] = `notification retry ${index}\n`;
    }
    const resolved = await build({ primary: many }).resolve(input());
    const required = resolved.contract.items.filter((item) => item.classification === "required");
    const discoverable = resolved.contract.items.filter(
      (item) => item.classification === "discoverable",
    );
    expect(required.length).toBe(CONTEXT_REQUIRED_MAX_ITEMS);
    expect(discoverable.length).toBeGreaterThan(0);
  });

  it("never promotes a single item that alone exceeds the required byte budget", async () => {
    const large = "notification ".repeat(CONTEXT_REQUIRED_MAX_BYTES / 4);
    const resolved = await build({
      primary: { "docs/ADR-031.md": large, "docs/ADR-042.md": large, "README.md": large },
    }).resolve(input());
    for (const path of ["docs/ADR-031.md", "docs/ADR-042.md", "README.md"]) {
      const item = resolved.contract.items.find(
        (candidate) => candidate.reference.path === path,
      );
      // SDD section 21. A candidate that competed for the required budget and did not fit is
      // `reference`: the Context Contract document names it, and the prompt never preloads its
      // line. `discoverable` names an item only a sandbox tool reaches, which a repository file
      // that lost the budget race is not.
      expect(item?.classification).toBe("reference");
    }
  });

  it("stops promotion once the required byte budget is spent", async () => {
    const half = "notification ".repeat(2400);
    const resolved = await build({
      primary: {
        "docs/ADR-031.md": half,
        "docs/ADR-042.md": half,
        "docs/ADR-053.md": half,
      },
    }).resolve(input());
    const promoted = ["docs/ADR-031.md", "docs/ADR-042.md", "docs/ADR-053.md"].filter((path) =>
      resolved.contract.items.some(
        (item) => item.reference.path === path && item.classification === "required",
      ),
    );
    expect(promoted).toHaveLength(2);
  });

  it("demotes an item whose content cannot be read and records why", async () => {
    const reader = new FakeRepositoryReader({
      [PRIMARY_URL]: { sha: SHA_A, files: primaryFiles },
      [REFERENCE_URL]: { sha: SHA_B, files: {} },
    });
    // The tree lists the path, and the blob read then fails. A real repository can produce that
    // race between `ls-tree` and `cat-file`.
    const original = reader.readBlob.bind(reader);
    reader.readBlob = (url, sha, path) =>
      path === "docs/ADR-031.md" ? Promise.resolve(null) : original(url, sha, path);
    const registry = new ContextSourceRegistry([
      new LinearContextSource(),
      new RepositoryContextSource({ reader }),
    ]);
    const resolved = await new ContextResolver().resolve({
      ...input(),
      sources: registry,
      contextConfiguration: DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION,
    });
    const item = resolved.contract.items.find(
      (candidate) => candidate.reference.ref === "repository:acme/webhook-service:docs/ADR-031.md",
    );
    expect(item?.classification).toBe("discoverable");
    expect(item?.reason).toMatch(/could not be read/);
  });

  it("ranks a higher priority rule first", async () => {
    const resolved = await build().resolve(input());
    const first = resolved.contract.items[0];
    expect(first?.reference.ref).toBe("linear:issue:run-1");
  });

  it("renders no file body, so no repository content is copied into the contract", async () => {
    // SDD section 55 and AT-09. `primaryFiles` really holds both lines, and the resolver really
    // fetches both files, so the document must still name only a path and a hash.
    const resolved = await build().resolve(input());
    expect(resolved.document).not.toContain("Status: accepted");
    expect(resolved.document).not.toContain("The README says notification retry is owned here");
    expect(resolved.document).toContain("docs/ADR-031.md");
  });

  it("records no conflict between the Work Item body and a recorded answer", async () => {
    const resolved = await build().resolve(
      input({ decisions: [{ questionId: "Q-1", question: "Retry a 4xx?", answer: "No." }] }),
    );
    // The body and the answer share every topic of the Run, and `delivery` sorts first among
    // them. A pair between the two therefore shows up as a conflict on `delivery`. The only real
    // conflict is the one the README and the ADR raise on `notification`.
    expect(resolved.contract.conflicts.map((conflict) => conflict.subject)).toEqual([
      "notification",
    ]);
  });

  it("lets no conflict be settled by the Work Item body when a runId equals a questionId", async () => {
    // The Work Item body records the Run identifier as its source version, so a decision set keyed
    // on that field admits the body under this collision. The resolver keys on the stable
    // reference instead, and `linear:issue:run-1` never equals `linear:decision:run-1`.
    const resolved = await build().resolve(
      input({
        runId: "run-1",
        decisions: [
          { questionId: "run-1", question: "Retry a 4xx?", answer: "No." },
          {
            questionId: "CTX-1",
            question: "Which one governs notification?",
            answer: "The ADR.",
            subject: "notification",
            domain: "architecture_intent",
          },
        ],
      }),
    );
    expect(
      resolved.contract.conflicts.filter(
        (conflict) => conflict.winnerRef === "linear:issue:run-1",
      ),
    ).toEqual([]);
    // The answer that settles a subject is the one recorded against that subject. The refinement
    // answer, whose source version collides with the Run identifier, settles nothing.
    const settled = resolved.contract.conflicts.find(
      (conflict) =>
        conflict.winnerRef === "linear:decision:subject:architecture_intent:notification",
    );
    expect(settled?.reason).toBe("a recorded human decision settles this subject");
    expect(
      resolved.contract.conflicts.filter(
        (conflict) => conflict.winnerRef === "linear:decision:run-1",
      ),
    ).toEqual([]);
  });

  // Two independent conflicts of one Run. Each pair sits in the architecture domain, holds one
  // topic, and holds no topic of the other pair. So the pairs never cross, and each pair raises
  // one unresolved conflict of its own subject.
  const twoSubjects = {
    "docs/ADR-031.md": "Status: accepted\n\nThe notification is owned here.\n",
    "docs/ADR-042.md": "Status: accepted\n\nThe notification is owned elsewhere.\n",
    "docs/ADR-051.md": "Status: accepted\n\nThe billing is owned here.\n",
    "docs/ADR-052.md": "Status: accepted\n\nThe billing is owned elsewhere.\n",
  };
  const twoSubjectInput = (
    decisions: ResolveContextInput["decisions"],
  ): Omit<ResolveContextInput, "sources" | "contextConfiguration"> =>
    input({
      goal: "Retry a failed notification delivery and correct the billing invoice.",
      acceptanceCriteria: ["A failed notification is retried.", "The billing invoice is correct."],
      decisions,
    });

  it("leaves a second subject unresolved after a decision on the first subject", async () => {
    const resolved = await build({ primary: twoSubjects }).resolve(
      twoSubjectInput([
        {
          questionId: "CTX-1",
          question: "Which one governs billing?",
          answer: "ADR-051 governs it.",
          subject: "billing",
          domain: "architecture_intent",
        },
      ]),
    );
    const billing = resolved.contract.conflicts.find((conflict) => conflict.subject === "billing");
    expect(billing?.resolution).toBe("resolved");
    expect(billing?.reason).toBe("a recorded human decision settles this subject");
    // The human never saw this question, so the answer must not settle it.
    const notification = resolved.contract.conflicts.find(
      (conflict) => conflict.subject === "notification",
    );
    expect(notification?.resolution).toBe("unresolved");
    expect(resolved.unresolvedConflict?.subject).toBe("notification");
  });

  it("keeps two answers to two conflicts that carry the same conflict identifier", async () => {
    // Factoree numbers a conflict after a sort of one resolution, so two rounds of one Run can
    // each answer a conflict named `CTX-1`. The recorded reference comes from the subject, so the
    // two answers never collide, and the contract validator accepts both.
    const resolved = await build({ primary: twoSubjects }).resolve(
      twoSubjectInput([
        {
          questionId: "CTX-1",
          question: "Which one governs billing?",
          answer: "ADR-051 governs it.",
          subject: "billing",
          domain: "architecture_intent",
        },
        {
          questionId: "CTX-1",
          question: "Which one governs notification?",
          answer: "ADR-031 governs it.",
          subject: "notification",
          domain: "architecture_intent",
        },
      ]),
    );
    expect(
      resolved.contract.items
        .map((item) => item.reference.ref)
        .filter((ref) => ref.startsWith("linear:decision:")),
    ).toEqual([
      "linear:decision:subject:architecture_intent:billing",
      "linear:decision:subject:architecture_intent:notification",
    ]);
    expect(resolved.unresolvedConflict).toBeNull();
  });

  // One subject raises a conflict in two authority domains. SDD section 22 keeps the two ladders
  // apart, so each domain needs its own human answer.
  const twoDomains = {
    "docs/ADR-031.md": "Status: accepted\n\nThe notification is owned here.\n",
    "docs/ADR-042.md": "Status: accepted\n\nThe notification is owned elsewhere.\n",
    "api/openapi.yaml": "openapi: 3.1.0\n\ninfo: the notification payload\n",
    "api/events.proto": "message Notification { string notification = 1; }\n",
  };

  it("raises one unresolved conflict for each authority domain of one subject", async () => {
    const resolved = await build({ primary: twoDomains }).resolve(input());
    expect(
      resolved.contract.conflicts
        .filter((conflict) => conflict.resolution === "unresolved")
        .map((conflict) => conflict.authorityDomain)
        .sort(),
    ).toEqual(["architecture_intent", "interface_contract"]);
  });

  it("lets an answer about one domain leave the conflict of the other domain open", async () => {
    const resolved = await build({ primary: twoDomains }).resolve(
      input({
        decisions: [
          {
            questionId: "CTX-1",
            question: "Which ADR governs notification?",
            answer: "ADR-031 governs it.",
            subject: "notification",
            domain: "architecture_intent",
          },
        ],
      }),
    );
    const architecture = resolved.contract.conflicts.find(
      (conflict) => conflict.authorityDomain === "architecture_intent",
    );
    expect(architecture?.resolution).toBe("resolved");
    expect(architecture?.reason).toBe("a recorded human decision settles this subject");
    // The human never saw the interface question, so the answer must not settle it.
    const contract = resolved.contract.conflicts.find(
      (conflict) => conflict.authorityDomain === "interface_contract",
    );
    expect(contract?.resolution).toBe("unresolved");
    expect(resolved.unresolvedConflict?.authorityDomain).toBe("interface_contract");
  });

  it("freezes nothing until both domains of one subject carry an answer", async () => {
    const resolved = await build({ primary: twoDomains }).resolve(
      input({
        decisions: [
          {
            questionId: "CTX-1",
            question: "Which ADR governs notification?",
            answer: "ADR-031 governs it.",
            subject: "notification",
            domain: "architecture_intent",
          },
          {
            questionId: "CTX-2",
            question: "Which contract governs notification?",
            answer: "The OpenAPI document governs it.",
            subject: "notification",
            domain: "interface_contract",
          },
        ],
      }),
    );
    expect(resolved.unresolvedConflict).toBeNull();
  });

  it("settles no conflict for an answer to a refinement question", async () => {
    const resolved = await build({ primary: twoSubjects }).resolve(
      twoSubjectInput([{ questionId: "Q-1", question: "Retry a 4xx?", answer: "No." }]),
    );
    expect(
      resolved.contract.conflicts.every((conflict) => conflict.resolution === "unresolved"),
    ).toBe(true);
    // The answer stays a required context item, although it settles nothing.
    expect(resolved.contract.items.map((item) => item.reference.ref)).toContain(
      "linear:decision:Q-1",
    );
  });

  it("returns a deterministic contract for the same input", async () => {
    const one = await build().resolve(input());
    const two = await build().resolve(input());
    expect(one.sha256).toBe(two.sha256);
    expect(one.contract.items.map((item) => item.reference.ref)).toEqual(
      two.contract.items.map((item) => item.reference.ref),
    );
    expect(one.contract.conflicts.map((conflict) => conflict.id)).toEqual(
      two.contract.conflicts.map((conflict) => conflict.id),
    );
  });
});

describe("ContextResolver topic enrichment", () => {
  it("adds a topic that only the fetched content holds", async () => {
    const resolved = await build({
      primary: { "docs/ADR-031.md": "Status: accepted. Notification retry lives here.\n" },
    }).resolve(input());
    const item = resolved.contract.items.find(
      (candidate) => candidate.reference.path === "docs/ADR-031.md",
    );
    expect(item?.classification).toBe("required");
    expect(item?.topics).toContain("notification");
    expect(item?.topics).toContain("retry");
  });

  it("keeps the topics sorted and free of a duplicate", async () => {
    const resolved = await build({
      primary: { "docs/notification-ADR-031.md": "Notification retry lives here.\n" },
    }).resolve(input());
    const item = resolved.contract.items.find(
      (candidate) => candidate.reference.path === "docs/notification-ADR-031.md",
    );
    expect(item?.topics).toEqual([...new Set(item?.topics)].sort());
  });

  it("leaves the path topics of an item it never fetched", async () => {
    const large = `notification ${"delivery retried ".repeat(CONTEXT_REQUIRED_MAX_BYTES / 4)}`;
    const resolved = await build({ primary: { "docs/ADR-031-notification.md": large } }).resolve(
      input(),
    );
    const item = resolved.contract.items.find(
      (candidate) => candidate.reference.path === "docs/ADR-031-notification.md",
    );
    // A candidate that lost the budget race is `reference`, not `discoverable`. See SDD
    // section 21 and the byte budget test above.
    expect(item?.classification).toBe("reference");
    expect(item?.topics).toEqual(["notification"]);
  });
});

describe("automatic reference repository discovery", () => {
  it("pins a discovered repository and records why it is in the Run", async () => {
    // A stub source reports one discovered repository. The repository source then reads it in a
    // second pass, so it reaches the contract with an explicit SHA, as SDD section 20 requires.
    const reader = new FakeRepositoryReader({
      "https://git.test/acme/app.git": { sha: "a".repeat(40), files: { "README.md": "the app" } },
      "https://git.test/acme/library.git": { sha: "b".repeat(40), files: { "README.md": "the library" } },
    });
    const resolved = await new ContextResolver().resolve({
      runId: "run-1",
      goal: "Use the shared library.",
      acceptanceCriteria: ["The library is used."],
      primaryRepository: { slug: "acme/app", url: "https://git.test/acme/app.git", ref: "main" },
      referenceRepositories: [],
      workItemReferences: [],
      decisions: [],
      contextConfiguration: { backstageEnabled: true, automaticReferenceDiscovery: true },
      sources: new ContextSourceRegistry([
        new LinearContextSource(),
        new RepositoryContextSource({ reader }),
        discoveringSource({ slug: "acme/library", url: "https://git.test/acme/library.git" }),
      ]),
    });

    expect(resolved.contract.referenceRepositories).toContainEqual({
      repo: "acme/library",
      sha: "b".repeat(40),
      reason: "the Backstage catalog names this repository as a location of a related component",
    });
    expect(resolved.pinned.references.map((repository) => repository.slug)).toContain("acme/library");
  });

  it("does not add a discovered repository when the repository did not opt in", async () => {
    // Same fixture, automaticReferenceDiscovery false.
    const reader = new FakeRepositoryReader({
      "https://git.test/acme/app.git": { sha: "a".repeat(40), files: { "README.md": "the app" } },
      "https://git.test/acme/library.git": { sha: "b".repeat(40), files: { "README.md": "the library" } },
    });
    const resolved = await new ContextResolver().resolve({
      runId: "run-1",
      goal: "Use the shared library.",
      acceptanceCriteria: ["The library is used."],
      primaryRepository: { slug: "acme/app", url: "https://git.test/acme/app.git", ref: "main" },
      referenceRepositories: [],
      workItemReferences: [],
      decisions: [],
      contextConfiguration: { backstageEnabled: true, automaticReferenceDiscovery: false },
      sources: new ContextSourceRegistry([
        new LinearContextSource(),
        new RepositoryContextSource({ reader }),
        discoveringSource({ slug: "acme/library", url: "https://git.test/acme/library.git" }),
      ]),
    });

    expect(resolved.contract.referenceRepositories).toEqual([]);
    expect(reader.calls.some((call) => call.includes("https://git.test/acme/library.git"))).toBe(
      false,
    );
  });

  it("records a repository on another host as discoverable and never checks it out", async () => {
    // The discovered URL host differs from the primary host.
    const reader = new FakeRepositoryReader({
      "https://git.test/acme/app.git": { sha: "a".repeat(40), files: { "README.md": "the app" } },
      "https://other.test/acme/library.git": { sha: "b".repeat(40), files: { "README.md": "the library" } },
    });
    const resolved = await new ContextResolver().resolve({
      runId: "run-1",
      goal: "Use the shared library.",
      acceptanceCriteria: ["The library is used."],
      primaryRepository: { slug: "acme/app", url: "https://git.test/acme/app.git", ref: "main" },
      referenceRepositories: [],
      workItemReferences: [],
      decisions: [],
      contextConfiguration: { backstageEnabled: true, automaticReferenceDiscovery: true },
      sources: new ContextSourceRegistry([
        new LinearContextSource(),
        new RepositoryContextSource({ reader }),
        discoveringSource({ slug: "acme/library", url: "https://other.test/acme/library.git" }),
      ]),
    });

    expect(resolved.contract.referenceRepositories).toEqual([]);
    expect(
      resolved.contract.items.some((item) => item.reference.ref === "discovering-source:acme/library"),
    ).toBe(true);
  });

  it("stops at three automatically discovered repositories", async () => {
    // Five discovered repositories.
    const files: Record<string, { sha: string; files: Record<string, string> }> = {
      "https://git.test/acme/app.git": { sha: "a".repeat(40), files: { "README.md": "the app" } },
    };
    const discoveredRepositories = ["repo-a", "repo-b", "repo-c", "repo-d", "repo-e"].map(
      (name) => ({ slug: `acme/${name}`, url: `https://git.test/acme/${name}.git` }),
    );
    for (const [index, repository] of discoveredRepositories.entries()) {
      files[repository.url] = {
        sha: `${index}`.repeat(40),
        files: { "README.md": `the ${repository.slug}` },
      };
    }
    const reader = new FakeRepositoryReader(files);
    const resolved = await new ContextResolver().resolve({
      runId: "run-1",
      goal: "Use the shared library.",
      acceptanceCriteria: ["The library is used."],
      primaryRepository: { slug: "acme/app", url: "https://git.test/acme/app.git", ref: "main" },
      referenceRepositories: [],
      workItemReferences: [],
      decisions: [],
      contextConfiguration: { backstageEnabled: true, automaticReferenceDiscovery: true },
      sources: new ContextSourceRegistry([
        new LinearContextSource(),
        new RepositoryContextSource({ reader }),
        discoveringSource(...discoveredRepositories),
      ]),
    });

    const discoveredEntries = resolved.contract.referenceRepositories.filter(
      (repository) =>
        repository.reason ===
        "the Backstage catalog names this repository as a location of a related component",
    );
    expect(discoveredEntries).toHaveLength(MAX_AUTOMATIC_REFERENCE_REPOSITORIES);
  });

  it("writes no duplicate item when the second pass repeats a reference", async () => {
    const reader = new FakeRepositoryReader({
      "https://git.test/acme/app.git": { sha: "a".repeat(40), files: { "README.md": "the app" } },
      "https://git.test/acme/library.git": { sha: "b".repeat(40), files: { "README.md": "the library" } },
    });
    const resolved = await new ContextResolver().resolve({
      runId: "run-1",
      goal: "Use the shared library.",
      acceptanceCriteria: ["The library is used."],
      primaryRepository: { slug: "acme/app", url: "https://git.test/acme/app.git", ref: "main" },
      referenceRepositories: [],
      workItemReferences: [],
      decisions: [],
      contextConfiguration: { backstageEnabled: true, automaticReferenceDiscovery: true },
      sources: new ContextSourceRegistry([
        new LinearContextSource(),
        new RepositoryContextSource({ reader }),
        discoveringSource({ slug: "acme/library", url: "https://git.test/acme/library.git" }),
      ]),
    });

    const refs = resolved.contract.items.map((item) => item.reference.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("adds no reference repository when the primary repository URL itself does not parse", async () => {
    // `new URL(...)` throws on both URLs, so `hostOf` returns `null` for each. A primary host of
    // `null` must trust no host, or an unparsable discovered URL would wrongly match it.
    const reader = new FakeRepositoryReader({
      "not-a-url": { sha: "a".repeat(40), files: { "README.md": "the app" } },
      "also-not-a-url": { sha: "b".repeat(40), files: { "README.md": "the library" } },
    });
    const resolved = await new ContextResolver().resolve({
      runId: "run-1",
      goal: "Use the shared library.",
      acceptanceCriteria: ["The library is used."],
      primaryRepository: { slug: "acme/app", url: "not-a-url", ref: "main" },
      referenceRepositories: [],
      workItemReferences: [],
      decisions: [],
      contextConfiguration: { backstageEnabled: true, automaticReferenceDiscovery: true },
      sources: new ContextSourceRegistry([
        new LinearContextSource(),
        new RepositoryContextSource({ reader }),
        discoveringSource({ slug: "acme/library", url: "also-not-a-url" }),
      ]),
    });

    expect(resolved.contract.referenceRepositories).toEqual([]);
    expect(
      resolved.contract.items.some((item) => item.reference.ref === "discovering-source:acme/library"),
    ).toBe(true);
  });

  it("drops a discovered repository the reader cannot read, and keeps the readable one", async () => {
    // Controller decision 13 and SDD section 19. A stale catalog entry names a repository the
    // reader cannot read. That entry must not fail the Run, and it must not lose the second
    // repository the same catalog named.
    const reader = new FakeRepositoryReader({
      "https://git.test/acme/app.git": { sha: "a".repeat(40), files: { "README.md": "the app" } },
      "https://git.test/acme/library.git": {
        sha: "b".repeat(40),
        files: { "README.md": "the library" },
      },
    });
    const resolved = await new ContextResolver().resolve({
      runId: "run-1",
      goal: "Use the shared library.",
      acceptanceCriteria: ["The library is used."],
      primaryRepository: { slug: "acme/app", url: "https://git.test/acme/app.git", ref: "main" },
      referenceRepositories: [],
      workItemReferences: [],
      decisions: [],
      contextConfiguration: { backstageEnabled: true, automaticReferenceDiscovery: true },
      sources: new ContextSourceRegistry([
        new LinearContextSource(),
        new RepositoryContextSource({ reader }),
        discoveringSource(
          { slug: "acme/gone", url: "https://git.test/acme/gone.git" },
          { slug: "acme/library", url: "https://git.test/acme/library.git" },
        ),
      ]),
    });

    // The Run still resolves, and the readable repository is still pinned.
    expect(resolved.contract.referenceRepositories).toEqual([
      {
        repo: "acme/library",
        sha: "b".repeat(40),
        reason:
          "the Backstage catalog names this repository as a location of a related component",
      },
    ]);
    expect(resolved.pinned.references.map((repository) => repository.slug)).toEqual([
      "acme/library",
    ]);
    // SDD section 20. No reference row carries an empty SHA.
    expect(
      resolved.contract.referenceRepositories.every((repository) => repository.sha.length === 40),
    ).toBe(true);
    // The unreadable repository contributes no repository candidate at all.
    expect(
      resolved.contract.items.some((item) => item.reference.repository === "acme/gone"),
    ).toBe(false);
  });

  it("fetches a required item of a discovered repository the second pass pinned", async () => {
    // Two discovered repositories, each read in its own pass. The pass of the second must not
    // lose the pinned URL of the first, or a required item of the first becomes unreadable.
    const reader = new FakeRepositoryReader({
      "https://git.test/acme/app.git": { sha: "a".repeat(40), files: { "README.md": "the app" } },
      "https://git.test/acme/library.git": {
        sha: "b".repeat(40),
        files: { "README.md": "the library retries a notification" },
      },
      "https://git.test/acme/tools.git": {
        sha: "c".repeat(40),
        files: { "README.md": "the tools" },
      },
    });
    const resolved = await new ContextResolver().resolve({
      runId: "run-1",
      goal: "Retry a failed notification delivery.",
      acceptanceCriteria: ["A failed notification is retried."],
      primaryRepository: { slug: "acme/app", url: "https://git.test/acme/app.git", ref: "main" },
      referenceRepositories: [],
      workItemReferences: [],
      decisions: [],
      contextConfiguration: { backstageEnabled: true, automaticReferenceDiscovery: true },
      sources: new ContextSourceRegistry([
        new LinearContextSource(),
        new RepositoryContextSource({ reader }),
        discoveringSource(
          { slug: "acme/library", url: "https://git.test/acme/library.git" },
          { slug: "acme/tools", url: "https://git.test/acme/tools.git" },
        ),
      ]),
    });

    const item = resolved.contract.items.find(
      (candidate) => candidate.reference.ref === "repository:acme/library:README.md",
    );
    expect(item?.classification).toBe("required");
    expect(item?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("adds no reference repository when only the discovered URL does not parse", async () => {
    const reader = new FakeRepositoryReader({
      "https://git.test/acme/app.git": { sha: "a".repeat(40), files: { "README.md": "the app" } },
      "not-a-url": { sha: "b".repeat(40), files: { "README.md": "the library" } },
    });
    const resolved = await new ContextResolver().resolve({
      runId: "run-1",
      goal: "Use the shared library.",
      acceptanceCriteria: ["The library is used."],
      primaryRepository: { slug: "acme/app", url: "https://git.test/acme/app.git", ref: "main" },
      referenceRepositories: [],
      workItemReferences: [],
      decisions: [],
      contextConfiguration: { backstageEnabled: true, automaticReferenceDiscovery: true },
      sources: new ContextSourceRegistry([
        new LinearContextSource(),
        new RepositoryContextSource({ reader }),
        discoveringSource({ slug: "acme/library", url: "not-a-url" }),
      ]),
    });

    expect(resolved.contract.referenceRepositories).toEqual([]);
    expect(
      resolved.contract.items.some((item) => item.reference.ref === "discovering-source:acme/library"),
    ).toBe(true);
  });
});
