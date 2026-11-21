/**
 * GitHub issue 93, DI-21.192. A contract command that runs the tool of a proven verify command
 * must run it with the environment that verify command sets. A test tool without that environment
 * starts against infrastructure the sandbox does not run, so it fails on correct code and spends a
 * repair. The rule reads shell text, so it only splits on quotes, separators and assignments.
 */

/** One verify command of the repository, as `.factoree/config.yaml` states it. */
export interface VerifyCommandText {
  name: string;
  run: string;
}

interface Segment {
  assignments: Map<string, string>;
  words: string[];
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const MAX_TOOL_WORDS = 3;

/** The simple commands of a shell text, split on unquoted `&&`, `||`, `;`, `|` and newlines. */
const segmentsOf = (text: string): string[][] => {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  const endToken = (): void => {
    if (started) tokens.push(token);
    token = "";
    started = false;
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < text.length) token += text[++index];
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < text.length) {
      token += text[++index];
      started = true;
    } else if (char === ";" || char === "\n" || char === "|" || char === "&") {
      if ((char === "|" || char === "&") && text[index + 1] === char) index += 1;
      endSegment();
    } else if (char === " " || char === "\t") {
      endToken();
    } else {
      token += char;
      started = true;
    }
  }
  endSegment();
  return segments;
};

const parsed = (tokens: string[]): Segment => {
  const assignments = new Map<string, string>();
  let index = 0;
  if (tokens[index] === "env") index += 1;
  for (; index < tokens.length; index += 1) {
    const match = ASSIGNMENT.exec(tokens[index]!);
    if (match === null) break;
    assignments.set(match[1]!, match[2]!);
  }
  const words: string[] = [];
  for (; index < tokens.length && words.length < MAX_TOOL_WORDS; index += 1) {
    const word = tokens[index]!;
    // A flag, a path or a file name ends the tool: `dotnet test tests/App.Tests`, `pytest -x`.
    if (word.startsWith("-") || word.includes("/") || word.includes("=") || /\.\w+$/.test(word)) break;
    words.push(word);
  }
  return { assignments, words };
};

/** Every variable the text sets: before a command, through `export`, or through `env`. */
const assignmentsOf = (segments: string[][]): Map<string, string> => {
  const all = new Map<string, string>();
  for (const tokens of segments) {
    for (const [name, value] of parsed(tokens).assignments) all.set(name, value);
    if (tokens[0] === "export") {
      for (const token of tokens.slice(1)) {
        const match = ASSIGNMENT.exec(token);
        if (match !== null) all.set(match[1]!, match[2]!);
      }
    }
  }
  return all;
};

const startsWith = (words: string[], prefix: string[]): boolean =>
  prefix.length > 0 && prefix.every((word, index) => words[index] === word);

/**
 * The reason a plan command breaks the rule, or null. The command breaks it when one of its
 * simple commands runs the tool of a verify command that sets variables, and the command does not
 * set each of them to the same value.
 */
export const verifyEnvironmentProblem = (
  assertionId: string,
  run: string,
  verifyCommands: readonly VerifyCommandText[],
): string | null => {
  const entrySegments = segmentsOf(run);
  const entryWords = entrySegments.map((tokens) => parsed(tokens).words);
  const set = assignmentsOf(entrySegments);
  for (const verify of verifyCommands) {
    for (const tokens of segmentsOf(verify.run)) {
      const segment = parsed(tokens);
      if (segment.assignments.size === 0 || segment.words.length === 0) continue;
      if (!entryWords.some((words) => startsWith(words, segment.words))) continue;
      const missing = [...segment.assignments].filter(([name, value]) => set.get(name) !== value);
      if (missing.length === 0) continue;
      return (
        `The Validation Plan command entry for "${assertionId}" runs "${segment.words.join(" ")}" without ` +
        `${missing.map(([name, value]) => `${name}=${value}`).join(" ")}, which the verify command "${verify.name}" sets. ` +
        `Start from the verify command \`${verify.run}\`: keep its variables and its arguments, and add a narrower filter.`
      );
    }
  }
  return null;
};
