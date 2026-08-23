import { createHash } from "node:crypto";
import type { RecordedDecision } from "~/domain/refinement/refinement-engine.js";
import type { ContextConflictRecord, SelectedContextItem } from "./conflicts.js";
import { detectConflicts, firstUnresolved } from "./conflicts.js";
import type { ContextCandidate, ContextClassification, RepositoryRef } from "./context-source.js";
import type { ContextSourceRegistry } from "./context-source-registry.js";
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

export interface ResolveContextInput {
  runId: string;
  goal: string;
  acceptanceCriteria: string[];
  primaryRepository: RepositoryRef;
  referenceRepositories: RepositoryRef[];
  workItemReferences: string[];
  decisions: RecordedDecision[];
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

export interface ContextResolverOptions {
  sources: ContextSourceRegistry;
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

/**
 * SDD section 14 names this module `ContextResolver`. SDD section 18 gives it the discovery
 * priority. SDD section 21 gives it the contract shape and the classification. SDD section 22
 * gives it the authority ladders. SDD section 23 gives it the conflict model.
 */
export class ContextResolver {
  constructor(private readonly options: ContextResolverOptions) {}

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
    };

    const sources = this.options.sources.all();
    const candidates: ContextCandidate[] = [];
    for (const source of sources) candidates.push(...(await source.discover(request)));
    candidates.sort(compareCandidates);

    // The pinned SHA of each repository comes from the candidate that names the repository and no
    // path, so the resolver never guesses a SHA a source did not report.
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
      // candidate that does not fit becomes `discoverable` too. No candidate is ever dropped.
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
        classification = fits ? "required" : "discoverable";
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
      const source = this.options.sources.get(item.reference.sourceId);
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
    // one. The resolver names the true decision items by their source version, which is the
    // identifier of the question a human answered. See the concern in the Task 7 report.
    const questionIds = new Set(input.decisions.map((decision) => decision.questionId));
    const decisionRefs = items
      .filter(
        (item) =>
          item.authority === "work_item_decision" && questionIds.has(item.sourceVersion),
      )
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
      referenceRepositories: input.referenceRepositories.map((repository) => ({
        repo: repository.slug,
        sha: shaBySlug.get(repository.slug) ?? "",
        reason: "a configured reference repository",
      })),
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
