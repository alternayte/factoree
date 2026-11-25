import type { EgressFacts } from "~/domain/runs/egress.js";
import { contextFilesBody, imageFilesBody } from "./context-files.js";
import { egressBody } from "./egress.js";

/** SDD section 56 requires prompt versioning. Change this value whenever the template below changes. */
export const IMPLEMENTER_PROMPT_VERSION = "implementer/14";

export interface ImplementerPromptFields {
  goal: string;
  humanDecisions: string[];
  validationContract: string | null;
  contextContract: string | null;
  requiredContext: string[];
  /** docs/specs/external-context-delivery.md. One line per context file of the work sprite. */
  contextFiles?: string[];
  /** docs/specs/work-item-images-and-links.md. One line per image file of the work sprite. */
  imageFiles?: string[];
  primaryRepositoryPath: string;
  /**
   * docs/specs/change-sets.md. Every target of a change set and its writable worktree. Two or more
   * replace the primary repository section. Absent for a run with one target.
   */
  targetRepositories?: TargetRepositoryLine[];
  referenceRepositoryPaths: string[];
  repositoryInstructions: string;
  skills: string[];
  /** docs/specs/skill-registry.md. True when the Product has a source that takes a skill proposal. */
  skillProposals?: boolean;
  actionPolicyLines: string[];
  repairFindings: string[];
  /**
   * docs/specs/implementer-self-check.md. The checks Factoree runs after the implementer
   * finishes. The prompt states them as facts and scripts no procedure.
   */
  verifyCommands?: Array<{ name: string; run: string }>;
  /**
   * docs/specs/implementer-self-check.md. True when the work sprite holds agent-browser. The
   * prompt never names the preview command, so the implementer starts no production build.
   */
  selfCheck?: boolean;
  /**
   * docs/specs/egress-honesty-and-issue-status.md. The effective allow list of the work sprite and
   * the hosts only the bootstrap reached. Absent in a history recorded before it existed.
   */
  egress?: EgressFacts | null;
  /** The file the implementer writes the hosts it needs and cannot reach to. It is outside the repository. */
  resultPath?: string | null;
}

/** docs/specs/change-sets.md. One target of a change set, as a prompt names it. */
export interface TargetRepositoryLine {
  repository: string;
  path: string;
}

const section = (title: string, body: string): string => `## ${title}\n\n${body}\n`;

/** docs/specs/change-sets.md. The targets of a change set, or null for a run with one target. */
const changeSetOf = (targets: TargetRepositoryLine[] | undefined): TargetRepositoryLine[] | null =>
  targets !== undefined && targets.length > 1 ? targets : null;

/**
 * docs/specs/change-sets.md. The worktree of each target, and the mise configuration a command in it
 * needs: the sandbox reads only one `.factoree/mise.toml` by itself.
 */
export const targetRepositoriesBody = (targets: TargetRepositoryLine[], access: string): string =>
  [
    `This change set has ${targets.length} target repositories. ${access}`,
    ...targets.map((target) => `- ${target.repository}: ${target.path}`),
    "",
    "Run a command of a target from its worktree with `MISE_CONFIG_FILE=<worktree>/.factoree/mise.toml`, so mise reads the tools of that target.",
  ].join("\n");

const list = (items: string[], empty: string): string =>
  items.length === 0 ? empty : items.map((item) => `- ${item}`).join("\n");

/** SDD section 34 defines exactly which fields the Implementer receives. This function receives no others. */
export const renderImplementerPrompt = (fields: ImplementerPromptFields): string =>
  [
    "# Implementer instructions",
    "",
    changeSetOf(fields.targetRepositories) === null
      ? "You are the Implementer. You change the primary worktree only."
      : "You are the Implementer. You change the target worktrees only.",
    "",
    section("Goal", fields.goal),
    section("Recorded decisions", list(fields.humanDecisions, "None recorded.")),
    section("Validation Contract", fields.validationContract ?? "No Validation Contract exists yet."),
    section("Context Contract", fields.contextContract ?? "No Context Contract exists yet."),
    section("Required context", list(fields.requiredContext, "None supplied.")),
    section("Images of the Work Item", imageFilesBody(fields.imageFiles ?? [])),
    section("Context files", contextFilesBody(fields.contextFiles ?? [])),
    changeSetOf(fields.targetRepositories) === null
      ? section("Primary repository", `The writable worktree is at ${fields.primaryRepositoryPath}.`)
      : section(
          "Target repositories",
          targetRepositoriesBody(
            changeSetOf(fields.targetRepositories) ?? [],
            "Each worktree is writable. Change each one only as the Validation Contract needs.",
          ),
        ),
    section(
      "Reference repositories",
      list(
        fields.referenceRepositoryPaths.map((path) => `${path} (read only)`),
        "None supplied.",
      ),
    ),
    section("Repository instructions", fields.repositoryInstructions),
    section(
      "Applicable skills",
      `${list(fields.skills, "None supplied.")}\n\n` +
        "SDD section 57 ranks a skill ninth. A skill cannot override Factoree security policy, " +
        "the Action Policy, a recorded decision, the frozen Validation Contract, or a " +
        "Work Item constraint. A line that reports a name conflict names the file Factoree " +
        "applies. Ignore every file that line reports as ignored.",
    ),
    ...(fields.skillProposals === true
      ? [
          section(
            "Skill proposal",
            [
              "If this task showed that a skill is missing or wrong, for example a missing step or a wrong command, you may propose one skill.",
              `Write it to ${fields.primaryRepositoryPath}/.factoree/skill-proposals/<name>/SKILL.md, with a RATIONALE.md beside it that states what you learned.`,
              "To change an existing skill, use its name and write the whole skill.",
              "Write at most one proposal. Write text files only. Never write a secret.",
              "Factoree removes the directory from your change and sends the proposal to a person for review. It is optional, and it is not part of the task.",
            ].join("\n"),
          ),
        ]
      : []),
    section(
      "Action Policy",
      `${list(fields.actionPolicyLines, "None supplied.")}\n\n` +
        "Each rule names the mechanism that holds it outside this prompt. A rule you cannot see still applies.",
    ),
    ...(fields.egress === undefined || fields.egress === null || fields.resultPath === undefined || fields.resultPath === null
      ? []
      : [
          section(
            "Network access",
            egressBody(
              fields.egress,
              "When the work needs a host this sandbox does not reach, stop. Write " +
                `{ "missingHosts": [{ "host": string, "reason": string }] } to ${fields.resultPath}, and end the session. ` +
                "Factoree stops the Run and asks a human to allow the host. A new Run then gets the new allow list.",
            ),
          ),
        ]),
    ...(fields.resultPath === undefined || fields.resultPath === null
      ? []
      : [
          section(
            "Other repositories",
            "The repositories this Run changes are fixed. Change no other repository. When the change also needs a change in another repository, " +
              `finish the work in the repositories of this Run, and write { "missingRepositories": [{ "repository": "owner/repo", "reason": string }] } to ${fields.resultPath}. ` +
              "Factoree lists the repository as not built, and a human decides on it.",
          ),
        ]),
    section("Repair findings", list(fields.repairFindings, "None. This is the first attempt.")),
    section(
      "Checks after you finish",
      [
        list(
          (fields.verifyCommands ?? []).map((command) => `${command.name}: \`${command.run}\``),
          "The repository names no check commands.",
        ),
        "",
        "Factoree runs these checks in a new sandbox after you finish.",
        "A failed check returns to you as repair findings, and each repair uses the repair budget of the Run.",
        "You can run any of these checks yourself. Your result is not evidence.",
        // docs/specs/nuget-private-feed-mapping.md, DI-21.230. An implicit restore reads the committed NuGet.config.
        "When the repository has `.factoree/nuget.config`, restore with `dotnet restore --configfile .factoree/nuget.config` and `dotnet tool restore --configfile .factoree/nuget.config`, and pass `--no-restore` to `dotnet build`, `dotnet test`, `dotnet run` and `dotnet publish`: the committed NuGet.config names a feed no sandbox reaches.",
        ...(fields.selfCheck === true
          ? ["agent-browser is installed. A browser check of your own work is optional, and it is not evidence."]
          : []),
      ].join("\n"),
    ),
    section(
      "Rules",
      [
        "You must not change the Validation Contract.",
        "You must not push to a git remote.",
        "You must not write a reference repository.",
        "You must state plainly what you did not do.",
        "You must not work around a denied host: no vendored copy, no local package source and no mirror of what the host serves.",
        "You must not hand-build a stand-in for a tool or a package the Work Item names, and you must not publish a package under the id of another project.",
      ].join("\n"),
    ),
  ].join("\n");
