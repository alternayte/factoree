/**
 * SDD section 66. The live acceptance entry point.
 *
 * The command exits 78 and prints `BLOCKED_EXTERNAL` when a required credential is absent.
 * SDD section 66 names that state, and it says the state is not equivalent to Done. Exit 78 is
 * the `EX_CONFIG` value of `sysexits`, so no CI system reads it as success.
 */
import { missingCredentials, REQUIRED_LIVE_CREDENTIALS } from "./required-credentials.js";

const BLOCKED_EXTERNAL_EXIT = 78;

const main = async (): Promise<number> => {
  const missing = missingCredentials(process.env);
  if (missing.length > 0) {
    process.stdout.write("BLOCKED_EXTERNAL\n\n");
    process.stdout.write(
      `The live acceptance test needs ${REQUIRED_LIVE_CREDENTIALS.length} values. ` +
        `${missing.length} of them are absent:\n\n`,
    );
    for (const entry of missing) {
      process.stdout.write(`  ${entry.name} (${entry.dependency}) — ${entry.description}\n`);
    }
    process.stdout.write("\nRead docs/live-acceptance.md for the setup procedure.\n");
    process.stdout.write("BLOCKED_EXTERNAL is not equivalent to DONE. See SDD section 66.\n");
    return BLOCKED_EXTERNAL_EXIT;
  }

  process.stdout.write("Every required live credential is present.\n");
  process.stdout.write("Read docs/live-acceptance.md and run the procedure it states.\n");
  // The live scenario itself needs a real Linear workspace, a real GitHub repository, and a
  // real Fly organization. Task 10 delivers the entry point, the credential contract, and the
  // documented procedure. The scenario body is written against the real accounts, because a
  // scenario written against no account proves nothing. SDD section 72 forbids a mock here.
  const { runLiveAcceptance } = await import("./scenario.js");
  return await runLiveAcceptance(process.env);
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
