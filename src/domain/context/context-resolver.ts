import { createHash } from "node:crypto";
import type { RecordedDecision } from "~/domain/refinement/refinement-engine.js";
import type { ContextConflictRecord, SelectedContextItem } from "./conflicts.js";
import { detectConflicts, firstUnresolved } from "./conflicts.js";
import type { ContextCandidate, ContextClassification, RepositoryRef } from "./context-source.js";
import type { ContextSourceRegistry } from "./context-source-registry.js";
import type { RepositoryContextConfiguration } from "./repository-context-configuration.js";
import type { ContextContract } from "./context-contract.js";
import {
  CONTEXT_CONTRACT_VERSION,
  CONTEXT_REQUIRED_MAX_BYTES,
  CONTEXT_REQUIRED_MAX_ITEMS,
  hashContextContract,
  renderContextContract,
  validateContextContract,
} from "./context-contract.js";
import { topicsOf } from "./topics.js";

import { linearDecisionRef } from "./decision-ref.js";

export interface ResolveContextInput {
  runId: string;
  goal: string;
  acceptanceCriteria: string[];
  primaryRepository: RepositoryRef;
  referenceRepositories: RepositoryRef[];
  workItemReferences: string[];
  decisions: RecordedDecision[];
  /** The sources of this Run. SDD section 53 makes the list per Project. */
  sources: ContextSourceRegistry;
  contextConfiguration: RepositoryContextConfiguration;
}

export interface ResolvedContext {
  contract: ContextContract;
  /** SDD section 21 requires immutability. This hash is the identity of the contract. */
  sha256: string;
  /** The human-readable contract. It reaches Linear and the Implementer prompt. */
  document: string;
  pinned: {
    primary: { slug: string; sha: string };
    references: Array<{ slug: string; sha: string }>;
  };
  /** SDD section 23. A non-null value means implementation must not start. */
  unresolvedConflict: ContextConflictRecord | null;
}

/**
 * A total order over candidates. SDD section 18 ranks the discovery rules, so the rule decides
 * first. A candidate that carries more Work Item topics is more relevant, so it decides second.
 * The reference decides last, so the order never depends on the order a source returned.
 */
const compareCandidates = (a: ContextCandidate, b: ContextCandidate): number => {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.topics.length !== b.topics.length) return b.topics.length - a.topics.length;
  return a.reference.ref < b.reference.ref ? -1 : a.reference.ref > b.reference.ref ? 1 : 0;
};

/**
 * The topics that appear in one text. A source applies the same rule to a path. SDD section 23
 * needs a subject before it can pair two items, and a path alone names too few subjects. A README
 * and an ADR discuss one topic in their text, not in their names.
 */
const topicsIn = (text: string, topics: string[]): string[] => {
  const lower = text.toLowerCase();
  return topics.filter((topic) => lower.includes(topic));
};

const mergeTopics = (left: string[], right: string[]): string[] =>
  [...new Set([...left, ...right])].sort();

/** `new URL(url).host` inside a `try`, and `null` on a failure. */
const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/**
 * SDD section 20 and controller decision 7. A repository a source discovers becomes a real
 * reference repository of the Run, with an explicit SHA, so the checkout and the Context
 * Contract name the same commit. Each one costs a mirror clone, so the count is bounded.
 */
export const MAX_AUTOMATIC_REFERENCE_REPOSITORIES = 3;

/**
 * SDD section 14 names this module `ContextResolver`. SDD section 18 gives it the discovery
 * priority. SDD section 21 gives it the contract shape and the classification. SDD section 22
 * gives it the authority ladders. SDD section 23 gives it the conflict model.
 */
export class ContextResolver {
  async resolve(input: ResolveContextInput): Promise<ResolvedContext> {
    const topics = topicsOf({ goal: input.goal, acceptanceCriteria: input.acceptanceCriteria });
    const request = {
      runId: input.runId,
      goal: input.goal,
      topics,
      primaryRepository: input.primaryRepository,
      referenceRepositories: input.referenceRepositories,
      workItemReferences: input.workItemReferences,
      decisions: input.decisions,
      contextConfiguration: input.contextConfiguration,
    };

    const sources = input.sources.all();
    const candidates: ContextCandidate[] = [];
    for (const source of sources) candidates.push(...(await source.discover(request)));
    candidates.sort(compareCandidates);

    // The primary host is the only host the workflow can rebuild a clone URL for, because it
    // composes `repositoryBaseUrl` with a slug. A repository elsewhere stays a recorded item.
    // See controller decision 8. `hostOf` returns `null` on a parse failure, and `null === null`
    // in JavaScript, so a primary URL that fails to parse must be treated as trusting no host at
    // all. Otherwise an unparsable discovered URL would match it.
    const primaryHost = hostOf(input.primaryRepository.url);
    const known = new Set([
      input.primaryRepository.slug,
      ...input.referenceRepositories.map((repository) => repository.slug),
    ]);
    const discovered: RepositoryRef[] = [];
    if (input.contextConfiguration.automaticReferenceDiscovery) {
      for (const candidate of candidates) {
        if (discovered.length >= MAX_AUTOMATIC_REFERENCE_REPOSITORIES) break;
        const repository = candidate.discoveredRepository;
        if (repository === undefined) continue;
        if (known.has(repository.slug)) continue;
        if (primaryHost === null || hostOf(repository.url) !== primaryHost) continue;
        known.add(repository.slug);
        discovered.push({ slug: repository.slug, url: `${repository.url}.git`, ref: input.primaryRepository.ref });
      }
    }

    if (discovered.length > 0) {
      // The repository source reads the extra repositories in a second pass. It repeats the
      // primary, so the merge drops a reference it already holds. The reader caches one mirror
      // per URL, so the repeat costs no second clone.
      const second = await input.sources.get("repository").discover({
        ...request,
        referenceRepositories: discovered,
      });
      const seen = new Set(candidates.map((candidate) => candidate.reference.ref));
      for (const candidate of second) {
        if (seen.has(candidate.reference.ref)) continue;
        seen.add(candidate.reference.ref);
        candidates.push(candidate);
      }
    }

    // The pinned SHA of each repository comes from the candidate that names the repository and no
    // path, so the resolver never guesses a SHA a source did not report. Built after the second
    // pass, so a discovered repository has its SHA too.
    const shaBySlug = new Map<string, string>();
    for (const candidate of candidates) {
      const slug = candidate.reference.repository;
      const sha = candidate.reference.sha;
      if (slug !== null && sha !== null && !shaBySlug.has(slug)) shaBySlug.set(slug, sha);
    }

    // SDD section 21 and AT-09. Promotion stops at the budget. Everything past the budget stays
    // available through a tool and stays out of the prompt.
    let requiredCount = 0;
    let requiredBytes = 0;
    const items: SelectedContextItem[] = candidates.map((candidate) => {
      // SDD section 21. Factoree never preloads a repository itself. The Implementer reaches the
      // repository by path inside the sandbox, and AT-09 requires exactly that. A repository is
      // therefore `discoverable`: a tool reaches it, and the prompt never holds it. Every other
      // candidate a source offered as `required` or `reference` competes for the budget. A
      // candidate that does not fit becomes `reference`: the Context Contract document names it,
      // and the prompt never preloads its line. No candidate is ever dropped.
      const isRepository =
        candidate.reference.path === null && candidate.reference.repository !== null;
      const competes =
        !isRepository &&
        (candidate.suggestedClassification === "required" ||
          candidate.suggestedClassification === "reference");

      let classification: ContextClassification = isRepository
        ? "discoverable"
        : candidate.suggestedClassification;
      if (competes) {
        const size = candidate.sizeBytes ?? 0;
        const fits =
          requiredCount < CONTEXT_REQUIRED_MAX_ITEMS &&
          requiredBytes + size <= CONTEXT_REQUIRED_MAX_BYTES;
        classification = fits ? "required" : "reference";
        if (fits) {
          requiredCount += 1;
          requiredBytes += size;
        }
      }

      return {
        reference: candidate.reference,
        sourceVersion: candidate.sourceVersion,
        authority: candidate.authority,
        reason: candidate.reason,
        classification,
        topics: candidate.topics,
        contentSha256: null,
      };
    });

    // SDD section 55. A required item is content Factoree made a promise to reproduce, so the
    // resolver reads it once and hashes it. An item the resolver cannot read becomes
    // `discoverable` instead of fatal, because one unreadable file must not fail a Run.
    //
    // The fetched text also carries topics. A source derives a topic from the path alone, and a
    // path names too few subjects for SDD section 23. The resolver therefore adds the topics of
    // the content before it detects a conflict.
    //
    // The resolver reads the content to hash it and to derive its topics, and then discards it on
    // purpose. SDD section 55 forbids a copy of repository content into the control plane. The
    // Implementer reaches a file by path inside the sandbox checkout, and `requiredContextLines`
    // gives the prompt the path, the authority, and the hash, which is all the prompt needs.
    for (const item of items) {
      if (item.classification !== "required") continue;
      const source = input.sources.get(item.reference.sourceId);
      try {
        const document = await source.fetch(item.reference);
        item.contentSha256 = createHash("sha256").update(document.content, "utf8").digest("hex");
        item.topics = mergeTopics(item.topics, topicsIn(document.content, topics));
      } catch (error) {
        item.classification = "discoverable";
        item.reason =
          `${item.reason}. The content could not be read, so it is not preloaded: ` +
          `${String(error)}`;
      }
    }

    // SDD section 23. Only a recorded human answer settles a conflict out of band. The Work Item
    // body carries the same authority class, but it answers no question, so it must not settle
    // one. The stable reference of an answer is the reliable key. A source version is not: the
    // Work Item body records the Run identifier, and a Run identifier can equal a question
    // identifier.
    const answerRefs = new Set(input.decisions.map(linearDecisionRef));
    const decisionRefs = items
      .filter((item) => answerRefs.has(item.reference.ref))
      .map((item) => item.reference.ref);

    const conflicts = detectConflicts(items, { decisionRefs });

    const contract: ContextContract = {
      version: CONTEXT_CONTRACT_VERSION,
      runId: input.runId,
      goal: input.goal,
      primaryRepository: {
        repo: input.primaryRepository.slug,
        sha: shaBySlug.get(input.primaryRepository.slug) ?? "",
      },
      referenceRepositories: [
        ...input.referenceRepositories.map((repository) => ({
          repo: repository.slug,
          sha: shaBySlug.get(repository.slug) ?? "",
          reason: "a configured reference repository",
        })),
        ...discovered.map((repository) => ({
          repo: repository.slug,
          sha: shaBySlug.get(repository.slug) ?? "",
          reason: "the Backstage catalog names this repository as a location of a related component",
        })),
      ],
      items,
      conflicts,
    };

    validateContextContract(contract);

    return {
      contract,
      sha256: hashContextContract(contract),
      document: renderContextContract(contract),
      pinned: {
        primary: {
          slug: input.primaryRepository.slug,
          sha: contract.primaryRepository.sha,
        },
        references: contract.referenceRepositories.map((repository) => ({
          slug: repository.repo,
          sha: repository.sha,
        })),
      },
      unresolvedConflict: firstUnresolved(conflicts),
    };
  }
}
