import { posix } from "node:path";
import { attributeOf, childrenNamed, descendantsNamed, parseXml, type XmlElement } from "./xml-elements.js";
import type { RepositoryTextFile } from "./derived-hosts.js";

/**
 * docs/specs/nuget-private-feed-mapping.md. One package a repository file references, with the
 * version Factoree checks, or the reason it checks none.
 */
export interface NugetPackageReference {
  id: string;
  /** The normalised exact version, or null when the version is unchecked. */
  version: string | null;
  /** The version as the file writes it, after the MSBuild properties Factoree resolved. */
  versionText: string;
  /** Why no version is checked, or null. Restore decides such a package. */
  unchecked: string | null;
  /** The file that references the package. */
  project: string;
  /** The MSBuild condition of the reference, such as a target framework, or null. */
  condition: string | null;
}

/** The most values one MSBuild expression expands to, so a property matrix stays small. */
const MAX_PROPERTY_VALUES = 8;
const PROPERTY_REFERENCE = /\$\(([A-Za-z_][\w.-]*)\)/;

const VERSION = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * NuGet's normal form of a version: three parts, a fourth only when it is not 0, no leading
 * zeros, the prerelease label in lower case and no build metadata. `0.2.6` and `0.2.6.0` are one
 * version, and so are `1.0.0-Beta` and `1.0.0-beta`. Null for text that is no version.
 */
export const normalizeNugetVersion = (text: string): string | null => {
  const match = VERSION.exec(text.trim());
  if (match === null) return null;
  const [major, minor, patch, revision] = [match[1], match[2], match[3], match[4]].map((part) => Number(part ?? "0"));
  const base = `${String(major)}.${String(minor)}.${String(patch)}${revision === 0 ? "" : `.${String(revision)}`}`;
  return match[5] === undefined ? base : `${base}-${match[5].toLowerCase()}`;
};

/** True when two version texts name one NuGet version. */
export const nugetVersionsEqual = (left: string, right: string): boolean => {
  const a = normalizeNugetVersion(left);
  return a !== null && a === normalizeNugetVersion(right);
};

const compareLabels = (left: string, right: string): number => {
  const a = left.split(".");
  const b = right.split(".");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const order = numeric ? Number(x) - Number(y) : /^\d+$/.test(x) ? -1 : /^\d+$/.test(y) ? 1 : x < y ? -1 : x > y ? 1 : 0;
    if (order !== 0) return Math.sign(order);
  }
  return 0;
};

/** NuGet's order of two versions: the numbers, then a prerelease before its release. Null when either is no version. */
export const compareNugetVersions = (left: string, right: string): number | null => {
  const a = normalizeNugetVersion(left);
  const b = normalizeNugetVersion(right);
  if (a === null || b === null) return null;
  const [aBase = "", aLabel] = a.split(/-(.*)/s);
  const [bBase = "", bLabel] = b.split(/-(.*)/s);
  const aParts = aBase.split(".").map(Number);
  const bParts = bBase.split(".").map(Number);
  for (let index = 0; index < 4; index += 1) {
    const order = (aParts[index] ?? 0) - (bParts[index] ?? 0);
    if (order !== 0) return Math.sign(order);
  }
  if (aLabel === undefined || bLabel === undefined) return aLabel === bLabel ? 0 : aLabel === undefined ? 1 : -1;
  return compareLabels(aLabel, bLabel);
};

/** What Factoree checks for one version text: the exact version, or nothing and why. */
export type VersionReading = { kind: "exact"; version: string } | { kind: "unchecked"; reason: string };

/**
 * A bare version is NuGet's lowest version, which restore takes when the feed has it, so Factoree
 * checks it exactly. A floating version, a range or an unresolved property names no version, and
 * Factoree invents no minimum for it.
 */
export const readVersionText = (raw: string): VersionReading => {
  const text = raw.trim();
  if (text === "") return { kind: "unchecked", reason: "no version" };
  const property = /\$\(([^)]*)\)/.exec(text);
  if (property !== null) return { kind: "unchecked", reason: `the MSBuild property $(${property[1]!}) does not resolve` };
  if (text.includes("$(") || text.includes("@(") || text.includes("%(")) return { kind: "unchecked", reason: `the MSBuild expression \`${text}\` does not resolve` };
  if (text.includes("*")) return { kind: "unchecked", reason: `the floating version \`${text}\`` };
  const exact = /^\[\s*([^,\]\s]+)\s*\]$/.exec(text);
  if (exact !== null) {
    const version = normalizeNugetVersion(exact[1]!);
    return version === null ? { kind: "unchecked", reason: `the version \`${text}\` does not parse` } : { kind: "exact", version };
  }
  if (/^[[(]|,/.test(text)) return { kind: "unchecked", reason: `the version range \`${text}\`` };
  const version = normalizeNugetVersion(text);
  return version === null ? { kind: "unchecked", reason: `the version \`${text}\` does not parse` } : { kind: "exact", version };
};

/** MSBuild properties by lower-case name, each with every value a definition can give it. */
export type MsbuildProperties = Map<string, string[]>;

/**
 * Adds the properties of one MSBuild file. MSBuild expands a property where it is assigned, so a
 * later definition of a property it names does not change it. An unconditional definition
 * replaces the values, and a conditional one adds its values, because Factoree evaluates no
 * condition.
 */
export const addMsbuildProperties = (properties: MsbuildProperties, document: XmlElement): void => {
  for (const group of descendantsNamed(document, "PropertyGroup")) {
    const groupCondition = attributeOf(group, "Condition");
    for (const property of group.children) {
      const name = property.name.toLowerCase();
      const value = property.text.trim();
      const values = expandMsbuild(value, properties) ?? [value];
      const conditional = groupCondition !== null || attributeOf(property, "Condition") !== null;
      const current = properties.get(name) ?? [];
      properties.set(name, conditional ? [...new Set([...current, ...values])] : values);
    }
  }
};

/**
 * Every value of an MSBuild expression, with each `$(Name)` replaced by each value of the
 * property. A stored value was expanded where it was assigned, so a substituted value is never
 * expanded again: a `$(Name)` left in it was unknown there and stays unresolved. A property with
 * no value stays as written, so the version reads as unchecked. Null when the expression has more
 * than MAX_PROPERTY_VALUES values, so no value is dropped unseen.
 */
export const expandMsbuild = (text: string, properties: MsbuildProperties): string[] | null => {
  let results = [""];
  let rest = text;
  for (let match = PROPERTY_REFERENCE.exec(rest); match !== null; match = PROPERTY_REFERENCE.exec(rest)) {
    const prefix = rest.slice(0, match.index);
    const values = properties.get(match[1]!.toLowerCase());
    const choices = values === undefined || values.length === 0 ? [match[0]] : values;
    const next = new Set(results.flatMap((result) => choices.map((choice) => `${result}${prefix}${choice}`)));
    if (next.size > MAX_PROPERTY_VALUES) return null;
    results = [...next];
    rest = rest.slice(match.index + match[0].length);
  }
  return results.map((result) => `${result}${rest}`);
};

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1).toLowerCase();
const folderOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** The folders from the root down to the folder of the path, root first. */
const foldersAbove = (path: string): string[] => {
  const parts = folderOf(path).split("/").filter((part) => part !== "");
  return ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
};

const PROJECT = /\.(cs|fs|vb)proj$/i;

/** True when the file is one the package read takes. */
export const isNugetPackageFile = (path: string): boolean => {
  const name = baseName(path);
  return (
    PROJECT.test(name) ||
    name === "directory.packages.props" ||
    name === "directory.build.props" ||
    name === "directory.build.targets" ||
    name === "packages.config" ||
    name === "dotnet-tools.json"
  );
};

const valueOf = (element: XmlElement, name: string): string | null => {
  const attribute = attributeOf(element, name);
  if (attribute !== null) return attribute;
  const child = childrenNamed(element, name)[0];
  return child === undefined ? null : child.text.trim();
};

const conditionOf = (element: XmlElement, group: XmlElement | null): string | null =>
  attributeOf(element, "Condition") ?? (group === null ? null : attributeOf(group, "Condition"));

const idsOf = (text: string | null): string[] =>
  (text ?? "")
    .split(";")
    .map((id) => id.trim())
    .filter((id) => id !== "" && !id.includes("$(") && !id.includes("@("));

/** The items of one kind in document order, each with its item group. */
const itemsOf = (document: XmlElement, kind: string): Array<{ element: XmlElement; group: XmlElement | null }> => {
  const found: Array<{ element: XmlElement; group: XmlElement | null }> = [];
  for (const group of descendantsNamed(document, "ItemGroup")) {
    for (const element of childrenNamed(group, kind)) found.push({ element, group });
  }
  return found;
};

/** One file, or the part of it before or after the import of a parent file. */
interface MsbuildPart {
  path: string;
  document: XmlElement;
}

interface PendingReference {
  id: string;
  version: string | null;
  versionOverride: string | null;
  condition: string | null;
}

const reference = (
  id: string,
  versionText: string | null,
  project: string,
  condition: string | null,
  properties: MsbuildProperties,
): NugetPackageReference[] => {
  if (versionText === null) return [{ id, version: null, versionText: "", unchecked: "no version", project, condition }];
  const expanded = expandMsbuild(versionText, properties);
  if (expanded === null) {
    return [{ id, version: null, versionText, unchecked: `the MSBuild expression \`${versionText}\` has more than ${String(MAX_PROPERTY_VALUES)} values`, project, condition }];
  }
  return expanded.map((text) => {
    const reading = readVersionText(text);
    return reading.kind === "exact"
      ? { id, version: reading.version, versionText: text, unchecked: null, project, condition }
      : { id, version: null, versionText: text, unchecked: reading.reason, project, condition };
  });
};

/** `<package id version>` of a `packages.config`. */
const fromPackagesConfig = (file: RepositoryTextFile): NugetPackageReference[] =>
  descendantsNamed(parseXml(file.text), "package").flatMap((element) => {
    const id = attributeOf(element, "id");
    return id === null ? [] : reference(id, attributeOf(element, "version"), file.path, null, new Map());
  });

/** The tools of a `dotnet-tools.json` manifest. */
const fromToolManifest = (file: RepositoryTextFile): NugetPackageReference[] => {
  try {
    const tools = (JSON.parse(file.text) as { tools?: Record<string, { version?: unknown }> }).tools ?? {};
    return Object.entries(tools).flatMap(([id, tool]) => reference(id, typeof tool.version === "string" ? tool.version : null, file.path, null, new Map()));
  } catch {
    return [];
  }
};

/**
 * docs/specs/nuget-private-feed-mapping.md, DI-21.224. The package references of a repository:
 * each project file with the nearest `Directory.Build.props`, `Directory.Packages.props` and
 * `Directory.Build.targets` above it, and each parent one that file imports, each
 * `packages.config` and each `dotnet-tools.json`. A parent file applies where its `<Import>`
 * stands. Properties come from every file of a project first, as MSBuild's first pass does. Items
 * follow in import order, so `Update` and `Remove` apply to what came before. Central package management gives a reference its `PackageVersion`,
 * `VersionOverride` wins, and a `GlobalPackageReference` belongs to its `Directory.Packages.props`.
 * Factoree evaluates no condition: each conditional version is one more reference, and a
 * conditional `Update` or `Remove` keeps what it replaces, so a target framework adds a check and
 * never hides one.
 */
export const readNugetPackageReferences = (files: readonly RepositoryTextFile[]): NugetPackageReference[] => {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const documents = new Map<string, XmlElement>();
  const documentOf = (path: string): XmlElement => {
    const cached = documents.get(path);
    if (cached !== undefined) return cached;
    const parsed = parseXml(byPath.get(path)?.text ?? "");
    documents.set(path, parsed);
    return parsed;
  };
  const fileAt = (path: string): string | null => files.find((file) => file.path.toLowerCase() === path.toLowerCase())?.path ?? null;
  /** The nearest file of the name in the folders, nearest first. */
  const nearestIn = (folders: readonly string[], name: string): string | null => {
    for (const folder of folders) {
      const found = fileAt(folder === "" ? name : `${folder}/${name}`);
      if (found !== null) return found;
    }
    return null;
  };
  // MSBuild imports only the nearest file of a name. A parent one counts when that file imports it:
  // `GetPathOfFileAbove('Directory.Build.props', ...)` finds the nearest one above, and a plain
  // path such as `../../Directory.Build.props` names one file.
  const parentImportOf = (path: string, name: string): { path: string | null; element: XmlElement } | null => {
    for (const element of descendantsNamed(documentOf(path), "Import")) {
      const project = (attributeOf(element, "Project") ?? "").trim();
      if (!project.toLowerCase().includes(name.toLowerCase())) continue;
      if (project.includes("$(")) return { path: nearestIn(foldersAbove(path).reverse().slice(1), name), element };
      return { path: fileAt(posix.normalize(posix.join(folderOf(path), project.replace(/\\/g, "/")))), element };
    }
    return null;
  };
  // A parent file applies where its <Import> stands: the importing file's content before the import
  // comes first, and its content after the import overrides the parent.
  const partsOf = (path: string, name: string, seen: readonly string[]): MsbuildPart[] => {
    const document = documentOf(path);
    const parent = parentImportOf(path, name);
    if (parent === null || parent.path === null || seen.includes(parent.path)) return [{ path, document }];
    const root = childrenNamed(document, "Project")[0] ?? document;
    const at = root.children.findIndex((child) => child === parent.element || descendantsNamed(child, "Import").includes(parent.element));
    const slice = (children: XmlElement[]): MsbuildPart => ({ path, document: { ...root, children } });
    const parentParts = partsOf(parent.path, name, [...seen, parent.path]);
    if (at < 0) return [...parentParts, { path, document }];
    return [slice(root.children.slice(0, at)), ...parentParts, slice(root.children.slice(at + 1))];
  };
  const above = (path: string, name: string): MsbuildPart[] => {
    const nearest = nearestIn(foldersAbove(path).reverse(), name);
    return nearest === null ? [] : partsOf(nearest, name, [nearest]);
  };

  const found: NugetPackageReference[] = [];
  for (const file of files) {
    const name = baseName(file.path);
    if (name === "packages.config") found.push(...fromPackagesConfig(file));
    if (name === "dotnet-tools.json") found.push(...fromToolManifest(file));
  }

  // A GlobalPackageReference counts once per `Directory.Packages.props` that a project imports.
  const globals = new Set<string>();
  for (const project of files.filter((entry) => PROJECT.test(entry.path))) {
    const buildProps = above(project.path, "Directory.Build.props");
    const packageProps = above(project.path, "Directory.Packages.props");
    const buildTargets = above(project.path, "Directory.Build.targets");
    const own: MsbuildPart = { path: project.path, document: documentOf(project.path) };
    const properties: MsbuildProperties = new Map();
    for (const { document } of [...buildProps, ...packageProps, own, ...buildTargets]) addMsbuildProperties(properties, document);

    for (const { path, document } of packageProps) {
      for (const { element, group } of itemsOf(document, "GlobalPackageReference")) {
        for (const id of idsOf(attributeOf(element, "Include"))) {
          for (const entry of reference(id, valueOf(element, "Version"), path, conditionOf(element, group), properties)) {
            const key = `${path} ${entry.id.toLowerCase()} ${entry.versionText}`;
            if (globals.has(key)) continue;
            globals.add(key);
            found.push(entry);
          }
        }
      }
    }

    // An unconditional PackageVersion replaces the versions of its id, and a conditional one adds one.
    const central = new Map<string, Array<{ version: string | null; condition: string | null }>>();
    for (const { document } of packageProps) {
      for (const { element, group } of itemsOf(document, "PackageVersion")) {
        const condition = conditionOf(element, group);
        for (const id of idsOf(attributeOf(element, "Include") ?? attributeOf(element, "Update"))) {
          const entry = { version: valueOf(element, "Version"), condition };
          central.set(id.toLowerCase(), condition === null ? [entry] : [...(central.get(id.toLowerCase()) ?? []), entry]);
        }
      }
    }

    const pending = new Map<string, PendingReference[]>();
    for (const { document } of [...buildProps, own, ...buildTargets]) {
      for (const { element, group } of itemsOf(document, "PackageReference")) {
        const condition = conditionOf(element, group);
        if (condition === null) for (const id of idsOf(attributeOf(element, "Remove"))) pending.delete(id.toLowerCase());
        for (const id of idsOf(attributeOf(element, "Update"))) {
          const existing = pending.get(id.toLowerCase());
          const version = valueOf(element, "Version");
          const versionOverride = valueOf(element, "VersionOverride");
          if (existing === undefined || (version === null && versionOverride === null)) continue;
          const updated = existing.map((entry) => ({
            id: entry.id,
            version: version ?? entry.version,
            versionOverride: versionOverride ?? entry.versionOverride,
            condition: condition ?? entry.condition,
          }));
          pending.set(id.toLowerCase(), condition === null ? updated : [...existing, ...updated]);
        }
        for (const id of idsOf(attributeOf(element, "Include"))) {
          const entry: PendingReference = { id, version: valueOf(element, "Version"), versionOverride: valueOf(element, "VersionOverride"), condition };
          const existing = pending.get(id.toLowerCase()) ?? [];
          pending.set(id.toLowerCase(), [...existing, entry]);
        }
      }
    }
    for (const entries of pending.values()) {
      for (const entry of entries) {
        const explicit = entry.versionOverride ?? entry.version;
        const versions = explicit !== null ? [{ version: explicit, condition: null }] : (central.get(entry.id.toLowerCase()) ?? [{ version: null, condition: null }]);
        for (const { version, condition } of versions) found.push(...reference(entry.id, version, project.path, entry.condition ?? condition, properties));
      }
    }
  }
  return found;
};

/** One package and version to look up, with every file that references it. */
export interface NugetPackageLookup {
  id: string;
  version: string;
  projects: string[];
}

/** The exact references grouped by id and version, ids compared in any case, sorted. */
export const lookupsOf = (references: readonly NugetPackageReference[]): NugetPackageLookup[] => {
  const byKey = new Map<string, NugetPackageLookup>();
  for (const entry of references) {
    if (entry.version === null) continue;
    const key = `${entry.id.toLowerCase()}/${entry.version}`;
    const current = byKey.get(key);
    if (current === undefined) byKey.set(key, { id: entry.id, version: entry.version, projects: [entry.project] });
    else if (!current.projects.includes(entry.project)) current.projects.push(entry.project);
  }
  return [...byKey.values()].sort((left, right) => left.id.toLowerCase().localeCompare(right.id.toLowerCase()) || left.version.localeCompare(right.version));
};
