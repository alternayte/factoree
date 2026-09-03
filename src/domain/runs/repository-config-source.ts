import type { Sandbox, SandboxRef } from "./sandbox.js";
import { RunConfigurationError } from "./run-configuration-error.js";
import type { FactoreeConfig } from "~/domain/products/factoree-config.js";
import { FACTOREE_CONFIG_PATH, parseFactoreeConfig } from "~/domain/products/factoree-config.js";

/**
 * SDD section 15. The primary repository owns `.factoree/config.yaml`, so the only honest source
 * of the file is the checkout inside the sandbox. Every read goes through `Sandbox.exec`, so no
 * adapter needs a file API and both adapters behave alike.
 */

/**
 * The repository instruction files of SDD section 34, in precedence order. The first one that
 * exists wins. A repository that holds two of them states its agent instructions in the first.
 */
export const REPOSITORY_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"] as const;

/** The largest instruction text Factoree places in the Implementer prompt. */
const MAX_INSTRUCTION_BYTES = 64 * 1024;

const join = (directory: string, path: string): string => `${directory.replace(/\/+$/, "")}/${path}`;

/** Reads one file. It reports null when the file does not exist or cannot be read. */
const readFile = async (sandbox: Sandbox, ref: SandboxRef, path: string): Promise<string | null> => {
  const result = await sandbox.exec(ref, { file: "cat", args: ["--", path] });
  return result.exitCode === 0 ? result.stdout : null;
};

/**
 * Reads and validates `.factoree/config.yaml` from the primary checkout. A missing file and an
 * invalid file are both configuration faults, because SDD section 15 makes the file mandatory
 * and requires that an unknown key fails validation.
 */
export const readRepositoryConfig = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  primaryPath: string,
): Promise<FactoreeConfig> => {
  const text = await readFile(sandbox, ref, join(primaryPath, FACTOREE_CONFIG_PATH));
  if (text === null) {
    throw new RunConfigurationError(
      `The primary repository does not contain ${FACTOREE_CONFIG_PATH}. SDD section 15 requires it.`,
    );
  }
  return parseFactoreeConfig(text);
};

/**
 * Reads the repository instructions of SDD section 34. A repository that holds none is normal,
 * so this returns an empty text rather than a fault.
 */
export const readRepositoryInstructions = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  primaryPath: string,
): Promise<string> => {
  for (const name of REPOSITORY_INSTRUCTION_FILES) {
    const text = await readFile(sandbox, ref, join(primaryPath, name));
    if (text === null) continue;
    // A very large instruction file must not push the goal out of the prompt.
    return Buffer.byteLength(text, "utf8") > MAX_INSTRUCTION_BYTES
      ? `${text.slice(0, MAX_INSTRUCTION_BYTES)}\n\n[Factoree truncated ${name} at ${MAX_INSTRUCTION_BYTES} bytes.]`
      : text;
  }
  return "";
};
