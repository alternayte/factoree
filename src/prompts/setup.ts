import { PREVIEW_TIMEOUT_MAX_SECONDS, SERVICES_WAIT_TIMEOUT_MAX_SECONDS } from "~/domain/products/factoree-config.js";

/** SDD section 56 requires prompt versioning. Change this value whenever the template below changes. */
export const SETUP_PROMPT_VERSION = "setup@14";

export interface SetupPromptFields {
  repository: string;
  /**
   * docs/specs/change-sets.md, DI-21.145. The other repositories of the product, as `owner/repo`.
   * A fake for the API of one of them names it. Absent in older setups.
   */
  productRepositories?: readonly string[];
  primaryRepositoryPath: string;
  productSlug: string;
  linearTeamKey: string;
  /** The test secret names the product holds. The values never reach the prompt. */
  testSecretNames: string[];
  /** The ecosystem host list the sandbox can reach now. */
  ecosystemHosts: readonly string[];
  /**
   * docs/specs/host-credentials.md. The hosts the product's host credentials reach, their redirect
   * hosts included. Factoree adds each credential outside the sandbox. Absent in older setups.
   */
  credentialHosts?: readonly string[];
  /** The file the agent writes the app changes it needs to. */
  appChangesPath: string;
  /**
   * docs/specs/private-stack-onboarding.md. The file the agent writes the source of each part to.
   * Absent in a prompt rendered before it existed.
   */
  sourcesPath?: string;
  /**
   * GitHub issue 82. The file the agent writes each stack it finds and leaves out to. Absent in a
   * prompt rendered before it existed.
   */
  leftOutPath?: string;
  /** The text of the existing config, for a setup run that updates one, or null. */
  existingConfig: string | null;
  /**
   * DI-21.18. The parts the previous setup of this repository proposed and Factoree could not
   * prove, with the reason. A setup pull request holds only the proven parts, so without this
   * list the next agent sees nothing to repair and never tries them again.
   */
  previousNotProven: ReadonlyArray<{ kind: string; name: string; reason: string | null }>;
  /**
   * DI-21.20. The app changes of the repository whose Linear issue is still open. Factoree dedupes
   * on the change text, so the agent repeats a still-needed change word for word.
   */
  requestedChanges: readonly string[];
  /**
   * docs/specs/setup-speed-and-history.md. The parts the previous setup proved. On a repository
   * with a config, the agent runs only the parts it changes and their dependents.
   */
  previousProven: ReadonlyArray<{ kind: string; name: string }>;
  /**
   * docs/specs/setup-speed-and-history.md. The repository instruction file, as SDD section 34 gives
   * the implementer. opencode runs with OPENCODE_DISABLE_PROJECT_CONFIG=1 and loads none itself.
   */
  repositoryInstructions: { file: string; text: string } | null;
}

/** The name of a report part as the prompt writes it. */
const partName = (part: { kind: string; name: string }): string => (part.kind === part.name ? part.kind : `${part.kind} \`${part.name}\``);

/** docs/specs/setup-speed-and-history.md. What the agent runs itself before it stops. */
const ownRunRule = (fields: SetupPromptFields): string =>
  fields.existingConfig === null
    ? "Run the bootstrap, the verify commands, the stack and the preview yourself before you stop, so the configuration works. Factoree checks each part again in a fresh sandbox, and your own run is not evidence."
    : [
        "Run yourself only the parts you add or change, and every part that depends on them, in this order: bootstrap, services, seed, verify and preview, accounts. A change to the bootstrap means you run every part again.",
        "Do not run a part the previous setup proved and you leave unchanged. Factoree proves every part again in a fresh sandbox, and your own run is not evidence.",
        `The previous setup proved these parts:\n${list(fields.previousProven.map(partName), "None.")}`,
      ].join("\n");

const section = (title: string, body: string): string => `## ${title}\n\n${body}\n`;

const list = (items: readonly string[], empty: string): string =>
  items.length === 0 ? empty : items.map((item) => `- ${item}`).join("\n");

/** The config keys the setup agent writes, with one example. The parser in factoree-config.ts is the rule. */
export const CONFIG_SHAPE = `version: 1
identity:
  product: <product>
  linear:
    teamKey: <team key>
bootstrap:
  command: mise install && dotnet restore && (cd web && npm ci)
  keyFiles: ["mise.toml", "**/packages.lock.json", "web/package-lock.json"]
warm:                     # optional: fills build caches before a warm snapshot
  command: dotnet build
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
  timeoutSeconds: 180
  readySelector: "body[data-ready]"  # optional: shows once the page takes input
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
context:                  # optional
  authority: ["ARCHITECTURE.md", "docs/design/**"]  # the docs that state current architecture
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
      "Where the commands come from",
      [
        "Take each command from what the repository already runs, in this order:",
        "1. The CI workflows in `.github/workflows`: the install, build, lint and test steps of the job that runs on a pull request.",
        "2. `.devcontainer/devcontainer.json`, with its features and `postCreateCommand`.",
        "3. The Dockerfile.",
        "4. The task runner: `Makefile`, `justfile`, `Taskfile.yml`, or the `package.json` scripts.",
        "Write a command of your own only when none of these holds one. The CI workflow is the build the team knows passes.",
        "A CI step that needs what a sandbox lacks, such as a cloud login, a deploy secret or a self-hosted runner, stays out. When a product test secret would serve it, say so in the app changes file as the secret name it needs; when the app must change, write that change.",
        ...(fields.sourcesPath === undefined
          ? []
          : [
              `Write one line per part to ${fields.sourcesPath}, in the form \`<part>: <file> step "<step name>"\`, or \`<part>: none\` for a command of your own. ` +
                "The parts are `bootstrap`, `services`, `preview`, `verify <name>` and `account <name>`. " +
                'For example: `verify test: .github/workflows/ci.yml step "Run tests"`. The setup report shows each source.',
            ]),
      ].join("\n"),
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
        "The bootstrap runs in every sandbox: once in a fresh one, and again in each sandbox that Factoree restores from a warm snapshot, where everything it installed is already there. It must pass both times, from the caches. Factoree proves both. Some tools refuse to run when a network check fails, even with their cache full: Azure Functions Core Tools stops `func bundles download` when it cannot reach its CDN within two seconds. Skip such a download when its result already exists, as in `test -d <cache> || <download>`.",
        "warm.command runs only before Factoree takes a warm snapshot, after the bootstrap. Use it only to fill build caches that speed up later commands, such as a first build. Never put in it what a verify command, the seed or the preview needs: a provider with no snapshots never runs it.",
        "List in context.authority the Markdown files that state the current architecture or design, as paths or globs relative to the root, with no leading `./`. " +
          "Leave out plans, per-ticket notes, reports, guides and runbooks: the agents read them anyway, and only a listed file can make Factoree ask which document governs. " +
          "ADRs need no entry, because Factoree reads their status. Leave context.authority out when no document states the architecture.",
        "Use the repository's own compose file in services.compose. Put every extra service, and every fake, in `.factoree/compose.yaml`. Factoree passes it after the repository file, so it can add a service and change the environment of an existing one.",
        "A seed creates the data and the accounts the app needs, through the app's own path: its CLI, its migrations, or its registration endpoint. Put a seed script in `.factoree/`.",
        "A preview command starts every process the app needs, such as an API and a front end, and answers on readyUrl.",
        `preview.timeoutSeconds is at most ${PREVIEW_TIMEOUT_MAX_SECONDS} and services.waitTimeoutSeconds is at most ${SERVICES_WAIT_TIMEOUT_MAX_SECONDS}. Factoree refuses the whole configuration when a value is over its limit. A preview or a stack that needs longer is a part to leave out, not a limit to raise.`,
        "The preview must listen on every interface, 0.0.0.0 or [::], and not on localhost alone: Factoree and its browser reach it through the sandbox's exposed port, from outside the sandbox. Write readyUrl with localhost and the explicit port.",
        "Factoree and its browser send the exposed host name in the Host header. Factoree sets FACTOREE_PREVIEW_HOST to that name, FACTOREE_PREVIEW_URL to the exposed URL, and __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS to the name for Vite. A dev server that checks the Host header, such as webpack-dev-server or the Angular CLI, must allow FACTOREE_PREVIEW_HOST: pass it in the preview command. Do not replace __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS.",
        "Set preview.readySelector only when the app renders its markup before it attaches its handlers, as Blazor Server, Phoenix LiveView and Hotwire do: a click before then does nothing. Pick a selector that shows only once the page takes input. Before the first click or fill after each page load, Factoree waits for it, as well as for the load event and network idle.",
        "agent-browser is installed. Use it against your running preview to find each account's sign-in steps and its check, and to confirm that they sign the account in, before you write them. Factoree signs each account in again with its own browser.",
      ].join("\n"),
    ),
    section(
      "External APIs",
      [
        "For each external API the app calls, choose one way:",
        "- When the product holds a test secret for it, use the real API: name the secret in secrets.require and map it to the variable the app reads.",
        "- Otherwise, add a fake: a WireMock service in `.factoree/compose.yaml` with mappings under `.factoree/fakes/`, built from the API documentation, with the label `factoree.fake: \"<API name>\"`. Point the app at the fake through its environment.",
        ...((fields.productRepositories ?? []).length === 0
          ? []
          : [
              `- When one of these repositories of the product serves the API, add the label \`factoree.fake.repository: "<owner/repo>"\` beside \`factoree.fake\` on its fake: ${(fields.productRepositories ?? []).join(", ")}. ` +
                "Publish the fake's port on the host, and point the app at that host port, such as http://localhost:4010. When Factoree checks both repositories in one change, it answers that port with the real repository's preview in place of the fake.",
            ]),
        "",
        `The product holds these test secrets: ${fields.testSecretNames.length === 0 ? "none" : fields.testSecretNames.join(", ")}.`,
      ].join("\n"),
    ),
    section(
      "Network",
      `The sandbox reaches only these hosts, the ecosystem host list:\n${list(fields.ecosystemHosts, "None.")}\n\n` +
        "Factoree records the hosts the bootstrap reaches and writes sandbox.allowedDomains itself. " +
        "When a download fails because a host is denied, leave the part out. Factoree reports each denied host itself, so never name a host in your app changes file.\n\n" +
        "Only the bootstrap, the services and the seed reach the ecosystem hosts. The verify commands and the preview reach only sandbox.allowedDomains, so a download they make at run time fails in Factoree's sandbox although it passes in yours. " +
        "A test that starts a container, as Testcontainers does, pulls its image at run time. After you run the tests, run `docker image ls`, and pull every image they pulled in the bootstrap with `docker pull <image>:<tag>`, the Testcontainers Ryuk image included. Set docker to true for them." +
        ((fields.credentialHosts ?? []).length === 0
          ? ""
          : "\n\nThe sandbox also reaches these private hosts, and Factoree adds their credentials to each request outside the sandbox:\n" +
            list(fields.credentialHosts ?? [], "None.") +
            "\n\nRestore private packages and pull private images from them with no login: no `docker login`, no `npm login`, no token. " +
            "Commit no credential entry, such as `_authToken` in `.npmrc` or `<packageSourceCredentials>` in `nuget.config`. A file names the source and nothing more. " +
            "A private git dependency on github.com fetches with no token too."),
    ),
    section(
      "What you cannot configure",
      `When a part needs a change to the app itself, such as a hard-coded API URL with no environment override, ` +
        `leave that part out and write one line per needed change to ${fields.appChangesPath}. Never change the app. ` +
        "Factoree turns each line into a Linear issue that a coding agent implements, so each line names one change on its own: " +
        "the file, what to change, and what the setup can then configure. For example: " +
        "\"src/Api/TmdbClient.cs hard-codes https://api.themoviedb.org. Read the base URL from TMDB__BaseUrl, so the setup can point it at a fake.\"" +
        (fields.requestedChanges.length === 0
          ? ""
          : "\n\nThese app changes already have an open Linear issue. When the setup still needs one, copy its line exactly as it is here, so Factoree does not create a second issue:\n\n" +
            list(fields.requestedChanges, "None.")),
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
              fields.previousNotProven.map((part) => `${partName(part)}: ${part.reason ?? "no reason recorded"}`),
              "None.",
            ),
    ),
    section(
      "Rules",
      [
        "You must not change a file outside .factoree/.",
        "You must not put a real credential in the configuration. An account password is a local test value.",
        ownRunRule(fields),
        "Factoree proves the configuration in a fresh sandbox that holds only the repository and your `.factoree/` files. Nothing else you do in this session carries over: no `mise use --global`, no `npm install -g`, no file outside the repository. The bootstrap must install everything the verify commands, the seed and the preview need.",
        "The session stops after 60 minutes. Write the configuration as soon as one part works, and improve it after. Factoree proves what the files hold when the session stops.",
        "A test suite can run for many minutes and print nothing until it ends. Give such a shell command a timeout of up to 30 minutes, or run it in the background with its output in a file and read that file until the command ends.",
        ...(fields.leftOutPath === undefined
          ? []
          : [
              `When the repository holds a stack, an app or a test suite that you leave out of the configuration, write it to ${fields.leftOutPath}: one line \`<stack>: <what you ran> failed: <the error>\`, then the last lines of its output, each indented by two spaces. ` +
                'For example: `dotnet: dotnet restore failed: error NU1301: Unable to load the service index for source https://nuget.pkg.github.com/acme/index.json`. The setup report lists each one under "Not proven, so left out".',
            ]),
      ].join("\n"),
    ),
    section(
      "Repository instructions",
      fields.repositoryInstructions === null
        ? "The repository has no AGENTS.md, CLAUDE.md or CONTRIBUTING.md."
        : `The repository's ${fields.repositoryInstructions.file} follows. It names how the repository builds, tests and runs. Where it conflicts with the rules above, the rules above win: you still write only under .factoree/.\n\n${fields.repositoryInstructions.text}`,
    ),
  ].join("\n");
