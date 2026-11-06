import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import { ECOSYSTEM_HOSTS } from "~/domain/setup/ecosystem-hosts.js";
import { signedInCheckSchema, signInStepSchema } from "~/domain/validation/validation-plan.js";
import { isPreviewRelativePath } from "~/domain/validation/preview-url.js";

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

/**
 * Keys a repository must never set. The file lives inside a repository that Factoree agents
 * write to, so it must never raise a privilege. Specification section 6 fixes this list.
 */
export const PRIVILEGE_KEYS = [
  "policy",
  "autonomy",
  "actionPolicy",
  "riskCaps",
  "redaction",
  "secrets.values",
] as const;

/** Thrown when `.factoree/config.yaml` sets a key that only the Product can own. */
export class FactoreeConfigPrivilegeError extends RunConfigurationError {
  constructor(readonly key: string) {
    super(`.factoree/config.yaml must not set ${key}. The Product owns it.`);
  }
}

/**
 * Walks the raw parsed YAML for a privilege key before the zod parse runs.
 * The guard runs before the schema parse. The error then names the offending key. A generic
 * unknown-key failure from the parse does not name it.
 */
const assertNoPrivilegeKey = (raw: unknown): void => {
  if (typeof raw !== "object" || raw === null) return;
  const record = raw as Record<string, unknown>;
  for (const key of PRIVILEGE_KEYS) {
    const [head, tail] = key.split(".");
    if (head === undefined) continue;
    const value = record[head];
    if (value === undefined) continue;
    if (tail === undefined) throw new FactoreeConfigPrivilegeError(key);
    if (typeof value === "object" && value !== null && tail in (value as Record<string, unknown>)) {
      throw new FactoreeConfigPrivilegeError(key);
    }
  }
};

const identitySchema = z
  .object({
    product: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lower case letters, digits, or hyphen"),
    linear: z
      .object({
        teamKey: z.string().min(1).max(10).regex(/^[A-Za-z][A-Za-z0-9]*$/),
        // docs/specs/own-proposals-and-parallel-runs.md. The Linear projects whose issues target
        // this repository. An issue in one of them needs no target question.
        projects: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
      })
      .strict(),
  })
  .strict();

const commandSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "must be lower case letters, digits, dot, underscore, or hyphen"),
    run: z.string().min(1),
  })
  .strict();

// docs/specs/repository-setup-and-services.md. A path or a glob relative to the repository root. It
// must not leave the checkout.
const REPOSITORY_PATH = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "must be relative to the repository root");

const schema = z
  .object({
    version: z.literal(1),
    identity: identitySchema,
    bootstrap: z
      .object({
        command: z.string().min(1),
        // docs/specs/repository-setup-and-services.md. The files whose content keys the warm snapshot,
        // so a lockfile or toolchain change starts a build-ahead.
        keyFiles: z.array(REPOSITORY_PATH).max(50).default([]),
        // docs/specs/repository-setup-and-services.md. Ecosystem hosts only the bootstrap reaches.
        // Factoree keeps only the hosts of its ecosystem host list, and no agent ever reaches them.
        // A setup on a provider with no egress log writes the whole list, so the list sets the cap.
        allowedDomains: z.array(z.string().min(1).regex(HOST_NAME, "must be a host name")).max(ECOSYSTEM_HOSTS.length).default([]),
      })
      .strict()
      .nullable()
      .default(null),
    // docs/specs/repository-setup-and-services.md. The compose stack Factoree starts in each sandbox.
    services: z
      .object({
        compose: REPOSITORY_PATH,
        profiles: z.array(z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)).max(20).default([]),
        seed: z.string().min(1).nullable().default(null),
        waitTimeoutSeconds: z.number().int().positive().max(600).default(180),
      })
      .strict()
      .nullable()
      .default(null),
    // docs/specs/repository-setup-and-services.md. A Docker socket with no compose stack, for
    // Testcontainers. A `services` block implies it.
    docker: z.boolean().default(false),
    // docs/specs/repository-setup-and-services.md. The accounts a browser assertion can start signed
    // in as. The seed creates them in the sandbox's own database, so the passwords are no secrets.
    // A fill value may name {username} and {password}.
    accounts: z
      .array(
        z
          .object({
            name: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/, "must be lower case letters, digits, or hyphen"),
            username: z.string().min(1),
            password: z.string().min(1),
            steps: z.array(signInStepSchema).min(1).max(20),
            check: signedInCheckSchema,
          })
          .strict(),
      )
      .max(10)
      .default([]),
    // docs/specs/run-speed.md. Runs only when Factoree takes a warm snapshot, to fill build caches.
    warm: z.object({ command: z.string().min(1) }).strict().nullable().default(null),
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
        // DI-21.17. The sandbox image ships opencode only, so every role defaults to it.
        validator: z.string().min(1).default("opencode"),
        reviewer: z.string().min(1).default("opencode"),
      })
      .strict()
      .default({ implementer: "opencode", validator: "opencode", reviewer: "opencode" }),
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
    // The repository can only name a secret it needs. The Product owns the value.
    secrets: z
      .object({ require: z.array(z.string().min(1)).default([]) })
      .strict()
      .default({ require: [] }),
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

  assertNoPrivilegeKey(document);

  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(describeIssue).join("; ");
    throw new RunConfigurationError(`${FACTOREE_CONFIG_PATH} is invalid: ${detail}`);
  }

  const accountNames = new Set<string>();
  for (const account of parsed.data.accounts) {
    if (accountNames.has(account.name)) {
      throw new RunConfigurationError(`${FACTOREE_CONFIG_PATH} is invalid: accounts holds a duplicate name "${account.name}".`);
    }
    accountNames.add(account.name);
    for (const step of account.steps) {
      if (step.action === "goto" && !isPreviewRelativePath(step.path)) {
        throw new RunConfigurationError(
          `${FACTOREE_CONFIG_PATH} is invalid: the sign-in of account "${account.name}" goes to "${step.path}", which is not a relative preview path.`,
        );
      }
    }
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
