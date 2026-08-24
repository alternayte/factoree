import type { PrismaClient } from "@prisma/client";
import type { Logger } from "~/telemetry/logger.js";
import type {
  SaveValidationContractInput,
  StoredValidationContract,
  ValidationContractStore,
} from "~/domain/validation/validation-contract-store.js";
import type {
  ValidationAssertion,
  ValidationEvidenceKind,
  ValidationMethod,
} from "~/domain/validation/validation-contract.js";
import {
  isValidationEvidenceKind,
  isValidationMethod,
} from "~/domain/validation/validation-contract.js";

/** The store throws this error when a column holds a value no domain list allows. */
export class ValidationContractRowInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationContractRowInvalidError";
  }
}

const toMethod = (value: string, key: string): ValidationMethod => {
  if (!isValidationMethod(value)) {
    throw new ValidationContractRowInvalidError(
      `Validation assertion "${key}" holds the unknown method "${value}".`,
    );
  }
  return value;
};

const toEvidence = (values: string[], key: string): ValidationEvidenceKind[] =>
  values.map((value) => {
    if (!isValidationEvidenceKind(value)) {
      throw new ValidationContractRowInvalidError(
        `Validation assertion "${key}" holds the unknown evidence kind "${value}".`,
      );
    }
    return value;
  });

interface AssertionRow {
  assertionKey: string;
  requirement: string;
  statement: string;
  method: string;
  evidence: string[];
  preconditions: string[];
}

interface ContractRow {
  id: string;
  tenantId: string;
  runId: string;
  version: number;
  sha256: string;
  workItem: string;
  goal: string;
  document: string;
  createdAt: Date;
  assertions: AssertionRow[];
}

const toAssertion = (row: AssertionRow): ValidationAssertion => ({
  id: row.assertionKey,
  requirement: row.requirement,
  statement: row.statement,
  method: toMethod(row.method, row.assertionKey),
  evidence: toEvidence(row.evidence, row.assertionKey),
  preconditions: row.preconditions,
});

const toStored = (row: ContractRow): StoredValidationContract => ({
  id: row.id,
  tenantId: row.tenantId,
  runId: row.runId,
  version: row.version,
  sha256: row.sha256,
  workItem: row.workItem,
  goal: row.goal,
  document: row.document,
  assertions: row.assertions.map(toAssertion),
  createdAt: row.createdAt,
});

export class PrismaValidationContractStore implements ValidationContractStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger?: Logger,
  ) {}

  /**
   * SDD section 25. The contract is immutable, so an existing contract wins and the store writes
   * nothing. A Temporal activity retry therefore cannot produce a second version. Prisma writes
   * the contract and every assertion in one nested create, which runs in one transaction.
   */
  async save(input: SaveValidationContractInput): Promise<StoredValidationContract> {
    const existing = await this.findByRun(input.tenantId, input.runId);
    if (existing !== null) {
      if (existing.sha256 !== input.sha256) {
        // SDD section 25 forbids a change to the active contract, so the stored contract stands.
        // The message names only the hashes and the Run, never the contract document, because SDD
        // section 60 forbids logging contract text.
        this.logger?.warn(
          "a divergent freeze attempt did not change the active Validation Contract",
          {
            run_id: input.runId,
            stored_sha256: existing.sha256,
            rejected_sha256: input.sha256,
          },
        );
      }
      return existing;
    }

    try {
      const row = await this.prisma.validationContract.create({
        data: {
          tenantId: input.tenantId,
          runId: input.runId,
          version: input.contract.version,
          sha256: input.sha256,
          workItem: input.contract.workItem,
          goal: input.contract.goal,
          document: input.document,
          assertions: {
            create: input.contract.assertions.map((assertion) => ({
              tenantId: input.tenantId,
              assertionKey: assertion.id,
              requirement: assertion.requirement,
              statement: assertion.statement,
              method: assertion.method,
              evidence: assertion.evidence,
              preconditions: assertion.preconditions,
            })),
          },
        },
        include: { assertions: true },
      });
      return toStored(row);
    } catch (error) {
      // Two concurrent attempts can both miss the read above. The unique index on `runId` decides
      // the race. The loser reads the contract the winner wrote, and does not fail the Run.
      const row = await this.findByRun(input.tenantId, input.runId);
      if (row !== null) return row;
      throw error;
    }
  }

  async findByRun(tenantId: string, runId: string): Promise<StoredValidationContract | null> {
    const row = await this.prisma.validationContract.findUnique({
      where: { runId },
      include: { assertions: true },
    });
    // SDD section 52. The read applies the tenant boundary as well as the write.
    if (row === null || row.tenantId !== tenantId) return null;
    return toStored(row);
  }
}
