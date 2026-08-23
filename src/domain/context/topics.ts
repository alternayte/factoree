/**
 * The one topic definition of Phase 4. The rank rule and conflict detection both call it, so they
 * can never disagree about what a Work Item is about. It is deliberately simple and deterministic:
 * SDD section 8 forbids a silent resolution of an ambiguity by Refinement, so a clever similarity
 * measure is the wrong control here.
 */

const MINIMUM_LENGTH = 4;

/** Common English words that carry no topic. */
const STOP_WORDS = new Set([
  "about", "after", "again", "also", "always", "another", "because", "been", "before", "being",
  "below", "between", "both", "cannot", "could", "does", "doing", "done", "down", "during",
  "each", "either", "else", "enough", "even", "ever", "every", "from", "further", "have",
  "having", "here", "however", "into", "just", "like", "make", "makes", "many", "more", "most",
  "much", "must", "need", "needs", "next", "none", "only", "other", "over", "same", "shall",
  "should", "since", "some", "such", "than", "that", "their", "them", "then", "there", "these",
  "they", "this", "those", "through", "under", "until", "very", "when", "where", "which",
  "while", "will", "with", "within", "without", "would", "your",
]);

export const topicsOf = (input: { goal: string; acceptanceCriteria: string[] }): string[] => {
  const words = [input.goal, ...input.acceptanceCriteria]
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= MINIMUM_LENGTH && !STOP_WORDS.has(word));
  return [...new Set(words)].sort();
};

/**
 * The topics that appear in one text. A source applies the same rule to a path. SDD section 23
 * needs a subject before it can pair two items, and a path alone names too few subjects. A README
 * and an ADR discuss one topic in their text, not in their names. The resolver and every source
 * call this one definition, so they can never disagree about the topics of one text.
 */
export const topicsIn = (text: string, topics: string[]): string[] => {
  const lower = text.toLowerCase();
  return topics.filter((topic) => lower.includes(topic));
};
