import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

export type FactoreePrismaClient = PrismaClient;

export const createPrismaClient = (databaseUrl: string): FactoreePrismaClient =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
