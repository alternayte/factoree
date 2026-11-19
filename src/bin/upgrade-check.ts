import { loadEnv } from "~/config/env.js";
import { createPrismaClient } from "~/persistence/prisma/client.js";
import { createTemporalClient } from "~/temporal/connection.js";
import { checkOpenRunsReplay } from "~/temporal/upgrade-check.js";

/**
 * docs/specs/run-workflow-structure.md. `factoree upgrade-check` exits 0 when every open run can
 * replay with this release, and 78 with the list of runs that cannot. The Helm chart runs it in
 * the pre-upgrade hook, and the worker runs the same check before it polls.
 */
const env = loadEnv();
const prisma = createPrismaClient(env.FACTOREE_DATABASE_URL);
const client = await createTemporalClient(env);
try {
  const result = await checkOpenRunsReplay({ client, prisma, publicUrl: env.FACTOREE_PUBLIC_URL });
  if (result.ok) {
    process.stdout.write(`factoree upgrade-check: ${String(result.open)} open run(s), all replayable.\n`);
  } else {
    process.stderr.write(`factoree upgrade-check: ${result.report}\n`);
    process.exitCode = 78;
  }
} finally {
  await client.connection.close();
  await prisma.$disconnect();
}
