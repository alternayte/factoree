import { gunzipSync, gzipSync } from "node:zlib";

/**
 * docs/specs/skill-registry.md. A small reader and writer of gzipped tar archives. A skill archive
 * holds a few text files, so the whole archive fits in memory.
 */

export interface TarEntry {
  name: string;
  /** "file", "directory", or "other" for a link, a device or any other type. */
  type: "file" | "directory" | "other";
  data: Uint8Array;
}

const BLOCK = 512;

const text = (block: Uint8Array, offset: number, length: number): string => {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return Buffer.from(end === -1 ? slice : slice.subarray(0, end)).toString("utf8");
};

const octal = (block: Uint8Array, offset: number, length: number): number => {
  const value = text(block, offset, length).trim();
  return value === "" ? 0 : Number.parseInt(value, 8);
};

/** The `path` record of a PAX extended header, or null. */
const paxPath = (data: Uint8Array): string | null => {
  const records = Buffer.from(data).toString("utf8");
  let position = 0;
  while (position < records.length) {
    const space = records.indexOf(" ", position);
    if (space === -1) break;
    const length = Number.parseInt(records.slice(position, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = records.slice(space + 1, position + length - 1);
    const equals = record.indexOf("=");
    if (equals !== -1 && record.slice(0, equals) === "path") return record.slice(equals + 1);
    position += length;
  }
  return null;
};

/** Reads every entry of a gzipped tar archive. A malformed archive throws. */
export const readTarGz = (archive: Uint8Array): TarEntry[] => {
  const bytes = gunzipSync(archive);
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | null = null;
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("the archive holds an entry with an unreadable size");
    const flag = String.fromCharCode(header[156] ?? 0);
    const prefix = text(header, 345, 155);
    const base = text(header, 0, 100);
    const dataStart = offset + BLOCK;
    if (dataStart + size > bytes.length) throw new Error("the archive ends inside an entry");
    const data = bytes.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (flag === "x") {
      longName = paxPath(data);
      continue;
    }
    if (flag === "L") {
      longName = text(data, 0, data.length);
      continue;
    }
    if (flag === "g") continue;
    const name = longName ?? (prefix === "" ? base : `${prefix}/${base}`);
    longName = null;
    const type = flag === "0" || flag === "\u0000" ? "file" : flag === "5" ? "directory" : "other";
    entries.push({ name, type, data: new Uint8Array(data) });
  }
  return entries;
};

const writeField = (block: Buffer, offset: number, length: number, value: string): void => {
  block.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
};

const octalField = (value: number, length: number): string => `${value.toString(8).padStart(length - 1, "0")}\u0000`;

const headerOf = (name: string, size: number, flag: string): Buffer => {
  const block = Buffer.alloc(BLOCK);
  writeField(block, 0, 100, name);
  writeField(block, 100, 8, octalField(0o644, 8));
  writeField(block, 108, 8, octalField(0, 8));
  writeField(block, 116, 8, octalField(0, 8));
  writeField(block, 124, 12, octalField(size, 12));
  writeField(block, 136, 12, octalField(0, 12));
  block.fill(" ", 148, 156);
  writeField(block, 156, 1, flag);
  writeField(block, 257, 6, "ustar\u0000");
  writeField(block, 263, 2, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  writeField(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\u0000 `);
  return block;
};

const padded = (data: Buffer): Buffer => {
  const rest = data.length % BLOCK;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rest)]);
};

/** Writes regular files into a gzipped tar archive. A long name gets a PAX `path` record. */
export const writeTarGz = (files: ReadonlyArray<{ path: string; content: string | Uint8Array }>): Uint8Array => {
  const blocks: Buffer[] = [];
  for (const file of files) {
    if (Buffer.byteLength(file.path) > 99) {
      const record = (length: number) => `${length} path=${file.path}\n`;
      let length = Buffer.byteLength(record(0));
      while (Buffer.byteLength(record(length)) !== length) length = Buffer.byteLength(record(length));
      const pax = Buffer.from(record(length), "utf8");
      blocks.push(headerOf("PaxHeader", pax.length, "x"), padded(pax));
    }
    const data = typeof file.content === "string" ? Buffer.from(file.content, "utf8") : Buffer.from(file.content);
    blocks.push(headerOf(file.path.slice(0, 99), data.length, "0"), padded(data));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
};

/**
 * docs/specs/skill-registry.md. A skill archive may hold regular files and directories inside its
 * own root, and nothing else. Skael refuses links and traversal at publish. Factoree checks again,
 * because the archive is unpacked in a sandbox an agent runs in.
 */
export const unsafeEntryOf = (entries: ReadonlyArray<TarEntry>): string | null => {
  for (const entry of entries) {
    if (entry.type === "other") return `the entry "${entry.name}" is not a regular file or a directory`;
    const segments = entry.name.split("/").filter((segment) => segment !== "" && segment !== ".");
    if (entry.name.startsWith("/") || segments.includes("..")) return `the entry "${entry.name}" leaves the skill directory`;
  }
  return null;
};
