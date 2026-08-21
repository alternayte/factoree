import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync } from "node:child_process";

export const startDatabase = async (): Promise<{ url: string; stop: () => Promise<void> }> => {
  const container = await new PostgreSqlContainer("postgres:16").start();
  const url = container.getConnectionUri();
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    });
  } catch (error) {
    // Stop the container, so a migration failure does not leak it.
    await container.stop();
    throw error;
  }
  return { url, stop: () => container.stop().then(() => undefined) };
};
