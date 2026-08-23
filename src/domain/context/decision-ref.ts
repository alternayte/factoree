import type { RecordedDecision } from "~/domain/refinement/refinement-engine.js";
import type { AuthorityDomain } from "./authority.js";

/**
 * The stable reference of one recorded human answer that settled a conflict.
 *
 * SDD section 23 asks one focused question about one conflict. A conflict belongs to one
 * authority domain and to one subject, so the pair of the two names the answer exactly. One
 * subject can raise a conflict in more than one domain, so the subject alone is not enough. An
 * answer about the architecture of "notification" must not settle the interface contract of
 * "notification", because no human saw that second question.
 *
 * `detectConflicts` builds the same reference for the pair it examines. Both sides use this one
 * helper, so the two forms cannot drift apart.
 */
export const conflictDecisionRef = (domain: AuthorityDomain, subject: string): string =>
  `linear:decision:subject:${domain}:${subject}`;

/**
 * The stable reference of one recorded human answer. The reference must stay unique for the life
 * of one Run, because a Context Contract rejects the same reference twice.
 *
 * The scheme has two forms. An answer that settled a conflict is named by its authority domain
 * and its subject, because one settled pair never returns as a second conflict of the same Run.
 * An answer to a refinement question is named by the question identifier, which the Refinement
 * engine already keeps stable across every refinement of one Run. The two forms carry different
 * prefixes, so one form never produces the reference of the other.
 *
 * A conflict identifier is not a sound basis. Factoree numbers a conflict `CTX-1` after a sort of
 * the conflicts of one resolution. Two rounds of one Run can each answer a conflict `CTX-1`.
 */
export const linearDecisionRef = (decision: RecordedDecision): string =>
  decision.subject === undefined || decision.domain === undefined
    ? `linear:decision:${decision.questionId}`
    : conflictDecisionRef(decision.domain, decision.subject);
