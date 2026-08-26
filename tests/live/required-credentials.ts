/**
 * SDD section 66. The live acceptance test uses a real Linear workspace, a real GitHub fixture
 * repository, a real Fly Sprite, a real Temporal service, at least one real coding-agent
 * runner, a test Backstage catalog, and a test MCP source.
 *
 * Every entry below names one value an operator must supply. The list is the single source for
 * `.env.example`, for `docs/live-acceptance.md`, and for the `BLOCKED_EXTERNAL` report.
 */
export interface LiveCredential {
  /** The environment variable name. */
  name: string;
  /** The SDD section 66 dependency this value reaches. */
  dependency:
    | "linear"
    | "github"
    | "fly-sprites"
    | "temporal"
    | "runner"
    | "backstage"
    | "mcp";
  /** What an operator must put in it. */
  description: string;
}

export const REQUIRED_LIVE_CREDENTIALS: LiveCredential[] = [
  {
    name: "LIVE_LINEAR_API_KEY",
    dependency: "linear",
    description: "A personal API key of the Linear test workspace.",
  },
  {
    name: "LIVE_LINEAR_TEAM_ID",
    dependency: "linear",
    description: "The Linear team the live test creates its fixture issue in.",
  },
  {
    name: "LIVE_GITHUB_TOKEN",
    dependency: "github",
    description: "A token with write access to the GitHub fixture repository only.",
  },
  {
    name: "LIVE_GITHUB_REPOSITORY",
    dependency: "github",
    description: "The fixture repository, as owner/name. It must not be a production repository.",
  },
  {
    name: "LIVE_FLY_API_TOKEN",
    dependency: "fly-sprites",
    description: "A Fly.io token that can create and delete a Sprite.",
  },
  {
    name: "LIVE_FLY_ORGANIZATION",
    dependency: "fly-sprites",
    description: "The Fly.io organization the live Sprite belongs to.",
  },
  {
    name: "LIVE_TEMPORAL_ADDRESS",
    dependency: "temporal",
    description: "The host and port of the real Temporal service.",
  },
  {
    name: "LIVE_TEMPORAL_NAMESPACE",
    dependency: "temporal",
    description: "The Temporal namespace of the live acceptance run.",
  },
  {
    name: "LIVE_RUNNER_NAME",
    dependency: "runner",
    description: 'The coding-agent runner to drive. Use "opencode" or "claude".',
  },
  {
    name: "LIVE_RUNNER_API_KEY",
    dependency: "runner",
    description: "The model provider key that runner authenticates with.",
  },
  {
    name: "LIVE_BACKSTAGE_BASE_URL",
    dependency: "backstage",
    description: "The base URL of the test Backstage catalog.",
  },
  {
    name: "LIVE_BACKSTAGE_TOKEN",
    dependency: "backstage",
    description: "A read token for that Backstage catalog.",
  },
  {
    name: "LIVE_MCP_ENDPOINT",
    dependency: "mcp",
    description: "The endpoint of the test MCP source.",
  },
  {
    name: "LIVE_MCP_TOKEN",
    dependency: "mcp",
    description: "The bearer token of that MCP source.",
  },
];

/** Every credential of the given list the environment does not supply. An empty value counts
 * as absent. */
export const missingCredentialsFor = (
  env: NodeJS.ProcessEnv,
  credentials: LiveCredential[],
): LiveCredential[] =>
  credentials.filter((entry) => {
    const value = env[entry.name];
    return value === undefined || value.trim() === "";
  });

/** Every required full-profile credential the environment does not supply. */
export const missingCredentials = (env: NodeJS.ProcessEnv): LiveCredential[] =>
  missingCredentialsFor(env, REQUIRED_LIVE_CREDENTIALS);
