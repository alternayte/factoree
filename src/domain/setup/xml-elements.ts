/**
 * docs/specs/nuget-private-feed-mapping.md, DI-21.221. A small reader of the elements of an XML
 * file, enough for `NuGet.config`, MSBuild project files and `packages.config`. It keeps element
 * names and attribute values and drops comments, processing instructions and CDATA. It never
 * fails: a file it cannot read gives fewer elements, as derived-hosts.ts treats a file.
 */
export interface XmlElement {
  name: string;
  /** Attribute values by lower-case name. */
  attributes: Record<string, string>;
  children: XmlElement[];
  /** The text directly inside the element, entities decoded. */
  text: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

const decode = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });

const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g;
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;

const attributesOf = (text: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  for (const match of text.matchAll(ATTRIBUTE)) attributes[match[1]!.toLowerCase()] = decode(match[2] ?? match[3] ?? "");
  return attributes;
};

/** The document as a root element named `#document`. */
export const parseXml = (text: string): XmlElement => {
  const root: XmlElement = { name: "#document", attributes: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  const source = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");
  let last = 0;
  for (const match of source.matchAll(TAG)) {
    stack.at(-1)!.text += decode(source.slice(last, match.index));
    last = match.index + match[0].length;
    const name = match[2]!;
    if (match[1] === "/") {
      // A close tag closes its element and every element left open inside it.
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index]!.name.toLowerCase() === name.toLowerCase()) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const element: XmlElement = { name, attributes: attributesOf(match[3] ?? ""), children: [], text: "" };
    stack.at(-1)!.children.push(element);
    if (match[4] !== "/") stack.push(element);
  }
  return root;
};

/** The value of an attribute, by any case of its name, or null. */
export const attributeOf = (element: XmlElement, name: string): string | null => element.attributes[name.toLowerCase()] ?? null;

/** The direct children with this name, in any case. */
export const childrenNamed = (element: XmlElement, name: string): XmlElement[] =>
  element.children.filter((child) => child.name.toLowerCase() === name.toLowerCase());

/** Every element under this one with this name, in any case, in document order. */
export const descendantsNamed = (element: XmlElement, name: string): XmlElement[] => {
  const found: XmlElement[] = [];
  const visit = (current: XmlElement): void => {
    for (const child of current.children) {
      if (child.name.toLowerCase() === name.toLowerCase()) found.push(child);
      visit(child);
    }
  };
  visit(element);
  return found;
};
