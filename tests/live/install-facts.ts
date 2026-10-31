/**
 * docs/specs/release-0-1-0.md. The sandbox provider and its key moved from the environment to the
 * install settings. The live check reads them where the worker reads them, under `install.*`
 * names, and merges them with the environment. A database it cannot read gives no facts, so the
 * check reports each install requirement as absent.
 */
import { createPrismaClient } from "~/persistence/prisma/client.js";
import { PrismaInstallSettingsStore } from "~/persistence/prisma/install-settings.prisma.js";
import { buildInfo } from "~/config/build-info.js";
import {
  INSTALL_SANDBOX_API_KEY,
  INSTALL_SANDBOX_IMAGE,
  INSTALL_SANDBOX_PROVIDER,
  INSTALL_SANDBOX_URL,
} from "./required-credentials.js";

export const readInstallFacts = async (env: NodeJS.ProcessEnv): Promise<Record<string, string>> => {
  const databaseUrl = env.FACTOREE_DATABASE_URL;
  const masterKey = env.FACTOREE_MASTER_KEY;
  if (databaseUrl === undefined || databaseUrl === "" || masterKey === undefined || masterKey === "") return {};
  const prisma = createPrismaClient(databaseUrl);
  try {
    const { sandbox } = await new PrismaInstallSettingsStore(prisma, masterKey).read();
    const image = sandbox.image ?? buildInfo.sandboxImageDefault;
    return Object.fromEntries(
      Object.entries({
        [INSTALL_SANDBOX_PROVIDER]: sandbox.provider,
        [INSTALL_SANDBOX_API_KEY]: sandbox.apiKey,
        [INSTALL_SANDBOX_URL]: sandbox.url,
        [INSTALL_SANDBOX_IMAGE]: image,
      }).filter((entry): entry is [string, string] => entry[1] !== null),
    );
  } catch {
    return {};
  } finally {
    await prisma.$disconnect();
  }
};
