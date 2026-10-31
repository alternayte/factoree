import { buildServer, type ServerDependencies } from "~/http/server.js";
import { releaseVersion } from "./install-wiring.js";

/**
 * Prints the OpenAPI document of the administration, settings and setup API. `just gen` writes
 * it to api/openapi.json, and the UI client is generated from that file. The document comes from
 * the route schemas alone, so no route runs and every dependency stays unused.
 */
const refuse = (): never => {
  throw new Error("the OpenAPI generator runs no route");
};
const unused = new Proxy({}, { get: () => refuse }) as never;

const dependencies: ServerDependencies = {
  env: {
    FACTOREE_PUBLIC_URL: "http://localhost:3000",
    FACTOREE_MASTER_KEY: "0".repeat(64),
    FACTOREE_UNSAFE_LOCAL_SANDBOX: undefined,
  },
  version: releaseVersion(),
  logger: unused,
  prisma: unused,
  settings: unused,
  auth: unused,
  tenants: unused,
  products: unused,
  repositories: unused,
  linearTeams: unused,
  secrets: unused,
  runs: unused,
  delegation: unused,
  discovery: unused,
  startInstallationSync: unused,
  recordPullRequestPreview: unused,
  setup: { github: unused, linear: unused },
};

const app = buildServer(dependencies);
await app.ready();
process.stdout.write(`${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
