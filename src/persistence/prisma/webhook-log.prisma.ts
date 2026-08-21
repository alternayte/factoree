import { Prisma } from "@prisma/client";
import type { FactoreePrismaClient } from "./client.js";
import type { WebhookLog } from "~/domain/runs/run-repository.js";

export class PrismaWebhookLog implements WebhookLog {
  constructor(private readonly prisma: FactoreePrismaClient) {}

  async recordIfNew(input: {
    tenantId: string | null;
    deliveryId: string;
    eventType: string;
  }): Promise<boolean> {
    try {
      await this.prisma.processedWebhook.create({
        data: { tenantId: input.tenantId, deliveryId: input.deliveryId, eventType: input.eventType },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
      throw error;
    }
  }

  async remove(deliveryId: string): Promise<void> {
    await this.prisma.processedWebhook.deleteMany({ where: { deliveryId } });
  }
}
