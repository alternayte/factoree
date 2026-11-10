import type { SandboxProvider as SandboxProviderRow } from "@prisma/client";
import type { FactoreePrismaClient } from "./client.js";
import { decryptSecret, encryptSecret } from "~/domain/policy/crypto.js";
import {
  isSandboxProviderType,
  newSandboxProviderId,
  SandboxProviderInUseError,
  type SandboxProviderInput,
  type SandboxProviderPatch,
  type SandboxProviderSettings,
  type SandboxProviderStore,
} from "~/domain/settings/sandbox-providers.js";

/**
 * docs/specs/sandbox-provider-spillover.md. The sandbox providers of the install. The API key is
 * AES-256-GCM cipher text under the master key, and plain text only in memory.
 */
export class PrismaSandboxProviderStore implements SandboxProviderStore {
  constructor(
    private readonly prisma: FactoreePrismaClient,
    private readonly masterKey: string,
    /** Receives every key this store decrypts, for the log redactor (SDD section 60). */
    private readonly onCredential: (value: string) => void = () => undefined,
  ) {}

  private toSettings(row: SandboxProviderRow): SandboxProviderSettings | null {
    // A type this release does not know serves no sandbox.
    if (!isSandboxProviderType(row.type)) return null;
    let apiKey: string | null = null;
    if (row.apiKeyCipher !== null) {
      apiKey = decryptSecret(row.apiKeyCipher, this.masterKey);
      this.onCredential(apiKey);
    }
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      url: row.url,
      apiKey,
      maxLive: row.maxLive,
      vcpus: row.vcpus,
      memoryMb: row.memoryMb,
      priority: row.priority,
      enabled: row.enabled,
      downUntil: row.downUntil,
      downReason: row.downReason,
    };
  }

  async list(): Promise<SandboxProviderSettings[]> {
    const rows = await this.prisma.sandboxProvider.findMany({ orderBy: [{ priority: "asc" }, { name: "asc" }, { id: "asc" }] });
    return rows.map((row) => this.toSettings(row)).filter((entry): entry is SandboxProviderSettings => entry !== null);
  }

  async find(id: string): Promise<SandboxProviderSettings | null> {
    const row = await this.prisma.sandboxProvider.findUnique({ where: { id } });
    return row === null ? null : this.toSettings(row);
  }

  async create(input: SandboxProviderInput): Promise<SandboxProviderSettings> {
    const taken = (await this.prisma.sandboxProvider.findMany({ select: { id: true } })).map((row) => row.id);
    const row = await this.prisma.sandboxProvider.create({
      data: {
        id: newSandboxProviderId(input.type, taken),
        name: input.name,
        type: input.type,
        url: input.url,
        apiKeyCipher: input.apiKey === null ? null : encryptSecret(input.apiKey, this.masterKey),
        maxLive: input.maxLive,
        vcpus: input.vcpus,
        memoryMb: input.memoryMb,
        priority: input.priority,
        enabled: input.enabled,
      },
    });
    return this.toSettings(row) as SandboxProviderSettings;
  }

  async update(id: string, patch: SandboxProviderPatch): Promise<SandboxProviderSettings | null> {
    const data = {
      name: patch.name,
      type: patch.type,
      url: patch.url,
      apiKeyCipher:
        patch.apiKey === undefined ? undefined : patch.apiKey === null ? null : encryptSecret(patch.apiKey, this.masterKey),
      maxLive: patch.maxLive,
      vcpus: patch.vcpus,
      memoryMb: patch.memoryMb,
      priority: patch.priority,
      enabled: patch.enabled,
    };
    const defined = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
    const updated = await this.prisma.sandboxProvider.updateMany({ where: { id }, data: defined });
    return updated.count === 0 ? null : await this.find(id);
  }

  async delete(id: string): Promise<boolean> {
    return await this.prisma.$transaction(async (tx) => {
      // The lease lock of the provider keeps a create from starting while the row goes.
      const lockKey = `factoree:sandbox-lease:${id}`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS "locked"`;
      const live = await tx.sandboxLease.count({ where: { adapter: id } });
      if (live > 0) throw new SandboxProviderInUseError(id, live);
      const deleted = await tx.sandboxProvider.deleteMany({ where: { id } });
      return deleted.count > 0;
    });
  }

  async liveCounts(): Promise<Record<string, number>> {
    const rows = await this.prisma.sandboxLease.groupBy({ by: ["adapter"], _count: { _all: true } });
    return Object.fromEntries(rows.map((row) => [row.adapter, row._count._all]));
  }

  async markDown(id: string, until: Date, reason: string): Promise<void> {
    await this.prisma.sandboxProvider.updateMany({ where: { id }, data: { downUntil: until, downReason: reason.slice(0, 500) } });
  }
}
