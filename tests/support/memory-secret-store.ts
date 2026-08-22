import type { ProjectSecretDescriptor, PutSecretOptions, SecretStore } from "~/domain/projects/secret-store.js";

interface Entry {
  value: string;
  injectIntoImplementer: boolean;
}

/**
 * An in-memory `SecretStore` for a unit test. It holds one Project only, because a unit test
 * never needs a second one. It keeps the injection mark of SDD section 30.
 */
export class MemorySecretStore implements SecretStore {
  private readonly entries = new Map<string, Entry>();

  constructor(values: Record<string, string | Entry> = {}) {
    for (const [name, value] of Object.entries(values)) {
      this.entries.set(
        name,
        typeof value === "string" ? { value, injectIntoImplementer: false } : value,
      );
    }
  }

  put(
    _tenantId: string,
    _projectId: string,
    name: string,
    value: string,
    options?: PutSecretOptions,
  ): Promise<void> {
    this.entries.set(name, { value, injectIntoImplementer: options?.injectIntoImplementer ?? false });
    return Promise.resolve();
  }

  get(_tenantId: string, _projectId: string, name: string): Promise<string | null> {
    return Promise.resolve(this.entries.get(name)?.value ?? null);
  }

  listNames(): Promise<string[]> {
    return Promise.resolve([...this.entries.keys()]);
  }

  list(): Promise<ProjectSecretDescriptor[]> {
    return Promise.resolve(
      [...this.entries.entries()].map(([name, entry]) => ({
        name,
        injectIntoImplementer: entry.injectIntoImplementer,
      })),
    );
  }

  remove(_tenantId: string, _projectId: string, name: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(name));
  }
}
