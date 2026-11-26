import type { TranscriptBucketSettings } from "~/domain/settings/install-settings.js";

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

type BucketEnv = {
  FACTOREE_TRANSCRIPT_S3_ENDPOINT?: string | undefined;
  FACTOREE_TRANSCRIPT_S3_BUCKET?: string | undefined;
  FACTOREE_TRANSCRIPT_S3_REGION?: string | undefined;
  FACTOREE_TRANSCRIPT_S3_ACCESS_KEY?: string | undefined;
  FACTOREE_TRANSCRIPT_S3_SECRET_KEY?: string | undefined;
};

/** The bucket fields that an env var sets, and so locks in the Settings page. */
export const lockedBucketFields = (env: BucketEnv): Array<keyof TranscriptBucketSettings> => {
  const locked: Array<keyof TranscriptBucketSettings> = [];
  if (env.FACTOREE_TRANSCRIPT_S3_ENDPOINT !== undefined) locked.push("endpoint");
  if (env.FACTOREE_TRANSCRIPT_S3_BUCKET !== undefined) locked.push("bucket");
  if (env.FACTOREE_TRANSCRIPT_S3_REGION !== undefined) locked.push("region");
  if (env.FACTOREE_TRANSCRIPT_S3_ACCESS_KEY !== undefined) locked.push("accessKey");
  if (env.FACTOREE_TRANSCRIPT_S3_SECRET_KEY !== undefined) locked.push("secretKey");
  return locked;
};

/** The effective bucket: each env var wins over its stored field. */
export const effectiveBucket = (stored: TranscriptBucketSettings, env: BucketEnv): TranscriptBucketSettings => ({
  endpoint: env.FACTOREE_TRANSCRIPT_S3_ENDPOINT ?? stored.endpoint,
  bucket: env.FACTOREE_TRANSCRIPT_S3_BUCKET ?? stored.bucket,
  region: env.FACTOREE_TRANSCRIPT_S3_REGION ?? stored.region,
  accessKey: env.FACTOREE_TRANSCRIPT_S3_ACCESS_KEY ?? stored.accessKey,
  secretKey: env.FACTOREE_TRANSCRIPT_S3_SECRET_KEY ?? stored.secretKey,
});

/** A bucket is set when its name, endpoint and both keys are set. The region defaults to us-east-1. */
export const completeBucket = (
  bucket: TranscriptBucketSettings,
): { endpoint: string; bucket: string; region: string; accessKey: string; secretKey: string } | null =>
  bucket.endpoint !== null && bucket.bucket !== null && bucket.accessKey !== null && bucket.secretKey !== null
    ? { endpoint: bucket.endpoint, bucket: bucket.bucket, region: bucket.region ?? "us-east-1", accessKey: bucket.accessKey, secretKey: bucket.secretKey }
    : null;

/** The object key of one transcript in the bucket. */
export const transcriptObjectKey = (tenantId: string, runId: string, id: string): string => `transcripts/${tenantId}/${runId}/${id}.txt.gz`;
