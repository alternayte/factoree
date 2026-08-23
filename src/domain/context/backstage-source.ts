import type {
  BackstageCatalogPort,
  BackstageEntity,
} from "~/adapters/backstage/backstage-catalog-client.js";
import type { BackstageSourceSettings } from "./context-source-configuration.js";
import type {
  ContextCandidate,
  ContextDiscoveryRequest,
  ContextDocument,
  ContextReference,
  ContextSource,
} from "./context-source.js";
import { DISCOVERY_PRIORITY } from "./context-source.js";

/** The stable reference of one catalog entity inside one Context Contract. */
export const backstageEntityRef = (entityRef: string): string => `backstage:${entityRef}`;

export interface BackstageContextSourceOptions {
  sourceId: string;
  catalog: BackstageCatalogPort;
  settings: BackstageSourceSettings;
}

const topicsIn = (text: string, topics: string[]): string[] => {
  const lower = text.toLowerCase();
  return topics.filter((topic) => lower.includes(topic));
};

/** The bare name of an entity reference, for a sentence a human reads. */
const nameOf = (ref: string): string => ref.slice(ref.lastIndexOf("/") + 1);

/** The text a Context Item of this source carries. It is catalog metadata, never repository code. */
const renderEntity = (entity: BackstageEntity): string => {
  const lines = [
    `${entity.kind}: ${entity.name}`,
    entity.title === null ? null : `Title: ${entity.title}`,
    entity.description === null ? null : `Description: ${entity.description}`,
    entity.owner === null ? null : `Owner: ${entity.owner}`,
    entity.system === null ? null : `System: ${entity.system}`,
    entity.repositorySlug === null ? null : `Repository: ${entity.repositorySlug}`,
    entity.dependsOn.length === 0 ? null : `Depends on: ${entity.dependsOn.join(", ")}`,
    entity.providesApis.length === 0 ? null : `Provides APIs: ${entity.providesApis.join(", ")}`,
    entity.consumesApis.length === 0 ? null : `Consumes APIs: ${entity.consumesApis.join(", ")}`,
    entity.definition === null ? null : `Definition:\n${entity.definition}`,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
};

/**
 * SDD section 19. Backstage is a topology source: it helps Factoree decide where to look. SDD
 * section 18 gives an ownership or dependency relation priority 3 and an API relation priority 4,
 * and it forbids organization-wide unbounded retrieval, so discovery is one hop from the entity
 * of the primary repository and stops at a hard cap. See controller decisions 5 and 6.
 */
export class BackstageContextSource implements ContextSource {
  private readonly documents = new Map<string, { content: string; sourceVersion: string }>();

  constructor(private readonly options: BackstageContextSourceOptions) {}

  id(): string {
    return this.options.sourceId;
  }

  private candidate(
    entity: BackstageEntity,
    reason: string,
    priority: number,
    request: ContextDiscoveryRequest,
  ): ContextCandidate {
    const content = renderEntity(entity);
    const ref = backstageEntityRef(entity.ref);
    this.documents.set(ref, { content, sourceVersion: entity.sourceVersion });

    const candidate: ContextCandidate = {
      reference: { sourceId: this.id(), ref, repository: null, sha: null, path: null },
      sourceVersion: entity.sourceVersion,
      // SDD section 19 and SDD section 22. The catalog is declarative topology. It never
      // outranks executable code or an accepted architecture decision.
      authority: "declarative_catalog",
      reason,
      priority,
      topics: topicsIn(content, request.topics),
      sizeBytes: Buffer.byteLength(content, "utf8"),
      // The catalog explains where to look. The Implementer prompt does not need it preloaded,
      // and the Context Contract names it, so `reference` is the honest classification.
      suggestedClassification: "reference",
    };

    // SDD section 20 and controller decision 7. A repository location becomes a reference
    // repository only when the primary repository asked for automatic discovery.
    if (
      request.contextConfiguration.automaticReferenceDiscovery &&
      entity.repositorySlug !== null &&
      entity.repositoryUrl !== null &&
      entity.repositorySlug !== request.primaryRepository.slug
    ) {
      candidate.discoveredRepository = { slug: entity.repositorySlug, url: entity.repositoryUrl };
    }

    return candidate;
  }

  async discover(request: ContextDiscoveryRequest): Promise<ContextCandidate[]> {
    this.documents.clear();
    try {
      return await this.walk(request);
    } catch {
      // Controller decision 13. Backstage is not required for a Run to proceed, so a catalog
      // fault degrades the Run and never fails it.
      return [];
    }
  }

  private async walk(request: ContextDiscoveryRequest): Promise<ContextCandidate[]> {
    const root =
      this.options.settings.primaryComponent === null
        ? await this.options.catalog.findByRepositorySlug(request.primaryRepository.slug)
        : await this.options.catalog.getByRef(this.options.settings.primaryComponent);
    if (root === null) return [];

    const cap = this.options.settings.maxEntities;
    const candidates: ContextCandidate[] = [
      this.candidate(
        root,
        `the Backstage catalog entity of the primary repository "${request.primaryRepository.slug}"`,
        DISCOVERY_PRIORITY.backstage_relation,
        request,
      ),
    ];
    const seen = new Set([root.ref]);

    // One hop only. Each list keeps the order the catalog reported, so discovery is repeatable.
    const relations: Array<{ ref: string; reason: string; priority: number }> = [];
    for (const ref of root.dependsOn) {
      relations.push({
        ref,
        reason: `the Backstage catalog records that "${root.name}" depends on "${nameOf(ref)}"`,
        priority: DISCOVERY_PRIORITY.backstage_relation,
      });
    }
    for (const ref of root.providesApis) {
      relations.push({
        ref,
        reason: `the Backstage catalog records that "${root.name}" provides the API "${nameOf(ref)}"`,
        priority: DISCOVERY_PRIORITY.backstage_api_relation,
      });
    }
    for (const ref of root.consumesApis) {
      relations.push({
        ref,
        reason: `the Backstage catalog records that "${root.name}" consumes the API "${nameOf(ref)}"`,
        priority: DISCOVERY_PRIORITY.backstage_api_relation,
      });
    }
    if (this.options.settings.includeOwnership) {
      if (root.system !== null) {
        relations.push({
          ref: root.system,
          reason: `the Backstage catalog places "${root.name}" in the system "${nameOf(root.system)}"`,
          priority: DISCOVERY_PRIORITY.backstage_relation,
        });
      }
      if (root.owner !== null) {
        relations.push({
          ref: root.owner,
          reason: `the Backstage catalog records that "${nameOf(root.owner)}" owns "${root.name}"`,
          priority: DISCOVERY_PRIORITY.backstage_relation,
        });
      }
    }

    for (const relation of relations) {
      if (candidates.length >= cap) break;
      if (seen.has(relation.ref)) continue;
      seen.add(relation.ref);
      const entity = await this.options.catalog.getByRef(relation.ref);
      if (entity === null) continue;
      candidates.push(this.candidate(entity, relation.reason, relation.priority, request));
    }

    return candidates;
  }

  fetch(reference: ContextReference): Promise<ContextDocument> {
    const document = this.documents.get(reference.ref);
    if (document === undefined) {
      return Promise.reject(
        new Error(`The Backstage context source never offered "${reference.ref}".`),
      );
    }
    return Promise.resolve({
      reference,
      sourceVersion: document.sourceVersion,
      content: document.content,
    });
  }
}
