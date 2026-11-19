import type { FactoreePrismaClient } from "./client.js";
import type { DrainSettings, DrainState } from "~/domain/runs/drain-mode.js";

const INSTALL = "install";

/** docs/specs/drain-mode.md. Drain mode lives on the one InstallSettings row, so every replica reads it. */
export class PrismaDrainSettings implements DrainSettings {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async read(): Promise<DrainState | null> {
    const row = await this.prisma.installSettings.findUnique({
      where: { id: INSTALL },
      select: { drainStartedAt: true, drainStartedBy: true, drainRelease: true },
    });
    if (row?.drainStartedAt == null || row.drainRelease === null) return null;
    return { startedAt: row.drainStartedAt, startedBy: row.drainStartedBy, release: row.drainRelease };
  }

  async write(state: DrainState | null): Promise<void> {
    const data = {
      drainStartedAt: state?.startedAt ?? null,
      drainStartedBy: state?.startedBy ?? null,
      drainRelease: state?.release ?? null,
    };
    await this.prisma.installSettings.upsert({ where: { id: INSTALL }, update: data, create: { id: INSTALL, ...data } });
  }
}
