import type {
  ContextCandidate,
  ContextDiscoveryRequest,
  ContextDocument,
  ContextReference,
  ContextSource,
} from "./context-source.js";
import { DISCOVERY_PRIORITY } from "./context-source.js";
import { linearDecisionRef } from "./decision-ref.js";

/**
 * SDD section 17 requires a Linear context source. The Work Item is the product intent of the
 * Run. SDD section 22 gives an explicit Work Item decision the highest product-intent authority.
 * SDD section 23 requires a human answer to persist as a Run decision, and controller decision 4
 * persists it here, as a Context Item of the same authority.
 *
 * The source holds every document it offers. It needs no network call and cannot fail.
 */
export class LinearContextSource implements ContextSource {
  private readonly documents = new Map<string, string>();

  id(): string {
    return "linear";
  }

  private reference(ref: string): ContextReference {
    return { sourceId: this.id(), ref, repository: null, sha: null, path: null };
  }

  discover(request: ContextDiscoveryRequest): Promise<ContextCandidate[]> {
    this.documents.clear();
    const candidates: ContextCandidate[] = [];

    const issueRef = `linear:issue:${request.runId}`;
    this.documents.set(issueRef, request.goal);
    candidates.push({
      reference: this.reference(issueRef),
      sourceVersion: request.runId,
      authority: "work_item_decision",
      reason: "the Work Item is the product intent of this Run",
      priority: DISCOVERY_PRIORITY.work_item_reference,
      topics: request.topics,
      sizeBytes: Buffer.byteLength(request.goal, "utf8"),
      suggestedClassification: "required",
    });

    for (const decision of request.decisions) {
      const ref = linearDecisionRef(decision);
      const content = `${decision.question}\n\n${decision.answer}`;
      this.documents.set(ref, content);
      candidates.push({
        reference: this.reference(ref),
        sourceVersion: decision.questionId,
        authority: "work_item_decision",
        reason: `a human answered "${decision.question}"`,
        priority: DISCOVERY_PRIORITY.work_item_reference,
        // SDD section 23 makes a human answer decisive for the question Factoree asked. The
        // answer therefore carries the subject of the conflict it settled, not every topic of
        // the Work Item. An answer to a refinement question settles no conflict, so it carries
        // no topic. It stays a required context item, and it settles nothing.
        topics: decision.subject === undefined ? [] : [decision.subject],
        sizeBytes: Buffer.byteLength(content, "utf8"),
        suggestedClassification: "required",
      });
    }

    request.workItemReferences.forEach((value, index) => {
      const ref = `linear:reference:${index + 1}`;
      this.documents.set(ref, value);
      candidates.push({
        reference: this.reference(ref),
        sourceVersion: request.runId,
        authority: "product_documentation",
        reason: "the Work Item links this reference",
        priority: DISCOVERY_PRIORITY.work_item_reference,
        topics: request.topics,
        sizeBytes: Buffer.byteLength(value, "utf8"),
        // SDD section 18 forbids unbounded retrieval. Factoree cannot fetch an arbitrary link in
        // Version 1. The link stays visible to a human and to a tool.
        suggestedClassification: "discoverable",
      });
    });

    return Promise.resolve(candidates);
  }

  fetch(ref: ContextReference): Promise<ContextDocument> {
    const content = this.documents.get(ref.ref);
    if (content === undefined) {
      return Promise.reject(new Error(`The Linear context source never offered "${ref.ref}".`));
    }
    return Promise.resolve({ reference: ref, sourceVersion: ref.ref, content });
  }
}
