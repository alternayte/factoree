import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";

/**
 * SDD section 15. The `.factoree/config.yaml` of the primary repository.
 *
 * The schema is strict at every level, because SDD section 15 requires that an unknown key
 * fails validation. A typo in a key must never pass silently as a default.
 *
 * SDD section 57 places this file below Factoree security policy, the Action Policy, recorded
 * human decisions, the frozen Validation Contract, and Work Item constraints. Nothing parsed
 * here can raise a control that a higher rule sets.
 */

// A host name, or the conventional wildcard form `*.` followed by a host name. The same shape
// the sandbox uses. A bare `*`, and a wildcard label with no dot such as `*example.com`, have no
// defined meaning and stay rejected.
const HOST_NAME = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

const commandSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "must be lower case letters, digits, dot, underscore, or hyphen"),
    run: z.string().min(1),
  })
  .strict();

const schema = z
  .object({
    version: z.literal(1),
    bootstrap: z.object({ command: z.string().min(1) }).strict().nullable().default(null),
    verify: z
      .object({ commands: z.array(commandSchema).min(1, "verify.commands must hold at least one command") })
      .strict(),
    // Phase 7 consumes `preview`. Phase 3 validates it and stores nothing.
    preview: z
      .object({
        enabled: z.boolean(),
        command: z.string().min(1),
        readyUrl: z.string().url(),
        timeoutSeconds: z.number().int().positive().max(600),
      })
      .strict()
      .nullable()
      .default(null),
    agents: z
      .object({
        implementer: z.string().min(1).default("opencode"),
        validator: z.string().min(1).default("claude"),
        reviewer: z.string().min(1).default("claude"),
      })
      .strict()
      .default({ implementer: "opencode", validator: "claude", reviewer: "claude" }),
    // SDD section 42. The default total repair limit is 2.
    repair: z
      .object({ maxAttempts: z.number().int().min(0).max(10).default(2) })
      .strict()
      .default({ maxAttempts: 2 }),
    sandbox: z
      .object({
        allowedDomains: z.array(z.string().min(1).regex(HOST_NAME, "must be a host name")).default([]),
      })
      .strict()
      .default({ allowedDomains: [] }),
    // Phase 4 and Phase 5 consume `context`. Phase 3 validates it and stores nothing.
    context: z
      .object({
        backstage: z.object({ enabled: z.boolean().default(false) }).strict().default({ enabled: false }),
        referenceRepositories: z
          .object({ automaticDiscovery: z.boolean().default(false) })
          .strict()
          .default({ automaticDiscovery: false }),
      })
      .strict()
      .default({ backstage: { enabled: false }, referenceRepositories: { automaticDiscovery: false } }),
    // Phase 9 consumes `policy`. SDD section 57 forbids this file from raising a level a human
    // set, so Phase 3 reads the level of the Run from the Project record instead.
    policy: z
      .object({ defaultAutonomy: z.enum(["L0", "L1", "L2", "L3", "L4"]).default("L3") })
      .strict()
      .default({ defaultAutonomy: "L3" }),
  })
  .strict();

export type FactoreeConfig = z.infer<typeof schema>;

/** The path of the file inside the primary repository. SDD section 15 fixes it. */
export const FACTOREE_CONFIG_PATH = ".factoree/config.yaml";

const describeIssue = (issue: z.core.$ZodIssue): string => {
  const path = issue.path.length === 0 ? "the document" : issue.path.join(".");
  // A strict object reports the rejected keys separately. They must reach the operator by name.
  const keys = issue.code === "unrecognized_keys" ? ` (${issue.keys.join(", ")})` : "";
  return `${path}: ${issue.message}${keys}`;
};

/**
 * Parses and validates one `.factoree/config.yaml`. Every fault is a `RunConfigurationError`,
 * because an operator must repair the repository. A retry runs the same file and fails again.
 */
export const parseFactoreeConfig = (text: string): FactoreeConfig => {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new RunConfigurationError(
      `${FACTOREE_CONFIG_PATH} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new RunConfigurationError(`${FACTOREE_CONFIG_PATH} must hold a mapping at the top level.`);
  }

  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(describeIssue).join("; ");
    throw new RunConfigurationError(`${FACTOREE_CONFIG_PATH} is invalid: ${detail}`);
  }

  const names = new Set<string>();
  for (const command of parsed.data.verify.commands) {
    if (names.has(command.name)) {
      throw new RunConfigurationError(
        `${FACTOREE_CONFIG_PATH} is invalid: verify.commands holds a duplicate name "${command.name}".`,
      );
    }
    names.add(command.name);
  }

  return parsed.data;
};
