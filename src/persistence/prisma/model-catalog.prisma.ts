import type { Prisma } from "@prisma/client";
import type { FactoreePrismaClient } from "./client.js";
import { MODELS_DEV_URL, type ModelCatalogStore, type StoredCatalog } from "~/domain/products/model-catalog-service.js";
import type { RawCatalog } from "~/domain/products/model-catalog.js";

/** docs/specs/model-picker.md. One row holds the last good copy of the models.dev catalog. */
export class PrismaModelCatalogStore implements ModelCatalogStore {
  constructor(
    private readonly prisma: FactoreePrismaClient,
    private readonly source: string = MODELS_DEV_URL,
  ) {}

  async read(): Promise<StoredCatalog | null> {
    const row = await this.prisma.modelCatalog.findUnique({ where: { source: this.source } });
    return row === null ? null : { etag: row.etag, data: row.data as RawCatalog, fetchedAt: row.fetchedAt };
  }

  async write(catalog: StoredCatalog): Promise<void> {
    const data = catalog.data as unknown as Prisma.InputJsonValue;
    await this.prisma.modelCatalog.upsert({
      where: { source: this.source },
      create: { source: this.source, etag: catalog.etag, data, fetchedAt: catalog.fetchedAt },
      update: { etag: catalog.etag, data, fetchedAt: catalog.fetchedAt },
    });
  }

  async touch(fetchedAt: Date): Promise<void> {
    await this.prisma.modelCatalog.updateMany({ where: { source: this.source }, data: { fetchedAt } });
  }
}
