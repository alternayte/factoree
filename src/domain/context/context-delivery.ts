import { createHash } from "node:crypto";
import type { SelectedContextItem } from "./conflicts.js";
import type { ContextSourceKind } from "./context-source-configuration.js";
import { RESERVED_CONTEXT_SOURCE_IDS } from "./context-source-configuration.js";
import type { ContextSourceRegistry } from "./context-source-registry.js";

/** docs/specs/external-context-delivery.md. Delivery stops at this many files. */
export const CONTEXT_DELIVERY_MAX_FILES = 50;
/** docs/specs/external-context-delivery.md. Delivery stops at this many bytes in total. */
export const CONTEXT_DELIVERY_MAX_BYTES = 4 * 1024 * 1024;

/** The directory below `$HOME` of the work sprite. It is outside the checkout, so no patch holds it. */
export const CONTEXT_DELIVERY_DIRECTORY = ".factoree/context";

/**
 * docs/specs/external-context-delivery.md. `Run.deliveredContext` holds one entry per item. It
 * holds no content: SDD section 55 keeps copies out of the control plane.
 */
export interface DeliveredContextEntry {
  ref: string;
  /** The file in the work sprite, or null when Factoree wrote no file. */
  path: string | null;
  /** The SHA-256 of the content Factoree read at delivery, or null when it read none. */
  sha256: string | null;
  /** True when the content matched a hash the contract froze. */
  verified: boolean;
  /** Why Factoree wrote no file, or null. */
  skipReason: string | null;
}

export interface ContextDelivery {
  entries: DeliveredContextEntry[];
  /** One prompt line per written file: the ref, the authority, the path and the hash. */
  lines: string[];
}

export interface ContextDeliveryInput {
  /** The frozen items, in contract order. */
  items: SelectedContextItem[];
  /** The configured sources of the product, built for this delivery. */
  sources: ContextSourceRegistry;
  /** The kind of each configured source, by source id. */
  kinds: ReadonlyMap<string, ContextSourceKind>;
  /** The absolute directory the files go to. */
  directory: string;
  /** Writes one file. A throw skips the item and records the reason. */
  write: (path: string, content: string) => Promise<void>;
  /** Set when the directory could not be made. Every item is then skipped with this reason. */
  unavailable?: string | null;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** DI-21.38. A file name part a person can read: lower case, runs of other characters as "-". */
export const contextFileSlug = (ref: string): string => {
  const slug = ref
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "item";
};

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Puts stored items in contract order. The store keeps no order, so the order comes from the
 * resolution, and an item the order does not name follows in stored order.
 */
export const inContractOrder = (items: SelectedContextItem[], order: string[] | undefined): SelectedContextItem[] => {
  if (order === undefined) return items;
  const position = new Map(order.map((ref, index) => [ref, index]));
  return items
    .map((item, index) => ({ item, rank: position.get(item.reference.ref) ?? order.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
};

/**
 * The items delivery considers: each required and reference item of a configured source, in
 * contract order. Linear and repository items are not external: the agent reads the repository in
 * the checkout, and the work item is in the prompt.
 */
export const deliverableItems = (items: SelectedContextItem[]): SelectedContextItem[] =>
  items.filter(
    (item) =>
      (item.classification === "required" || item.classification === "reference") &&
      !(RESERVED_CONTEXT_SOURCE_IDS as readonly string[]).includes(item.reference.sourceId),
  );

/**
 * docs/specs/external-context-delivery.md. Fetches each deliverable item again and writes it to
 * one file. A required item must hash to its frozen `contentSha256`, and an llms.txt item to its
 * source version: on a mismatch Factoree writes no file, because the agent must not read content
 * the contract does not name. A fetch fault skips the item and records why (DI-5.13). Delivery
 * stops at 50 files and 4 MiB in total, in contract order (DI-21.38).
 */
export const deliverContext = async (input: ContextDeliveryInput): Promise<ContextDelivery> => {
  const entries: DeliveredContextEntry[] = [];
  const lines: string[] = [];
  let files = 0;
  let bytes = 0;
  let capReason: string | null = null;

  const items = deliverableItems(input.items);
  for (const [index, item] of items.entries()) {
    const ref = item.reference.ref;
    const skip = (reason: string, sha: string | null = null): void => {
      entries.push({ ref, path: null, sha256: sha, verified: false, skipReason: reason });
    };
    if (input.unavailable !== undefined && input.unavailable !== null) {
      skip(input.unavailable);
      continue;
    }
    if (capReason !== null) {
      skip(capReason);
      continue;
    }
    if (files >= CONTEXT_DELIVERY_MAX_FILES) {
      capReason = `Delivery stops at ${CONTEXT_DELIVERY_MAX_FILES} files.`;
      skip(capReason);
      continue;
    }

    let content: string;
    try {
      const source = input.sources.get(item.reference.sourceId);
      content = (await source.fetch(item.reference)).content;
    } catch (error) {
      skip(`The source could not be read: ${reasonOf(error)}`);
      continue;
    }

    const hash = sha256(content);
    const kind = input.kinds.get(item.reference.sourceId);
    const frozen =
      kind === "llms_txt" ? item.sourceVersion : item.classification === "required" ? item.contentSha256 : null;
    if (frozen !== null && hash !== frozen) {
      skip(`The content changed after the freeze: it hashes to ${hash}, and the contract froze ${frozen}.`, hash);
      continue;
    }

    const size = Buffer.byteLength(content, "utf8");
    if (bytes + size > CONTEXT_DELIVERY_MAX_BYTES) {
      capReason = `Delivery stops at ${CONTEXT_DELIVERY_MAX_BYTES} bytes in total.`;
      skip(capReason, hash);
      continue;
    }

    const path = `${input.directory}/${String(index + 1).padStart(2, "0")}-${contextFileSlug(ref)}.md`;
    try {
      await input.write(path, content);
    } catch (error) {
      skip(`The file could not be written: ${reasonOf(error)}`, hash);
      continue;
    }
    files += 1;
    bytes += size;
    entries.push({ ref, path, sha256: hash, verified: frozen !== null, skipReason: null });
    lines.push(`${ref} — authority ${item.authority}, file ${path}, sha256 ${hash}`);
  }

  return { entries, lines };
};
