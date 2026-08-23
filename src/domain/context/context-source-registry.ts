import type { ContextSource } from "./context-source.js";

export class UnknownContextSourceError extends Error {
  constructor(id: string, known: string[]) {
    super(`No context source is registered under "${id}". Registered sources: ${known.join(", ")}.`);
    this.name = "UnknownContextSourceError";
  }
}

/**
 * SDD section 14 names this module `ContextSourceRegistry`. SDD section 17 fixes the source
 * interface. Source selection is configuration driven, so no call site names a concrete source.
 */
export class ContextSourceRegistry {
  private readonly sources = new Map<string, ContextSource>();

  constructor(sources: ContextSource[] = []) {
    for (const source of sources) this.register(source);
  }

  register(source: ContextSource): void {
    const id = source.id();
    if (this.sources.has(id)) {
      throw new Error(`A context source named "${id}" is already registered.`);
    }
    this.sources.set(id, source);
  }

  get(id: string): ContextSource {
    const source = this.sources.get(id);
    if (source === undefined) throw new UnknownContextSourceError(id, this.ids());
    return source;
  }

  ids(): string[] {
    return [...this.sources.keys()].sort();
  }

  all(): ContextSource[] {
    return this.ids().map((id) => this.get(id));
  }
}
