import type { AcceptanceCriterion, WorkItem, WorkItemSource } from "./work-item.js";
import { parseWorkItem } from "./work-item.js";
import type { AutonomyLevel } from "./risk.js";
import { capAutonomy, highRiskLabelsOf } from "./risk.js";

/** SDD section 8. One decision a human must take before implementation can start safely. */
export interface RefinementQuestion {
  id: string;
  question: string;
  whyMaterial: string;
}

/** SDD section 23. A persisted human answer to one focused question. */
export interface RecordedDecision {
  questionId: string;
  question: string;
  answer: string;
  /**
   * SDD section 23. The conflict subject this answer settled. A human answer is decisive for the
   * question Factoree asked, not for the whole contract. The subject scopes it to that question.
   * A refinement answer settles no conflict, so it carries no subject.
   */
  subject?: string;
}

export interface RefinementProject {
  primaryRepository: string;
  referenceRepositories: string[];
  defaultAutonomy: string;
}

export interface RefinementInput {
  source: WorkItemSource;
  project: RefinementProject;
  decisions: RecordedDecision[];
}

/** SDD section 8 fixes this output shape. */
export interface RefinementOutput {
  status: "ready" | "needs_input";
  workItem: WorkItem;
  goal: string;
  primaryRepository: string;
  referenceRepositories: string[];
  proposedAcceptanceCriteria: AcceptanceCriterion[];
  risks: string[];
  unresolvedQuestions: RefinementQuestion[];
  autonomyLevel: AutonomyLevel;
  decisions: RecordedDecision[];
}

const WHY_OPEN_QUESTION =
  "The Work Item leaves this decision open. Factoree must not invent product behavior, " +
  "so implementation cannot start safely without an answer.";

const WHY_NO_GOAL =
  "The Work Item states no required outcome. Factoree cannot define correctness without one.";

const NO_GOAL_QUESTION = "What is the required outcome of this work?";

/**
 * Splits a goal into sentences. A sentence ends at a full stop, a question mark, or an
 * exclamation mark followed by a space or the end of the text, or at a line break.
 */
const sentencesOf = (goal: string): string[] =>
  goal
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");

/**
 * SDD section 7 permits Factoree to propose acceptance criteria. It forbids Factoree to invent
 * material product behavior. A derived criterion therefore restates one sentence the author
 * already wrote. It is marked `derived:goal` so a human can see it is a proposal.
 */
const deriveAcceptanceCriteria = (goal: string): AcceptanceCriterion[] =>
  sentencesOf(goal).map((statement, index) => ({
    id: `AC-${index + 1}`,
    statement,
    source: "derived:goal",
  }));

/**
 * SDD section 14 names this module `RefinementEngine`. It holds no port, so it can reach no
 * file, no repository, and no network. SDD section 8 forbids Refinement to modify source code.
 * That prohibition holds here by construction rather than by discipline.
 */
export class RefinementEngine {
  refine(input: RefinementInput): RefinementOutput {
    const workItem = parseWorkItem(input.source);

    // The question list always comes from the source Work Item, which never changes across
    // refinements. The synthetic "no goal" question comes first when the goal is empty, then
    // every stated open question follows, in order. The numbers run Q-1, Q-2, and so on, over
    // the whole list. Because the source never changes, the list never changes, so a recorded
    // answer still matches its question on a later refinement.
    const noGoalQuestion: RefinementQuestion | null =
      workItem.goal === "" ? { id: "Q-1", question: NO_GOAL_QUESTION, whyMaterial: WHY_NO_GOAL } : null;
    const offset = noGoalQuestion === null ? 0 : 1;
    const openQuestions: RefinementQuestion[] = workItem.openQuestions.map((question, index) => ({
      id: `Q-${offset + index + 1}`,
      question,
      whyMaterial: WHY_OPEN_QUESTION,
    }));
    const allQuestions: RefinementQuestion[] =
      noGoalQuestion === null ? openQuestions : [noGoalQuestion, ...openQuestions];

    const answered = new Set(input.decisions.map((decision) => decision.questionId));
    const unresolvedQuestions = allQuestions.filter((question) => !answered.has(question.id));

    // A human answer to the "no goal" question states the goal directly. This invents no
    // product behavior, because a human wrote the text. The goal stays empty until then.
    const goal =
      workItem.goal === ""
        ? (input.decisions.find((decision) => decision.questionId === "Q-1")?.answer ?? "")
        : workItem.goal;

    const configured = new Set(input.project.referenceRepositories);
    const namedSlugs = workItem.references
      .filter((reference) => reference.kind === "repository")
      .map((reference) => reference.value);

    // SDD section 8 forbids Refinement to override an explicit user decision. The Project record
    // is that decision, so a slug the record does not list is reported and not used. See
    // controller decision 16.
    const unconfigured = namedSlugs.filter(
      (slug) => !configured.has(slug) && slug !== input.project.primaryRepository,
    );

    const statedCriteria = workItem.acceptanceCriteria;
    const proposedAcceptanceCriteria =
      statedCriteria.length > 0 ? statedCriteria : deriveAcceptanceCriteria(goal);

    const highRisk = highRiskLabelsOf(workItem.labels);
    const risks = [
      ...highRisk,
      ...(statedCriteria.length === 0 ? ["no-acceptance-criteria"] : []),
      ...unconfigured.map((slug) => `unconfigured-repository:${slug}`),
    ];

    return {
      status: unresolvedQuestions.length > 0 ? "needs_input" : "ready",
      workItem,
      goal,
      primaryRepository: input.project.primaryRepository,
      referenceRepositories: [...input.project.referenceRepositories],
      proposedAcceptanceCriteria,
      risks,
      unresolvedQuestions,
      autonomyLevel: capAutonomy(input.project.defaultAutonomy, highRisk.length > 0),
      decisions: [...input.decisions],
    };
  }
}
