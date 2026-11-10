import { randomBytes } from "node:crypto";
import { SANDBOX_PROVIDERS, type SandboxProvider } from "./install-settings.js";

/**
 * docs/specs/sandbox-provider-spillover.md. One sandbox provider of the install: a Kiln host, an
 * E2B account, a Sprites account or the local adapter, with its own live sandbox limit, size and
 * priority. The id is stable. Leases, warm snapshots, runs and `SandboxRef.adapter` hold it.
 */
export interface SandboxProviderSettings {
  id: string;
  name: string;
  type: SandboxProvider;
  /**
   * The Kiln host, the Sprites API base URL, or the URL of a self-hosted E2B, whose host name is the
   * E2B domain. Null means the type default.
   */
  url: string | null;
  apiKey: string | null;
  /** The limit of live sandboxes on this provider. Null means no limit. */
  maxLive: number | null;
  /** docs/specs/kiln-sandbox-size.md. Null means the default size. */
  vcpus: number | null;
  memoryMb: number | null;
  /** A lower number is a better priority. */
  priority: number;
  enabled: boolean;
  /** Set after a work sprite create failed. Selection skips the provider until then. */
  downUntil: Date | null;
  downReason: string | null;
}

export type SandboxProviderInput = Omit<SandboxProviderSettings, "id" | "downUntil" | "downReason">;

/** A change to one provider. An absent field keeps its value, and null clears it. */
export type SandboxProviderPatch = { [Field in keyof SandboxProviderInput]?: SandboxProviderInput[Field] | undefined };

export interface SandboxProviderStore {
  /** Every provider, by priority, then by name. */
  list(): Promise<SandboxProviderSettings[]>;
  find(id: string): Promise<SandboxProviderSettings | null>;
  create(input: SandboxProviderInput): Promise<SandboxProviderSettings>;
  update(id: string, patch: SandboxProviderPatch): Promise<SandboxProviderSettings | null>;
  /** Refuses with `SandboxProviderInUseError` while the provider holds a live lease. */
  delete(id: string): Promise<boolean>;
  /** The live leases of each provider, held slots included. */
  liveCounts(): Promise<Record<string, number>>;
  markDown(id: string, until: Date, reason: string): Promise<void>;
}

export class SandboxProviderInUseError extends Error {
  constructor(readonly providerId: string, readonly live: number) {
    super(`the sandbox provider ${providerId} still holds ${live} live sandboxes; disable it and wait until its runs end`);
    this.name = "SandboxProviderInUseError";
  }
}

/** How long selection skips a provider after a work sprite create failed there. */
export const PROVIDER_DOWN_MS = 5 * 60_000;

export const PROVIDER_TYPE_LABELS: Record<SandboxProvider, string> = {
  kiln: "Kiln",
  e2b: "E2B",
  "fly-sprites": "Fly Sprites",
  local: "Local",
};

export const isSandboxProviderType = (value: string): value is SandboxProvider =>
  (SANDBOX_PROVIDERS as readonly string[]).includes(value);

/**
 * The id of a new provider. The first provider of a type takes the type name, the id an install
 * from before the provider list already uses. Another one gets a suffix.
 */
export const newSandboxProviderId = (type: SandboxProvider, taken: readonly string[]): string => {
  if (!taken.includes(type)) return type;
  for (;;) {
    const id = `${type}-${randomBytes(3).toString("hex")}`;
    if (!taken.includes(id)) return id;
  }
};

/** True while selection must skip the provider after a failed create. */
export const isProviderDown = (provider: Pick<SandboxProviderSettings, "downUntil">, now: Date): boolean =>
  provider.downUntil !== null && provider.downUntil.getTime() > now.getTime();
