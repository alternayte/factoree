/** SDD section 56 requires prompt versioning. Change this value whenever the template below changes. */
export const SETUP_PROMPT_VERSION = "setup@4";

export interface SetupPromptFields {
  repository: string;
  primaryRepositoryPath: string;
  productSlug: string;
  linearTeamKey: string;
  /** The test secret names the product holds. The values never reach the prompt. */
  testSecretNames: string[];
  /** The ecosystem host list the sandbox can reach now. */
  ecosystemHosts: readonly string[];
  /** The file the agent writes the app changes it needs to. */
  appChangesPath: string;
  /** The text of the existing config, for a setup run that updates one, or null. */
  existingConfig: string | null;
  /**
   * DI-21.18. The parts the previous setup of this repository proposed and Factoree could not
   * prove, with the reason. A setup pull request holds only the proven parts, so without this
   * list the next agent sees nothing to repair and never tries them again.
   */
  previousNotProven: ReadonlyArray<{ kind: string; name: string; reason: string | null }>;
}

const section = (title: string, body: string): string => `## ${title}\n\n${body}\n`;

const list = (items: readonly string[], empty: string): string =>
  items.length === 0 ? empty : items.map((item) => `- ${item}`).join("\n");

/** The config keys the setup agent writes, with one example. The parser in factoree-config.ts is the rule. */
const CONFIG_SHAPE = `version: 1
identity:
  product: <product>
  linear:
    teamKey: <team key>
bootstrap:
  command: mise install && dotnet restore && (cd web && npm ci)
  keyFiles: ["mise.toml", "**/packages.lock.json", "web/package-lock.json"]
verify:
  commands:
    - name: build
      run: dotnet build
    - name: test
      run: dotnet test
services:                 # optional: the compose stack, started before the bootstrap
  compose: docker-compose.yml
  profiles: []
  seed: ./.factoree/seed.sh   # optional: runs once after the bootstrap
  waitTimeoutSeconds: 180
docker: false             # true for Testcontainers without a compose stack
preview:                  # optional: the app a browser check runs against
  enabled: true
  command: ./.factoree/preview.sh
  readyUrl: http://localhost:3000/
  timeoutSeconds: 600
accounts:                 # optional: users the seed creates, for signed-in browser checks
  - name: member
    username: member@example.test
    password: local-password
    steps:
      - { action: goto, path: /login }
      - { action: fill, selector: "#email", value: "{username}" }
      - { action: fill, selector: "#password", value: "{password}" }
      - { action: click, selector: "button[type=submit]" }
    check: { action: expectVisible, selector: "[data-testid=user-menu]" }
sandbox:
  allowedDomains: []      # Factoree fills this from what the bootstrap reached
secrets:
  require: []             # the product test secret names the app reads`;

/**
 * docs/specs/repository-setup-and-services.md. The setup agent reads one repository and writes its
 * Factoree configuration under `.factoree/`. Factoree proves each part in a fresh sandbox after
 * the session, so the prompt asks for a configuration that works, not for a claim that it does.
 */
export const renderSetupPrompt = (fields: SetupPromptFields): string =>
  [
    "# Setup instructions",
    "",
    `You are the setup agent for the repository ${fields.repository}. You run in a fresh context. ` +
      "Read the repository and write its Factoree configuration, so Factoree can build, test and " +
      "run it in a sandbox like a developer does after a clone.",
    "",
    section(
      "Repository",
      `The repository is at ${fields.primaryRepositoryPath}. Write only under ` +
        `${fields.primaryRepositoryPath}/.factoree/. Factoree refuses the setup when any other file changes.`,
    ),
    section(
      "What to write",
      [
        "Write `.factoree/config.yaml` with this shape:",
        "",
        "```yaml",
        CONFIG_SHAPE,
        "```",
        "",
        `Set identity.product to "${fields.productSlug}" and identity.linear.teamKey to "${fields.linearTeamKey}".`,
        "Install each toolchain the image lacks with mise: write `.factoree/mise.toml` when the repository has no mise.toml or .tool-versions, and start the bootstrap with `mise install`. Every command already reads `.factoree/mise.toml` through MISE_CONFIG_FILE, so a command needs no mise prefix. A global.json names the .NET SDK version.",
        "List in bootstrap.keyFiles every lockfile and toolchain file the bootstrap reads.",
        "Use the repository's own compose file in services.compose. Put every extra service, and every fake, in `.factoree/compose.yaml`. Factoree passes it after the repository file, so it can add a service and change the environment of an existing one.",
        "A seed creates the data and the accounts the app needs, through the app's own path: its CLI, its migrations, or its registration endpoint. Put a seed script in `.factoree/`.",
        "A preview command starts every process the app needs, such as an API and a front end, and answers on readyUrl.",
        "The preview must listen on every interface, 0.0.0.0 or [::], and not on localhost alone: Factoree and its browser reach it through the sandbox's exposed port, from outside the sandbox. Write readyUrl with localhost and the explicit port.",
        "agent-browser is installed. Use it against your running preview to find each account's sign-in steps and its check, and to confirm that they sign the account in, before you write them. Factoree signs each account in again with its own browser.",
      ].join("\n"),
    ),
    section(
      "External APIs",
      [
        "For each external API the app calls, choose one way:",
        "- When the product holds a test secret for it, use the real API: name the secret in secrets.require and map it to the variable the app reads.",
        "- Otherwise, add a fake: a WireMock service in `.factoree/compose.yaml` with mappings under `.factoree/fakes/`, built from the API documentation, with the label `factoree.fake: \"<API name>\"`. Point the app at the fake through its environment.",
        "",
        `The product holds these test secrets: ${fields.testSecretNames.length === 0 ? "none" : fields.testSecretNames.join(", ")}.`,
      ].join("\n"),
    ),
    section(
      "Network",
      `The sandbox reaches only these hosts, the ecosystem host list:\n${list(fields.ecosystemHosts, "None.")}\n\n` +
        "Factoree records the hosts the bootstrap reaches and writes sandbox.allowedDomains itself. " +
        "When a download fails because a host is denied, name the host in your app changes file.",
    ),
    section(
      "What you cannot configure",
      `When a part needs a change to the app itself, such as a hard-coded API URL with no environment override, ` +
        `leave that part out and write one line per needed change to ${fields.appChangesPath}. Never change the app.`,
    ),
    section(
      "Existing configuration",
      fields.existingConfig === null
        ? "The repository has no Factoree configuration yet."
        : `The repository already has this configuration. Keep every part that still works, repair what fails, and add every part it lacks that the repository supports: a test command, the accounts, the fakes:\n\n\`\`\`yaml\n${fields.existingConfig}\n\`\`\``,
    ),
    section(
      "Previous setup",
      fields.previousNotProven.length === 0
        ? "No previous setup of this repository left a part unproven."
        : "The previous setup proposed these parts, and Factoree could not prove them in its fresh sandbox, so they are not in the configuration. Try each again: find the cause in the reason, and fix it from `.factoree/` when you can.\n\n" +
            list(
              fields.previousNotProven.map((part) => `${part.kind === part.name ? part.kind : `${part.kind} \`${part.name}\``}: ${part.reason ?? "no reason recorded"}`),
              "None.",
            ),
    ),
    section(
      "Rules",
      [
        "You must not change a file outside .factoree/.",
        "You must not put a real credential in the configuration. An account password is a local test value.",
        "Run the bootstrap, the verify commands, the stack and the preview yourself before you stop, so the configuration works. Factoree checks each part again in a fresh sandbox, and your own run is not evidence.",
        "Factoree proves the configuration in a fresh sandbox that holds only the repository and your `.factoree/` files. Nothing else you do in this session carries over: no `mise use --global`, no `npm install -g`, no file outside the repository. The bootstrap must install everything the verify commands, the seed and the preview need.",
        "The session stops after 60 minutes. Write the configuration as soon as one part works, and improve it after. Factoree proves what the files hold when the session stops.",
      ].join("\n"),
    ),
  ].join("\n");
