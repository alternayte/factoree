import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync } from "node:child_process";

export const startDatabase = async (): Promise<{ url: string; stop: () => Promise<void> }> => {
  const container = await new PostgreSqlContainer("postgres:16").start();
  const url = container.getConnectionUri();
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
  return { url, stop: () => container.stop().then(() => undefined) };
};
