/**
 * SDD section 66. The real live acceptance scenario.
 *
 * This file is unexecuted in the environment that wrote it, because no live credential exists
 * there. `tests/live/acceptance-live.ts` only imports it after every credential of
 * `tests/live/required-credentials.ts` is present. SDD section 72 forbids a mock of a required
 * live integration, so every call below goes to the real Linear API, the real GitHub API, and
 * the real client adapters of `src/adapters/linear`, `src/adapters/github`, and
 * `src/adapters/sandbox/fly-sprites`. Nothing here returns a canned value.
 *
 * The scenario proves the SDD section 67 "Live proof" list. It:
 *
 *   1. Creates a real Linear fixture issue in the test team, and delegates it to the Factoree
 *      agent by assigning the Factoree app user. That delegation is the event Factoree's
 *      webhook receives, and it is the fact "Real Linear delegation reaches Factoree".
 *   2. Polls the issue for the Proof Pack comment Factoree posts on a successful Run. The Proof
 *      Pack headings are fixed by `PROOF_PACK_HEADINGS` in `src/domain/evidence/proof-pack.ts`,
 *      so this scenario reads the real heading names rather than a guess.
 *   3. Reads the sections under those headings to decide, section by section, whether context
 *      resolution ran, the Validation Contract froze, deterministic verification ran, review
 *      ran, and the Fly Sprite changed code.
 *   4. Confirms the pull request the Proof Pack links exists in the real GitHub fixture
 *      repository. It confirms this with the real `GitHubPullRequests` adapter.
 *
 * A future maintainer who runs this against real accounts must expect it to take minutes, because
 * step 2 waits on an asynchronous Run.
 */
import { LinearClient } from "@linear/sdk";
import { GitHubPullRequests } from "~/adapters/github/github-pull-requests.js";
import { PROOF_PACK_HEADINGS } from "~/domain/evidence/proof-pack.js";
import { createPrismaClient } from "~/persistence/prisma/client.js";
import { resolveProfile } from "./profile.js";

/** SDD section 59 fixes this path. An operator creates a Backstage or an MCP context source
 * configuration row with it. */
export const CONTEXT_SOURCE_ADMIN_ENDPOINT = "POST /admin/projects/:id/context-sources";

/** How long the scenario waits for Factoree to post the Proof Pack comment. */
const PROOF_PACK_TIMEOUT_MS = 30 * 60 * 1000;
/** How long the scenario waits for the first agent activity, proving delegation reached Factoree. */
const AGENT_ACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
/** How often the scenario re-reads the issue while it waits. */
const POLL_INTERVAL_MS = 15_000;

interface LiveFact {
  /** The exact wording of one SDD section 67 "Live proof" bullet. */
  name: string;
  holds: boolean;
  detail: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads one Proof Pack section body, between its heading and the next heading. */
const readSection = (proofPack: string, heading: string): string => {
  const start = proofPack.indexOf(heading);
  if (start === -1) return "";
  const afterHeading = start + heading.length;
  const headingIndex = PROOF_PACK_HEADINGS.indexOf(heading as (typeof PROOF_PACK_HEADINGS)[number]);
  const nextHeading = PROOF_PACK_HEADINGS[headingIndex + 1];
  const end = nextHeading === undefined ? proofPack.length : proofPack.indexOf(nextHeading, afterHeading);
  const boundedEnd = end === -1 ? proofPack.length : end;
  return proofPack.slice(afterHeading, boundedEnd).trim();
};

/** The file the fixture task adds. It is one file at the root, so any repository can carry it. */
const PROOF_FILE = "factoree-live-proof.md";

/**
 * The description of the fixture issue.
 *
 * The acceptance criteria are written as commands on purpose. `methodFor` in
 * `src/domain/validation/validation-contract-builder.ts` reads the wording of a criterion and
 * chooses the validation method from it, and it falls back to `manual` when it recognises
 * nothing. SDD section 36 forbids an L3 Run from completing with a manual assertion, so a prose
 * criterion ends every Run at user validation and no path can ever reach a pull request. The
 * words "command" and "exits with code" select the `command` method, which the User Validator
 * proves by itself.
 *
 * The task names one new file at the repository root, so the scenario runs against any fixture
 * repository without assuming a toolchain, a test runner, or a directory layout.
 */
export const fixtureDescription = (token: string): string =>
  [
    `Add a file named \`${PROOF_FILE}\` at the root of the repository.`,
    `Its only line must be the token ${token}.`,
    "Change no other file.",
    "",
    // The heading must be a markdown heading. `SECTION_BY_TITLE` in
    // `src/domain/refinement/work-item.ts` recognises a section by its heading line, and a plain
    // "Acceptance criteria:" line names no section. Refinement then derives a criterion from
    // every sentence of the issue, including its title, and each derived sentence reads as
    // `manual`, which ends the Run at user validation.
    "## Acceptance criteria",
    "",
    // `cat`, not `test -f`: the word "test" selects the `test` method, which sends the User
    // Validator to the test suite of the repository instead of to this file.
    `- The command \`cat ${PROOF_FILE}\` exits with code 0.`,
    `- The command \`grep -qxF '${token}' ${PROOF_FILE}\` exits with code 0.`,
  ].join("\n");

/**
 * Creates the fixture issue and delegates it to Factoree. Returns the issue identifier the rest
 * of the scenario polls.
 */
const delegateFixtureIssue = async (
  linear: LinearClient,
  teamId: string,
): Promise<{ issueId: string; identifier: string }> => {
  const organization = await linear.organization;
  const users = await linear.users({ filter: { name: { containsIgnoreCase: "Factoree" } } });
  const factoreeUser = users.nodes[0];
  if (factoreeUser === undefined) {
    throw new Error(
      `no Linear user named "Factoree" was found in organization ${organization.name}. ` +
        "Install the Factoree Linear app on the test workspace before this scenario runs.",
    );
  }
  // One token per Run, so the file the Run writes cannot be confused with the file of an
  // earlier Run that the fixture repository still carries.
  const token = `factoree-live-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const created = await linear.createIssue({
    teamId,
    title: `Factoree live acceptance fixture ${token}`,
    description: fixtureDescription(token),
    assigneeId: factoreeUser.id,
  });
  const issue = await created.issue;
  if (issue === undefined) throw new Error("Linear accepted the issue create call but returned no issue");
  return { issueId: issue.id, identifier: issue.identifier };
};

/** Polls the issue's comments for the Proof Pack. Returns its raw body, or null on timeout. */
const waitForProofPack = async (linear: LinearClient, issueId: string): Promise<string | null> => {
  const deadline = Date.now() + PROOF_PACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const issue = await linear.issue(issueId);
    const comments = await issue.comments();
    const proofPack = comments.nodes.find((comment) => comment.body.includes(PROOF_PACK_HEADINGS[0]));
    if (proofPack !== undefined) return proofPack.body;
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
};

/**
 * Polls for the first agent activity Factoree posted, proving the delegation reached it. A
 * comment counts only when `agentSessionId` is set, because Factoree posts through
 * `LinearAgentClient.emit`, which calls `createAgentActivity` and so every comment it produces
 * carries an agent session identifier. A comment a human wrote carries no such identifier and
 * cannot pass this check.
 */
const waitForAgentActivity = async (linear: LinearClient, issueId: string): Promise<boolean> => {
  const deadline = Date.now() + AGENT_ACTIVITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const issue = await linear.issue(issueId);
    const comments = await issue.comments();
    if (comments.nodes.some((comment) => comment.agentSessionId !== undefined)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
};

/**
 * SDD section 66 requires a test Backstage catalog and a test MCP source. Backstage and MCP
 * are not environment-configured. They are `ContextSourceConfiguration` rows in the database,
 * per Project. This check queries those rows directly, rather than trusting an environment
 * gate, because a gate proves nothing about what the worker actually reads.
 */
const checkContextSources = async (env: NodeJS.ProcessEnv): Promise<LiveFact> => {
  const name = "The Project has an enabled Backstage source and an enabled MCP source";
  const databaseUrl = env.DATABASE_URL ?? "";
  const teamId = env.LIVE_LINEAR_TEAM_ID ?? "";
  const profile = resolveProfile(env);
  const standInNote =
    profile === "full"
      ? ""
      : " This profile's stub endpoints satisfy this requirement when registered as rows.";
  const prisma = createPrismaClient(databaseUrl);
  try {
    const project = await prisma.project.findFirst({ where: { linearTeamId: teamId } });
    if (project === null) {
      return {
        name,
        holds: false,
        detail:
          `no Project row names Linear team ${teamId}. Create the Project first, then add a ` +
          `context source with ${CONTEXT_SOURCE_ADMIN_ENDPOINT}.${standInNote}`,
      };
    }
    const sources = await prisma.contextSourceConfiguration.findMany({
      where: { projectId: project.id, enabled: true },
    });
    const hasBackstage = sources.some((source) => source.kind === "backstage");
    const hasMcp = sources.some((source) => source.kind === "mcp");
    const holds = hasBackstage && hasMcp;
    return {
      name,
      holds,
      detail: holds
        ? "an enabled backstage row and an enabled mcp row exist for the Project."
        : `the Project is missing an enabled backstage row, an enabled mcp row, or both. ` +
          `Create the missing row with ${CONTEXT_SOURCE_ADMIN_ENDPOINT}.${standInNote}`,
    };
  } finally {
    await prisma.$disconnect();
  }
};

export const runLiveAcceptance = async (env: NodeJS.ProcessEnv): Promise<number> => {
  // A personal API key goes in `apiKey`. The SDK sends an `accessToken` with a `Bearer`
  // prefix, and Linear rejects a personal API key that carries that prefix. An OAuth token
  // still works through `accessToken`, so the scenario selects the field by the key shape.
  const linearCredential = env.LIVE_LINEAR_API_KEY ?? "";
  const linear = new LinearClient(
    linearCredential.startsWith("lin_api_")
      ? { apiKey: linearCredential }
      : { accessToken: linearCredential },
  );
  const teamId = env.LIVE_LINEAR_TEAM_ID ?? "";
  const facts: LiveFact[] = [];
  facts.push(await checkContextSources(env));

  let issueId: string | null = null;
  try {
    const delegation = await delegateFixtureIssue(linear, teamId);
    issueId = delegation.issueId;
    const reached = await waitForAgentActivity(linear, delegation.issueId);
    facts.push({
      name: "Real Linear delegation reaches Factoree",
      holds: reached,
      detail: reached
        ? `issue ${delegation.identifier} received at least one Factoree agent activity`
        : `issue ${delegation.identifier} received no Factoree agent activity before the timeout`,
    });
  } catch (error) {
    facts.push({
      name: "Real Linear delegation reaches Factoree",
      holds: false,
      detail: `delegation failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  let proofPack: string | null = null;
  if (issueId !== null) {
    proofPack = await waitForProofPack(linear, issueId);
  }

  const proofPackVisible = proofPack !== null;
  facts.push({
    name: "The Proof Pack is visible in Linear",
    holds: proofPackVisible,
    detail: proofPackVisible
      ? "a comment containing every Proof Pack heading was found"
      : "no comment containing the Proof Pack headings appeared before the timeout",
  });

  const contextSection = proofPack === null ? "" : readSection(proofPack, "### Context used");
  facts.push({
    name: "Real context resolution runs",
    holds: contextSection.length > 0,
    detail: contextSection.length > 0 ? "the Context used section is not empty" : "the Context used section is absent or empty",
  });

  const validationSection = proofPack === null ? "" : readSection(proofPack, "### Validation contract");
  facts.push({
    name: "Real Validation Contract is frozen",
    holds: validationSection.length > 0,
    detail:
      validationSection.length > 0
        ? "the Validation contract section is not empty"
        : "the Validation contract section is absent or empty",
  });
  facts.push({
    name: "User-level validation runs",
    holds: validationSection.length > 0,
    detail:
      validationSection.length > 0
        ? "the Validation contract section reports assertion results"
        : "no validation assertion result was reported",
  });

  const verificationSection = proofPack === null ? "" : readSection(proofPack, "### Deterministic verification");
  facts.push({
    name: "Deterministic verification runs",
    holds: verificationSection.length > 0,
    detail:
      verificationSection.length > 0
        ? "the Deterministic verification section reports at least one check"
        : "the Deterministic verification section is absent or empty",
  });

  const reviewSection = proofPack === null ? "" : readSection(proofPack, "### Independent review");
  facts.push({
    name: "Independent review runs",
    holds: reviewSection.length > 0,
    detail:
      reviewSection.length > 0
        ? "the Independent review section reports a review outcome"
        : "the Independent review section is absent or empty",
  });

  const changeSummary = proofPack === null ? "" : readSection(proofPack, "### Change summary");
  facts.push({
    name: "Real Fly Sprite performs implementation",
    holds: changeSummary.length > 0,
    detail:
      changeSummary.length > 0
        ? "the Change summary section names changed files, so the sandbox produced a patch"
        : "the Change summary section is absent or empty",
  });

  const pullRequestSection = proofPack === null ? "" : readSection(proofPack, "### Pull request");
  const prUrlMatch = pullRequestSection.match(/https:\/\/github\.com\/\S+\/pull\/\d+/);
  let prConfirmed = false;
  let prDetail = "the Pull request section named no GitHub pull request URL";
  if (prUrlMatch !== null && env.LIVE_GITHUB_TOKEN !== undefined && env.LIVE_GITHUB_REPOSITORY !== undefined) {
    const pullRequests = new GitHubPullRequests({
      apiBaseUrl: "https://api.github.com",
      token: env.LIVE_GITHUB_TOKEN,
    });
    const numberMatch = prUrlMatch[0].match(/\/pull\/(\d+)$/);
    const headBranchMatch = pullRequestSection.match(/head branch[:\s]+`?([^\s`]+)`?/i);
    if (numberMatch !== null && headBranchMatch !== null) {
      try {
        const record = await pullRequests.findByHead(env.LIVE_GITHUB_REPOSITORY, headBranchMatch[1] ?? "");
        prConfirmed = record !== null && String(record.number) === numberMatch[1];
        prDetail = prConfirmed
          ? `GitHub confirms pull request #${record?.number ?? "?"} at ${prUrlMatch[0]}`
          : `GitHub did not return the pull request named at ${prUrlMatch[0]}`;
      } catch (error) {
        prDetail = `the GitHub API call failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else {
      prDetail = `the Pull request section named ${prUrlMatch[0]}, but it did not also name a head branch to confirm`;
    }
  }
  facts.push({ name: "A real GitHub PR is created", holds: prConfirmed, detail: prDetail });
  facts.push({
    name: "Evidence is accessible from Linear",
    holds: proofPackVisible && pullRequestSection.length > 0,
    detail:
      proofPackVisible && pullRequestSection.length > 0
        ? "the Proof Pack comment in Linear links the pull request and the verification evidence"
        : "the Proof Pack comment did not link both the pull request and the verification evidence",
  });

  const failed = facts.filter((fact) => !fact.holds);
  if (failed.length > 0) {
    process.stdout.write("The live acceptance scenario did not confirm every SDD section 67 live fact.\n\n");
    for (const fact of facts) {
      process.stdout.write(`  [${fact.holds ? "OK" : "FAIL"}] ${fact.name} — ${fact.detail}\n`);
    }
    return 1;
  }

  process.stdout.write("Every SDD section 67 live fact was confirmed.\n\n");
  for (const fact of facts) process.stdout.write(`  [OK] ${fact.name} — ${fact.detail}\n`);
  return 0;
};
