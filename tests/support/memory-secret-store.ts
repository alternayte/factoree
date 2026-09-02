import type {
  ProjectSecretDescriptor,
  ProjectSecretKind,
  PutSecretOptions,
  SecretStore,
} from "~/domain/projects/secret-store.js";
import { assertSecretKindAndMark } from "~/domain/projects/secret-store.js";

interface Entry {
  value: string;
  injectIntoImplementer: boolean;
  kind?: ProjectSecretKind;
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
        typeof value === "string" ? { value, injectIntoImplementer: false, kind: "test" } : value,
      );
    }
  }

  // The invalid-kind rejection arrives as a rejected promise, not as a synchronous throw.
  // `PrismaSecretStore.put` fails that way, and a test double must fail the same way.
  put(
    _tenantId: string,
    _projectId: string,
    name: string,
    value: string,
    options?: PutSecretOptions,
  ): Promise<void> {
    const injectIntoImplementer = options?.injectIntoImplementer ?? false;
    const kind = options?.kind ?? "test";
    try {
      assertSecretKindAndMark(kind, injectIntoImplementer);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.entries.set(name, { value, injectIntoImplementer, kind });
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
        kind: entry.kind ?? "test",
      })),
    );
  }

  remove(_tenantId: string, _projectId: string, name: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(name));
  }
}
