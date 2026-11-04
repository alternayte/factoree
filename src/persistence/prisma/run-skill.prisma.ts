import type { PrismaClient } from "@prisma/client";
import type { DeliveredSkill } from "~/domain/runs/sandbox-manager.js";
import type { RunSkill, RunSkillProposal, RunSkillResolution, RunSkillStore } from "~/domain/runs/run-skill.js";
import type { SkillScope } from "~/domain/runs/skill-discovery.js";
import type { SkillSourceScope } from "~/domain/runs/skill-registry.js";

/** docs/specs/skill-registry.md. The `run_skill` and `run_skill_proposal` tables. */
export class PrismaRunSkillStore implements RunSkillStore {
  constructor(private readonly prisma: PrismaClient) {}

  async replace(
    tenantId: string,
    runId: string,
    skills: DeliveredSkill[],
    resolution: RunSkillResolution | null,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.runSkill.deleteMany({ where: { tenantId, runId } }),
      this.prisma.runSkill.createMany({
        data: skills.map((skill) => ({
          tenantId,
          runId,
          source: skill.scope,
          name: skill.name,
          path: skill.path,
          version: skill.version,
          sha256: skill.sha256,
          listed: skill.listed,
        })),
      }),
      this.prisma.run.updateMany({
        where: { tenantId, id: runId },
        data: { skillRegistrySet: resolution?.set ?? null, skillResolutionId: resolution?.id ?? null },
      }),
    ]);
  }

  async list(tenantId: string, runId: string): Promise<RunSkill[]> {
    const rows = await this.prisma.runSkill.findMany({ where: { tenantId, runId }, orderBy: [{ name: "asc" }, { path: "asc" }] });
    // This store is the only writer of the table, and it writes only the declared scopes.
    return rows.map((row) => ({
      scope: row.source as SkillScope,
      name: row.name,
      path: row.path,
      version: row.version,
      sha256: row.sha256,
      listed: row.listed,
      activated: row.activated,
    }));
  }

  async resolutionOf(tenantId: string, runId: string): Promise<RunSkillResolution | null> {
    const run = await this.prisma.run.findFirst({
      where: { tenantId, id: runId },
      select: { skillRegistrySet: true, skillResolutionId: true },
    });
    if (run === null || run.skillResolutionId === null) return null;
    return { set: run.skillRegistrySet, id: run.skillResolutionId };
  }

  async markActivated(tenantId: string, runId: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.prisma.runSkill.updateMany({ where: { tenantId, runId, path: { in: paths } }, data: { activated: true } });
  }

  async recordProposal(tenantId: string, runId: string, proposal: RunSkillProposal): Promise<void> {
    const data = { state: proposal.state, reference: proposal.reference, url: proposal.url, reason: proposal.reason };
    await this.prisma.runSkillProposal.upsert({
      where: { runId_name_source: { runId, name: proposal.name, source: proposal.source } },
      create: { tenantId, runId, name: proposal.name, source: proposal.source, ...data },
      update: data,
    });
  }

  async listProposals(tenantId: string, runId: string): Promise<RunSkillProposal[]> {
    const rows = await this.prisma.runSkillProposal.findMany({ where: { tenantId, runId }, orderBy: { createdAt: "asc" } });
    return rows.map((row) => ({
      name: row.name,
      source: row.source as SkillSourceScope,
      state: row.state as RunSkillProposal["state"],
      reference: row.reference,
      url: row.url,
      reason: row.reason,
    }));
  }
}
