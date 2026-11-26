import { createHash } from "node:crypto";
import type { ObjectStoreSettings } from "~/domain/settings/install-settings.js";

/**
 * docs/specs/retro-agent.md, SDD section 61. A kept transcript: the runner's whole process output
 * plus every tool input, redacted before it leaves the runner. Only a product that turned "Keep
 * transcripts" on stores one.
 */
export interface KeptTranscript {
  tenantId: string;
  productId: string;
  runId: string;
  role: string;
  attempt: number;
  /** The redacted text. */
  text: string;
  idempotencyKey: string;
}

export interface TranscriptStore {
  keep(transcript: KeptTranscript): Promise<void>;
  /** The text of each kept transcript of one run, oldest first. */
  forRun(tenantId: string, runId: string): Promise<Array<{ role: string; attempt: number; text: string }>>;
}

/** Joins the process output and the tool inputs into one transcript text. */
export const transcriptTextOf = (output: string, toolInputs: readonly string[]): string =>
  [output.trim(), "", "## Tool inputs", "", ...toolInputs.map((input) => input.trim())].join("\n");

/**
 * docs/specs/s3-object-store.md. The object store env vars. `FACTOREE_S3_*` wins, and the
 * `FACTOREE_TRANSCRIPT_S3_*` names of 0.23 still work as aliases.
 */
type BucketEnv = {
  FACTOREE_S3_ENDPOINT?: string | undefined;
  FACTOREE_S3_BUCKET?: string | undefined;
  FACTOREE_S3_REGION?: string | undefined;
  FACTOREE_S3_ACCESS_KEY?: string | undefined;
  FACTOREE_S3_SECRET_KEY?: string | undefined;
  FACTOREE_TRANSCRIPT_S3_ENDPOINT?: string | undefined;
  FACTOREE_TRANSCRIPT_S3_BUCKET?: string | undefined;
  FACTOREE_TRANSCRIPT_S3_REGION?: string | undefined;
  FACTOREE_TRANSCRIPT_S3_ACCESS_KEY?: string | undefined;
  FACTOREE_TRANSCRIPT_S3_SECRET_KEY?: string | undefined;
};

/** The value each env var sets, the new name over its alias. */
const envFields = (env: BucketEnv): { [Field in keyof ObjectStoreSettings]: string | undefined } => ({
  endpoint: env.FACTOREE_S3_ENDPOINT ?? env.FACTOREE_TRANSCRIPT_S3_ENDPOINT,
  bucket: env.FACTOREE_S3_BUCKET ?? env.FACTOREE_TRANSCRIPT_S3_BUCKET,
  region: env.FACTOREE_S3_REGION ?? env.FACTOREE_TRANSCRIPT_S3_REGION,
  accessKey: env.FACTOREE_S3_ACCESS_KEY ?? env.FACTOREE_TRANSCRIPT_S3_ACCESS_KEY,
  secretKey: env.FACTOREE_S3_SECRET_KEY ?? env.FACTOREE_TRANSCRIPT_S3_SECRET_KEY,
});

/** The object store fields that an env var sets, and so locks in the Settings page. */
export const lockedBucketFields = (env: BucketEnv): Array<keyof ObjectStoreSettings> => {
  const fields = envFields(env);
  return (Object.keys(fields) as Array<keyof ObjectStoreSettings>).filter((field) => fields[field] !== undefined);
};

/** The effective object store: each env var wins over its stored field. */
export const effectiveBucket = (stored: ObjectStoreSettings, env: BucketEnv): ObjectStoreSettings => {
  const fields = envFields(env);
  return {
    endpoint: fields.endpoint ?? stored.endpoint,
    bucket: fields.bucket ?? stored.bucket,
    region: fields.region ?? stored.region,
    accessKey: fields.accessKey ?? stored.accessKey,
    secretKey: fields.secretKey ?? stored.secretKey,
  };
};

/** A bucket is set when its name, endpoint and both keys are set. The region defaults to us-east-1. */
export const completeBucket = (
  bucket: ObjectStoreSettings,
): { endpoint: string; bucket: string; region: string; accessKey: string; secretKey: string } | null =>
  bucket.endpoint !== null && bucket.bucket !== null && bucket.accessKey !== null && bucket.secretKey !== null
    ? { endpoint: bucket.endpoint, bucket: bucket.bucket, region: bucket.region ?? "us-east-1", accessKey: bucket.accessKey, secretKey: bucket.secretKey }
    : null;

/** The object key of one transcript in the bucket. */
export const transcriptObjectKey = (tenantId: string, runId: string, id: string): string => `transcripts/${tenantId}/${runId}/${id}.txt.gz`;

/**
 * docs/specs/s3-object-store.md. The fingerprint of the effective object store settings, secret
 * key included. Only its SHA-256 is stored: S3 is a valid evidence store while the settings match
 * the ones that passed the last test.
 */
export const objectStoreFingerprint = (bucket: ObjectStoreSettings): string =>
  createHash("sha256").update(JSON.stringify([bucket.endpoint, bucket.bucket, bucket.region ?? "us-east-1", bucket.accessKey, bucket.secretKey])).digest("hex");

/** True when the effective object store is complete and passed its test as it is now. */
export const objectStoreTested = (stored: ObjectStoreSettings, testedSha256: string | null, env: BucketEnv): boolean => {
  const bucket = effectiveBucket(stored, env);
  return completeBucket(bucket) !== null && testedSha256 === objectStoreFingerprint(bucket);
};
