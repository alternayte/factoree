import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync } from "node:child_process";
import type { TestProject } from "vitest/node";
import {
  bundleAgentRunWorkflow,
  deleteAgentRunWorkflowBundle,
} from "../../workflow/support/bundle-agent-run-workflow.js";

/**
 * Connection facts for the one template database. `startDatabase` uses these facts to
 * make a cheap `CREATE DATABASE ... TEMPLATE` copy for each caller.
 *
 * `maintenanceDatabase` names a database that is never the template, because a session
 * cannot copy a template it is connected to. Postgres always carries a `postgres`
 * database, so this module uses that database for administrative commands.
 */
export interface TemplateDatabase {
  host: string;
  port: number;
  user: string;
  password: string;
  templateDatabase: string;
  maintenanceDatabase: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    templateDatabase: TemplateDatabase;
    agentRunWorkflowBundlePath: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/**
 * Starts one Postgres testcontainer for the whole integration run and migrates it once.
 * Vitest calls this function a single time, before any test file, and calls the returned
 * function once after every test file finishes.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  container = await new PostgreSqlContainer("postgres:16").start();
  const url = container.getConnectionUri();

  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    });
  } catch (error) {
    await container.stop();
    container = undefined;
    throw error;
  }

  // `prisma migrate deploy` runs in its own process and closes its connection to the
  // template database on exit, so the template carries no open connection here.

  const templateDatabase: TemplateDatabase = {
    host: container.getHost(),
    port: container.getMappedPort(5432),
    user: container.getUsername(),
    password: container.getPassword(),
    templateDatabase: container.getDatabase(),
    maintenanceDatabase: "postgres",
  };

  project.provide("templateDatabase", templateDatabase);

  const agentRunBundlePath = await bundleAgentRunWorkflow();
  project.provide("agentRunWorkflowBundlePath", agentRunBundlePath);

  return async () => {
    if (container) {
      await container.stop();
      container = undefined;
    }
    await deleteAgentRunWorkflowBundle(agentRunBundlePath);
  };
}
