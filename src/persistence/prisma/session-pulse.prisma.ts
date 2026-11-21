import type { PrismaClient } from "@prisma/client";
import type { SessionPulse, SessionPulseRecorder } from "~/domain/runs/session-pulse.js";

const SETUP_OWNER = "setup:";

/**
 * docs/specs/factory-floor.md. The `session_pulse` table. A setup session runs under the run id
 * `setup:<setupId>`, so the owner names the setup there and the run everywhere else.
 */
export class PrismaSessionPulseStore implements SessionPulseRecorder {
  constructor(private readonly prisma: PrismaClient) {}

  async record(pulse: SessionPulse): Promise<void> {
    const setup = pulse.owner.startsWith(SETUP_OWNER);
    await this.prisma.sessionPulse.create({
      data: {
        tenantId: pulse.tenantId,
        runId: setup ? null : pulse.owner,
        setupId: setup ? pulse.owner.slice(SETUP_OWNER.length) : null,
        role: pulse.role,
        toolKind: pulse.toolKind,
        lastOutputAt: pulse.lastOutputAt,
        createdAt: pulse.at,
      },
    });
  }
}
