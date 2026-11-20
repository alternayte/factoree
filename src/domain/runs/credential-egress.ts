import { RunConfigurationError } from "./run-configuration-error.js";
import type { Sandbox, SandboxRef } from "./sandbox.js";
import type { HostCredentialAccess } from "~/domain/products/host-credentials.js";

/**
 * docs/specs/host-credentials.md. The sandboxes that hold a `github` binding, whose token expires
 * after 1 hour. The worker binds a new token on each, with the egress list the sandbox applied last,
 * because an E2B update replaces the whole network configuration.
 */
export interface CredentialBindingRecord {
  adapter: string;
  sandboxId: string;
  tenantId: string;
  productId: string;
  hosts: string[];
  /** The repositories the sandbox checked out, which its `github` token reads too. */
  repositories: string[];
}

export interface CredentialBindingStore {
  /** Records the binding of a live sandbox, or clears it with null. A sandbox with no lease records nothing. */
  record(adapter: string, sandboxId: string, binding: Omit<CredentialBindingRecord, "adapter" | "sandboxId"> | null): Promise<void>;
  /** The sandboxes whose binding is older than `boundBefore`, oldest first. */
  due(boundBefore: Date, limit: number): Promise<CredentialBindingRecord[]>;
}

/** The credentials of the product a sandbox serves, and where a refreshing binding is recorded. */
export interface CredentialEgress {
  tenantId: string;
  productId: string;
  access: HostCredentialAccess;
  store?: CredentialBindingStore | undefined;
  /** The repositories the sandbox checks out. A rebind mints its token for them too. */
  repositories?: readonly string[];
}

/**
 * Applies one egress phase. The credential hosts join the phase's list, outside the product allow
 * list, so every phase reaches them, and the provider binds each credential again: Kiln restores a
 * snapshot with no binding, and E2B clears every rule an update leaves out.
 */
export const applyEgress = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  allowedDomains: readonly string[],
  egress: CredentialEgress | null,
): Promise<string[]> => {
  const access = egress?.access;
  const hosts = [...new Set([...allowedDomains, ...(access?.hosts ?? [])])].sort();
  if (access === undefined || access.bindings.length === 0) {
    await sandbox.applyNetworkPolicy(ref, { allowedDomains: hosts });
  } else {
    await sandbox.applyNetworkPolicy(ref, { allowedDomains: hosts, credentials: access.bindings });
  }
  if (egress?.store !== undefined) {
    await egress.store.record(
      ref.adapter,
      ref.id,
      access?.refreshes === true
        ? { tenantId: egress.tenantId, productId: egress.productId, hosts, repositories: [...(egress.repositories ?? [])] }
        : null,
    );
  }
  return hosts;
};

/** The `owner/name` of each github.com checkout. Another host or a local path names none. */
export const githubRepositoriesOf = (urls: readonly string[]): string[] => {
  const names = new Set<string>();
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname.toLowerCase() !== "github.com") continue;
      const parts = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
      if (parts.length === 2 && parts[0] !== "" && parts[1] !== "") names.add(`${parts[0]}/${parts[1]}`);
    } catch {
      continue;
    }
  }
  return [...names].sort();
};

/** A product with host credentials needs a provider that binds them. A silent restore failure costs a whole run. */
export const assertBindable = (sandbox: Sandbox, access: HostCredentialAccess): void => {
  if (access.bindings.length === 0 || sandbox.capabilities.bindsCredentials) return;
  throw new RunConfigurationError(
    `The product has host credentials, and the sandbox provider ${sandbox.name} cannot bind them. ` +
      "Run the product on Kiln or E2B, or remove its host credentials.",
  );
};

// curl: 6 could not resolve the host, 7 could not connect, 28 timed out. Any other answer, a TLS
// fault or an HTTP status included, means the host is reachable.
const UNREACHABLE = new Set([6, 7, 28]);

/**
 * docs/specs/private-stack-onboarding.md. What to do about a host that a sandbox cannot reach: a
 * sandbox reaches public-internet hosts only, so the fix is a registry it can reach.
 */
export const PUBLIC_HOSTS_ONLY =
  "Sandboxes reach public-internet hosts only: a host that does not resolve publicly, or that resolves to a private, loopback or link-local address, is refused. " +
  "Use a registry the sandbox can reach, with a host credential: GitHub Packages of your organization, a cloud feed such as Azure Artifacts or JFrog Cloud, or a proxy that faces the internet.";

/**
 * Each host must resolve and connect from inside the sandbox. A feed on a private network is
 * unreachable, and a restore error deep in a bootstrap log names neither the host nor the provider.
 */
export const probeHosts = async (sandbox: Sandbox, ref: SandboxRef, hosts: readonly string[], label: string): Promise<void> => {
  for (const host of hosts) {
    const result = await sandbox.exec(ref, {
      file: "curl",
      args: ["-sS", "-o", "/dev/null", "--connect-timeout", "10", "--max-time", "20", `https://${host}/`],
      cwd: "/",
      timeoutMs: 30_000,
    });
    if (result.timedOut || UNREACHABLE.has(result.exitCode)) {
      throw new RunConfigurationError(`The ${label} ${host} does not resolve or connect from the sandbox provider ${sandbox.name}. ${PUBLIC_HOSTS_ONLY}`);
    }
  }
};

/** At preparation, each credential host must resolve and connect from inside the sandbox. */
export const probeCredentialHosts = (sandbox: Sandbox, ref: SandboxRef, access: HostCredentialAccess): Promise<void> =>
  probeHosts(sandbox, ref, access.credentials.map((credential) => credential.host), "host credential host");
