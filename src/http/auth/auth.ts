import { createHash, hkdfSync } from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { apiKey } from "@better-auth/api-key";
import type { FactoreePrismaClient } from "~/persistence/prisma/client.js";
import type { InstallSettingsStore } from "~/domain/settings/install-settings.js";
import { readLinearViewer } from "~/adapters/linear/linear-app-flows.js";
import type { Logger } from "~/telemetry/logger.js";
import { admitLinearAccount, admitUser, NotAMemberError, recordLinearMember } from "./membership.js";

export const AUTH_BASE_PATH = "/api/auth";
/** The prefix of every Factoree API key, so a leaked key is easy to recognise in a scan. */
export const API_KEY_PREFIX = "fct_";

export interface AuthOptions {
  prisma: FactoreePrismaClient;
  publicUrl: string;
  masterKey: string;
  linear: { clientId: string; clientSecret: string } | null;
  logger: Logger;
}

/** better-auth signs cookies and state with this secret. It derives from the master key. */
const authSecret = (masterKey: string): string =>
  Buffer.from(hkdfSync("sha256", Buffer.from(masterKey, "hex"), Buffer.alloc(0), "factoree-auth-secret", 32)).toString("hex");

/** A refusal of the hook, as the error better-auth turns into a redirect with `?error=`. */
const refuse = async (body: () => Promise<void>): Promise<void> => {
  try {
    await body();
  } catch (error) {
    if (error instanceof NotAMemberError) throw new APIError("FORBIDDEN", { message: "not_a_member" });
    throw error;
  }
};

/**
 * docs/specs/release-0-1-0.md. Sign-in with Linear through better-auth, its Prisma adapter and
 * its API keys. The Linear app install (actor=app) is a separate grant, and Factoree code keeps
 * it. The sign-in grant asks for `read` only and acts as the person.
 */
export const createAuth = (options: AuthOptions) =>
  betterAuth({
    appName: "Factoree",
    baseURL: options.publicUrl,
    basePath: AUTH_BASE_PATH,
    secret: authSecret(options.masterKey),
    trustedOrigins: [options.publicUrl],
    database: prismaAdapter(options.prisma, { provider: "postgresql", transaction: true }),
    emailAndPassword: { enabled: false },
    socialProviders:
      options.linear === null
        ? {}
        : {
            linear: {
              clientId: options.linear.clientId,
              clientSecret: options.linear.clientSecret,
              overrideUserInfoOnSignIn: true,
              // The default read names no workspace and no admin flag. This read names both, and
              // records them before better-auth writes any row, so the hooks below can decide.
              getUserInfo: async (token) => {
                if (token.accessToken === undefined) return null;
                const viewer = await readLinearViewer(token.accessToken);
                await recordLinearMember(options.prisma, viewer);
                return {
                  user: {
                    name: viewer.name,
                    email: viewer.email,
                    ...(viewer.avatarUrl === null ? {} : { image: viewer.avatarUrl }),
                    emailVerified: false,
                  },
                  data: {
                    id: viewer.id,
                    name: viewer.name,
                    email: viewer.email,
                    ...(viewer.avatarUrl === null ? {} : { avatarUrl: viewer.avatarUrl }),
                    active: viewer.active,
                    createdAt: viewer.createdAt,
                    updatedAt: viewer.updatedAt,
                  },
                };
              },
            },
          },
    account: {
      encryptOAuthTokens: true,
      // One person in two workspaces has one Factoree user with two Linear accounts.
      accountLinking: { enabled: true, trustedProviders: ["linear"] },
    },
    databaseHooks: {
      account: {
        create: {
          before: async (account) => {
            if (account.providerId === "linear") await refuse(() => admitLinearAccount(options.prisma, account.accountId));
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            await refuse(() => admitUser(options.prisma, session.userId));
          },
        },
      },
    },
    onAPIError: { errorURL: `${options.publicUrl}/sign-in` },
    plugins: [
      apiKey({
        defaultPrefix: API_KEY_PREFIX,
        rateLimit: { enabled: false },
        enableSessionForAPIKeys: false,
      }),
    ],
  });

export type FactoreeAuth = ReturnType<typeof createAuth>;

/**
 * DI-14.49. The sign-in configuration holds the Linear client credentials, so the handle builds
 * better-auth again when they change in the install settings. Every other call reads the same
 * instance.
 */
export class AuthHandle {
  private built: { fingerprint: string; auth: FactoreeAuth } | null = null;

  constructor(
    private readonly options: Omit<AuthOptions, "linear"> & { settings: InstallSettingsStore },
  ) {}

  async current(): Promise<FactoreeAuth> {
    const { linear } = await this.options.settings.read();
    const credentials =
      linear.clientId === null || linear.clientSecret === null
        ? null
        : { clientId: linear.clientId, clientSecret: linear.clientSecret };
    const fingerprint = createHash("sha256").update(JSON.stringify(credentials)).digest("hex");
    if (this.built?.fingerprint !== fingerprint) {
      this.built = { fingerprint, auth: createAuth({ ...this.options, linear: credentials }) };
    }
    return this.built.auth;
  }
}
