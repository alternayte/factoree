import type { Logger } from "~/telemetry/logger.js";
import type { Redactor } from "~/telemetry/redaction.js";
import type { EvidenceStore } from "~/domain/evidence/evidence.js";
import type { EvidenceStorage } from "~/domain/evidence/evidence-storage.js";
import type { ContextSourceConfigurationStore } from "~/domain/context/context-source-configuration.js";
import type { ContextDeliverySourceProvider } from "~/domain/context/context-source-provider.js";
import {
  collectImages,
  commentOrigin,
  imageFileName,
  imageReferencesIn,
  keptComments,
  linkUrlsIn,
  readLinks,
  renderComments,
  workItemImageRef,
  type LinkHosts,
  type LinkNotRead,
  type LinkRepository,
  type LinkSourceHost,
  type LinkTarget,
  type SkippedImage,
  type WorkItemContentPort,
  type WorkItemImage,
  type WorkItemLink,
  type WorkItemLinkReaders,
  type WorkItemText,
} from "~/domain/context/work-item-content.js";

export interface ReadWorkItemContentActivityInput {
  tenantId: string;
  productId: string;
  runId: string;
  issueId: string;
  /** The description as the author wrote it. */
  description: string;
  /** ISO 8601. A comment created later is not read. Null reads every comment. */
  delegatedAt: string | null;
  /** The repositories of the product: a GitHub link must name one of them. */
  repositories: LinkRepository[];
}

export interface ReadWorkItemContentActivityOutput {
  /** The content of the comments item, or null when no human comment is kept. */
  comments: string | null;
  commentCount: number;
  images: WorkItemImage[];
  links: WorkItemLink[];
  skippedImages: SkippedImage[];
  linksNotRead: LinkNotRead[];
  /**
   * The FAILED_CONFIGURATION message when the issue holds an image and a role model reads no
   * image, or null. The workflow decides whether a reply skips it.
   */
  visionFailure: string | null;
}

export interface WorkItemActivityDependencies {
  content: WorkItemContentPort;
  /** The configured context sources of the product, for their hosts. */
  configurations: Pick<ContextSourceConfigurationStore, "list">;
  /** The built sources, for a link to a source host. */
  sources: ContextDeliverySourceProvider;
  /** The GitHub web URL of the install, such as https://github.com. */
  githubWebUrl: () => Promise<string>;
  evidence: EvidenceStore;
  storage: EvidenceStorage;
  /** The vision message for the product's role models, or null when every role reads images. */
  vision: (tenantId: string, productId: string, imageCount: number) => Promise<string | null>;
  logger: Logger;
  redactor: Redactor;
}

/** The hosts a link of this product may lead to. */
export const linkHostsFor = async (
  dependencies: Pick<WorkItemActivityDependencies, "configurations" | "githubWebUrl">,
  tenantId: string,
  productId: string,
  repositories: LinkRepository[],
): Promise<LinkHosts> => {
  const records = await dependencies.configurations.list(tenantId, productId);
  const sources: LinkSourceHost[] = records
    .filter((record) => record.enabled)
    .map((record) => ({
      sourceId: record.sourceId,
      kind: record.kind,
      endpoint: record.endpoint,
      // SDD section 22. A Backstage item is a declarative catalog entry, as the source names it.
      authority: record.settings.kind === "backstage" ? "declarative_catalog" : record.settings.authority,
    }));
  return { githubWebUrl: await dependencies.githubWebUrl(), repositories, sources };
};

/** The readers of a followed link, for one tenant and one product. */
export const linkReadersFor = (
  dependencies: Pick<WorkItemActivityDependencies, "content" | "sources">,
  tenantId: string,
  productId: string,
): WorkItemLinkReaders => {
  let configured: Awaited<ReturnType<ContextDeliverySourceProvider["configuredSourcesFor"]>> | null = null;
  return {
    linearIssue: (identifier) => dependencies.content.linearIssue(tenantId, identifier),
    github: (target) => dependencies.content.github(target),
    source: async (target: Extract<LinkTarget, { kind: "source" }>) => {
      configured ??= await dependencies.sources.configuredSourcesFor(tenantId, productId);
      const document = await configured.sources
        .get(target.sourceId)
        .fetch({ sourceId: target.sourceId, ref: target.ref, repository: null, sha: null, path: null });
      return { content: document.content };
    },
  };
};

/**
 * docs/specs/work-item-images-and-links.md. Reads what the issue holds besides its description,
 * in the control plane, before refinement: the human comments, the images and the links. Each
 * image is stored as evidence. A link is read only to a host a human chose. The output holds no
 * image byte and no link content, only hashes, so no Temporal history carries either.
 */
export const createWorkItemActivities = (dependencies: WorkItemActivityDependencies) => ({
  async readWorkItemContent(input: ReadWorkItemContentActivityInput): Promise<ReadWorkItemContentActivityOutput> {
    const comments = keptComments(await dependencies.content.comments(input.tenantId, input.issueId), input.delegatedAt);
    const texts: WorkItemText[] = [
      { origin: "the description", text: input.description },
      ...comments.map((comment) => ({ origin: commentOrigin(comment), text: comment.body })),
    ];

    const collected = await collectImages(imageReferencesIn(texts), (url, maxBytes) =>
      dependencies.content.downloadImage(input.tenantId, url, maxBytes),
    );
    // SDD section 39. Each image is stored as evidence. The row is idempotent on its key, so a
    // retry writes no second row.
    for (const image of collected.images) {
      const stored = await dependencies.storage.put({
        tenantId: input.tenantId,
        runId: input.runId,
        name: `work-item-${imageFileName(image)}`,
        contentType: image.contentType,
        bytes: image.bytes,
      });
      await dependencies.evidence.record({
        tenantId: input.tenantId,
        runId: input.runId,
        kind: "work_item_image",
        source: workItemImageRef(image.n),
        sha256: stored.sha256,
        storageRef: stored.storageRef,
        metadata: { url: image.url, caption: image.caption, origin: image.origin, contentType: image.contentType },
        idempotencyKey: `run:${input.runId}:work-item-image:${image.n}:${image.sha256}`,
      });
    }

    const hosts = await linkHostsFor(dependencies, input.tenantId, input.productId, input.repositories);
    const followed = await readLinks(linkUrlsIn(texts), hosts, linkReadersFor(dependencies, input.tenantId, input.productId));

    // The bytes stay in this activity: the output is Temporal history.
    const images: WorkItemImage[] = collected.images.map((image) => ({
      n: image.n,
      url: image.url,
      sha256: image.sha256,
      contentType: image.contentType,
      extension: image.extension,
      byteLength: image.byteLength,
      caption: image.caption,
      origin: image.origin,
    }));
    const visionFailure = images.length === 0 ? null : await dependencies.vision(input.tenantId, input.productId, images.length);

    dependencies.logger.info("work item content read", {
      tenant_id: input.tenantId,
      product_id: input.productId,
      run_id: input.runId,
      comments: comments.length,
      images: images.length,
      images_skipped: collected.skipped.length,
      links: followed.links.length,
      links_not_read: followed.notRead.length,
      step: "read_work_item",
    });

    // SDD section 60. A reason can hold a server message, and the output is Temporal history.
    const redact = (text: string): string => dependencies.redactor.redactText(text);
    return {
      comments: renderComments(comments),
      commentCount: comments.length,
      images,
      links: followed.links,
      skippedImages: collected.skipped.map((image) => ({ ...image, reason: redact(image.reason) })),
      linksNotRead: followed.notRead.map((link) => ({ ...link, reason: redact(link.reason) })),
      visionFailure,
    };
  },
});
