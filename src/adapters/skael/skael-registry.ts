import {
  resolutionIdOf,
  sha256Hex,
  SkillRegistryError,
  type ResolvedSkill,
  type SkillActivationReport,
  type SkillDelivery,
  type SkillOutcomeReport,
  type SkillProposal,
  type SkillProposalReceipt,
  type SkillRegistry,
  type SkillResolution,
} from "~/domain/runs/skill-registry.js";
import { readTarGz, unsafeEntryOf, writeTarGz } from "./tar.js";

/** One Skael call must not hang a run. A bundle can be large, so a read gets longer. */
const CALL_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** The bundle layout of Skael `internal/sets/bundle.go`. */
const BUNDLE_MANIFEST = ".agents/skills/manifest.json";

export interface SkaelRegistryOptions {
  /** The base URL of the Skael server, for example `https://skael.example.com`. */
  url: string;
  /** The service key. It stays on the worker. */
  key: string;
  /** The set name, or null for every released skill. */
  set: string | null;
  fetch?: typeof fetch;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const SHA256 = /^[0-9a-f]{64}$/;

/** A skill name Skael accepts, and one path segment in the sandbox. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface ManifestEntry {
  name: string;
  version: number;
  sha256: string;
}

const manifestEntryOf = (value: unknown, digestField: "sha256" | "checksum"): ManifestEntry => {
  if (!isRecord(value)) throw new SkillRegistryError("Skael returned a manifest entry that is not an object", true);
  const name = value["name"];
  const version = value["version"];
  const digest = value[digestField];
  if (typeof name !== "string" || !SKILL_NAME.test(name)) {
    throw new SkillRegistryError(`Skael returned an unusable skill name: ${JSON.stringify(name)}`, true);
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new SkillRegistryError(`Skael returned an unusable version for the skill "${name}"`, true);
  }
  if (typeof digest !== "string" || !SHA256.test(digest)) {
    throw new SkillRegistryError(`Skael returned an unusable digest for the skill "${name}"`, true);
  }
  return { name, version, sha256: digest };
};

/**
 * docs/specs/skill-registry.md. The Skael adapter. It resolves a set through the bundle, or every
 * released skill through the sync manifest until skael-dev/skael#30 gives that a set. It checks
 * every archive against its digest before a byte reaches a sandbox.
 */
export class SkaelRegistry implements SkillRegistry {
  readonly scope = "registry" as const;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SkaelRegistryOptions) {
    this.base = options.url.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async resolve(): Promise<SkillDelivery> {
    const resolution = this.options.set === null ? await this.resolveAll() : await this.resolveSet(this.options.set);
    return { kind: "archives", resolution };
  }

  /**
   * docs/specs/skill-registry.md. The save-time check. It resolves a named set, or reads the sync
   * manifest, and counts the skills. A set-limited key fails the manifest read with 403.
   */
  async check(): Promise<{ skills: number }> {
    if (this.options.set === null) {
      const body: unknown = await (await this.call("GET", "/api/sync/manifest")).json().catch(() => null);
      if (!Array.isArray(body)) throw new SkillRegistryError("the Skael sync manifest is not a list", true);
      return { skills: body.length };
    }
    const body: unknown = await (
      await this.call("GET", `/api/sets/${encodeURIComponent(this.options.set)}/resolve`)
    ).json().catch(() => null);
    if (!isRecord(body) || !Array.isArray(body["entries"])) {
      throw new SkillRegistryError(`Skael returned no entries for the set "${this.options.set}"`, true);
    }
    return { skills: body["entries"].length };
  }

  /** A named set: one bundle, whose manifest names each archive and its digest. */
  private async resolveSet(set: string): Promise<SkillResolution> {
    const response = await this.call("GET", `/api/sets/${encodeURIComponent(set)}/bundle`, undefined, DOWNLOAD_TIMEOUT_MS);
    const bundle = new Uint8Array(await response.arrayBuffer());
    const headerId = response.headers.get("x-skael-resolution");
    const complete = response.headers.get("x-skael-complete") !== "false";
    let entries;
    try {
      entries = readTarGz(bundle);
    } catch (error) {
      throw new SkillRegistryError(`the Skael bundle of the set "${set}" is not a readable archive: ${String(error)}`, true);
    }
    const files = new Map(entries.filter((entry) => entry.type === "file").map((entry) => [entry.name, entry.data]));
    const manifestBytes = files.get(BUNDLE_MANIFEST);
    if (manifestBytes === undefined) {
      throw new SkillRegistryError(`the Skael bundle of the set "${set}" holds no ${BUNDLE_MANIFEST}`, true);
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
    } catch {
      throw new SkillRegistryError(`the manifest of the Skael set "${set}" is not JSON`, true);
    }
    if (!isRecord(manifest) || !Array.isArray(manifest["skills"])) {
      throw new SkillRegistryError(`the manifest of the Skael set "${set}" lists no skills`, true);
    }
    const skills: ResolvedSkill[] = [];
    for (const raw of manifest["skills"] as unknown[]) {
      const entry = manifestEntryOf(raw, "sha256");
      const path = isRecord(raw) && typeof raw["archive"] === "string" ? raw["archive"] : "";
      const archive = files.get(path);
      if (archive === undefined) {
        throw new SkillRegistryError(`the Skael bundle of the set "${set}" holds no archive for the skill "${entry.name}"`, true);
      }
      skills.push(this.checked(entry, archive));
    }
    const id = resolutionIdOf(skills);
    const named = typeof manifest["resolution_id"] === "string" ? manifest["resolution_id"] : headerId;
    if (named !== null && named !== id) {
      throw new SkillRegistryError(
        `the Skael set "${set}" names the resolution ${named}, and its archives give ${id}`,
        true,
      );
    }
    return { set, id, complete, skills: skills.sort((left, right) => left.name.localeCompare(right.name)) };
  }

  /**
   * Every released skill. skael-dev/skael#30 asks for a set that does this. Until it ships, the sync
   * manifest names the released version of each skill, and Factoree computes the resolution id.
   */
  private async resolveAll(): Promise<SkillResolution> {
    const response = await this.call("GET", "/api/sync/manifest");
    const body: unknown = await response.json().catch(() => null);
    if (!Array.isArray(body)) throw new SkillRegistryError("the Skael sync manifest is not a list", true);
    const skills: ResolvedSkill[] = [];
    for (const raw of body as unknown[]) {
      const entry = manifestEntryOf(raw, "checksum");
      const download = await this.call(
        "GET",
        `/api/skills/${encodeURIComponent(entry.name)}/versions/${entry.version}/download`,
        undefined,
        DOWNLOAD_TIMEOUT_MS,
      );
      skills.push(this.checked(entry, new Uint8Array(await download.arrayBuffer())));
    }
    skills.sort((left, right) => left.name.localeCompare(right.name));
    return { set: null, id: resolutionIdOf(skills), complete: true, skills };
  }

  /** The digest check of the spec, and the entry check that keeps an archive inside its directory. */
  private checked(entry: ManifestEntry, archive: Uint8Array): ResolvedSkill {
    const actual = sha256Hex(archive);
    if (actual !== entry.sha256) {
      throw new SkillRegistryError(
        `the archive of the skill "${entry.name}" version ${entry.version} has the SHA-256 ${actual}, ` +
          `and Skael names ${entry.sha256}`,
        true,
      );
    }
    let unsafe: string | null;
    try {
      unsafe = unsafeEntryOf(readTarGz(archive));
    } catch (error) {
      unsafe = `the archive is not readable: ${String(error)}`;
    }
    if (unsafe !== null) {
      throw new SkillRegistryError(`the archive of the skill "${entry.name}" is refused: ${unsafe}`, true);
    }
    return { ...entry, archive };
  }

  async reportActivations(report: SkillActivationReport): Promise<void> {
    if (report.skills.length === 0) return;
    await this.call(
      "POST",
      "/api/events/batch",
      {
        events: report.skills.map((skill) => ({
          skill: skill.name,
          version: skill.version,
          agent: report.runner,
          role: report.role,
          external_run_id: report.runId,
          time: report.time.toISOString(),
          ...(report.set === null ? {} : { set: report.set }),
          ...(report.resolutionId === null ? {} : { resolution_id: report.resolutionId }),
        })),
      },
      CALL_TIMEOUT_MS,
      { "idempotency-key": report.idempotencyKey },
    );
  }

  async reportOutcome(report: SkillOutcomeReport): Promise<void> {
    await this.call("POST", "/api/outcomes", {
      external_run_id: report.runId,
      outcome: report.outcome,
      repairs: report.repairs,
      ...(report.reviewVerdict === null ? {} : { review_verdict: report.reviewVerdict }),
      ...(report.evidenceUrl === null ? {} : { evidence_url: report.evidenceUrl }),
      ...(report.set === null ? {} : { set: report.set }),
      ...(report.resolutionId === null ? {} : { resolution_id: report.resolutionId }),
    });
  }

  async submit(proposal: SkillProposal): Promise<SkillProposalReceipt> {
    const archive = writeTarGz(proposal.files);
    let response: Response;
    try {
      response = await this.call("POST", "/api/submissions", {
        name: proposal.name,
        rationale: proposal.rationale,
        external_run_id: proposal.runId,
        ...(proposal.runLink === null ? {} : { run_link: proposal.runLink }),
        archive_base64: Buffer.from(archive).toString("base64"),
      });
    } catch (error) {
      // A 422 is the scan refusing the proposal: a secret or an exfiltration finding. That is an
      // answer, and the proof pack states it.
      if (error instanceof SkaelHttpError && (error.status === 422 || error.status === 400)) {
        return { state: "refused", reason: error.detail };
      }
      throw error;
    }
    const body: unknown = await response.json().catch(() => null);
    const id = isRecord(body) && typeof body["id"] === "string" ? body["id"] : null;
    if (id === null) throw new SkillRegistryError("Skael accepted the submission and returned no id", false);
    return { state: "submitted", reference: id, url: `${this.base}/review` };
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = CALL_TIMEOUT_MS,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.options.key}`,
          "user-agent": "factoree",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new SkillRegistryError(`Skael did not answer ${method} ${path}: ${String(error)}`, false);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text.slice(0, 500);
      try {
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed) && typeof parsed["detail"] === "string") detail = parsed["detail"];
      } catch {
        // The body is not JSON, so its first characters name the fault.
      }
      throw new SkaelHttpError(method, path, response.status, detail);
    }
    return response;
  }
}

/** A Skael answer with a fault status. A 4xx other than 408 and 429 repeats on a retry. */
export class SkaelHttpError extends SkillRegistryError {
  constructor(
    method: string,
    path: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(
      `Skael answered ${status} for ${method} ${path}${detail === "" ? "" : `: ${detail}`}`,
      status >= 400 && status < 500 && status !== 408 && status !== 429,
    );
    this.name = "SkaelHttpError";
  }
}
