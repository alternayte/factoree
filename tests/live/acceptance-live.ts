/**
 * SDD section 66. The live acceptance entry point.
 *
 * The command exits 78 and prints `BLOCKED_EXTERNAL` when a required credential of the active
 * profile is absent. SDD section 66 names that state, and it says the state is not equivalent
 * to Done. Exit 78 is the `EX_CONFIG` value of `sysexits`, so no CI system reads it as success.
 *
 * The command reads `FACTOREE_LIVE_PROFILE` first. The default profile is `full`, the strict
 * profile SDD section 66 demands. The `local` profile is a convenience for the scenario code.
 * A `local` pass is NOT SDD section 66 proof. Read `docs/live-acceptance.md`.
 */
import { unmetRequirementsFor } from "./required-credentials.js";
import { PROFILE_BANNER, credentialsFor, resolveProfile } from "./profile.js";

const BLOCKED_EXTERNAL_EXIT = 78;

const main = async (): Promise<number> => {
  const profile = resolveProfile(process.env);
  process.stdout.write(`${PROFILE_BANNER[profile]}\n\n`);

  const requirements = credentialsFor(profile, process.env);
  const unmet = unmetRequirementsFor(process.env, requirements);
  if (unmet.length > 0) {
    process.stdout.write("BLOCKED_EXTERNAL\n\n");
    process.stdout.write(
      `The live acceptance test needs ${requirements.length} values. ` +
        `${unmet.length} of them do not meet their requirement:\n\n`,
    );
    for (const { requirement, actual } of unmet) {
      const state =
        actual === undefined
          ? "is absent"
          : `is "${actual}", but it must equal "${requirement.value}"`;
      process.stdout.write(
        `  ${requirement.name} (${requirement.dependency}) ${state} — ${requirement.description}\n`,
      );
    }
    process.stdout.write("\nRead docs/live-acceptance.md for the setup procedure.\n");
    process.stdout.write("BLOCKED_EXTERNAL is not equivalent to DONE. See SDD section 66.\n");
    return BLOCKED_EXTERNAL_EXIT;
  }

  process.stdout.write("Every required live credential of this profile is present.\n");
  process.stdout.write("Read docs/live-acceptance.md and run the procedure it states.\n");
  // The live scenario itself needs a real Linear workspace, a real GitHub repository, and a
  // real Fly organization. Task 10 delivers the entry point, the credential contract, and the
  // documented procedure. The scenario body is written against the real accounts, because a
  // scenario written against no account proves nothing. SDD section 72 forbids a mock here.
  const { runLiveAcceptance } = await import("./scenario.js");
  const exitCode = await runLiveAcceptance(process.env);

  if (profile === "local" || profile === "sprite") {
    process.stdout.write(`\n${PROFILE_BANNER[profile]}\n`);
  }

  return exitCode;
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
