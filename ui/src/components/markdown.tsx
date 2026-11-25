import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * docs/specs/retro-agent.md. A small markdown renderer for the product goal and the retro findings.
 * It builds React elements and never sets HTML, so the input cannot inject markup. It reads
 * headings, paragraphs, lists, quotes, fenced code, rules, inline code, bold, italic and links.
 * A link opens only an http(s) URL or a path on this site; any other link stays plain text.
 */
export function Markdown({ source, className }: { source: string; className?: string }) {
  return <div className={cn("flex min-w-0 flex-col gap-2.5 break-words text-sm text-body", className)}>{blocks(source)}</div>;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "rule" };

const LIST_ITEM = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/;

function parse(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const fence = /^\s{0,3}(```|~~~)/.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trimStart().startsWith(fence[1]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      index += 1;
      out.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      index += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ kind: "rule" });
      index += 1;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index]!)) {
        body.push(lines[index]!.replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      out.push({ kind: "quote", text: body.join(" ") });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[1]!);
      const items: string[] = [];
      while (index < lines.length) {
        const current = LIST_ITEM.exec(lines[index]!);
        if (current && /\d/.test(current[1]!) === ordered) {
          items.push(current[2]!);
        } else if (lines[index]!.trim() !== "" && /^\s+/.test(lines[index]!) && items.length > 0) {
          // An indented line continues the item above.
          items[items.length - 1] += ` ${lines[index]!.trim()}`;
        } else {
          break;
        }
        index += 1;
      }
      out.push({ kind: "list", ordered, items });
      continue;
    }
    const body: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim() !== "" &&
      !/^\s{0,3}(#{1,6}\s|```|~~~|>)/.test(lines[index]!) &&
      !LIST_ITEM.test(lines[index]!)
    ) {
      body.push(lines[index]!.trim());
      index += 1;
    }
    out.push({ kind: "paragraph", text: body.join(" ") });
  }
  return out;
}

const HEADING_CLASS = ["", "text-base", "text-[15px]", "text-sm", "text-sm", "text-sm", "text-sm"];

function blocks(source: string): ReactNode[] {
  return parse(source).map((block, index) => {
    switch (block.kind) {
      case "heading":
        return (
          <p key={index} role="heading" aria-level={Math.min(6, block.level + 2)} className={cn("font-semibold text-ink", HEADING_CLASS[block.level])}>
            {inline(block.text)}
          </p>
        );
      case "paragraph":
        return <p key={index}>{inline(block.text)}</p>;
      case "code":
        return (
          <pre key={index} className="overflow-x-auto rounded-control border border-hairline bg-canvas p-3 font-mono text-xs text-ink">
            {block.text}
          </pre>
        );
      case "quote":
        return (
          <blockquote key={index} className="border-l-2 border-hairline-strong pl-3 text-mute">
            {inline(block.text)}
          </blockquote>
        );
      case "list": {
        const Tag = block.ordered ? "ol" : "ul";
        return (
          <Tag key={index} className={cn("flex flex-col gap-1 pl-5", block.ordered ? "list-decimal" : "list-disc")}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>{inline(item)}</li>
            ))}
          </Tag>
        );
      }
      case "rule":
        return <hr key={index} className="border-hairline" />;
    }
  });
}

const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*|(?<!\w)__[^_]+__(?!\w))|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** A safe href: an http(s) URL or a path on this site. */
function safeHref(raw: string): string | null {
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^\/(?!\/)/.test(raw)) return raw;
  return null;
}

function link(text: ReactNode, href: string, key: number): ReactNode {
  const safe = safeHref(href);
  if (safe === null) return <Fragment key={key}>{text}</Fragment>;
  const external = /^https?:/i.test(safe);
  return (
    <a key={key} href={safe} className="link break-all" {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
      {text}
    </a>
  );
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index;
    if (start > last) out.push(text.slice(last, start));
    const [token, code, strong, anchor, em, url] = match;
    if (code) {
      out.push(
        <code key={key++} className="rounded-[2px] bg-raised px-1 font-mono text-[0.85em] text-ink">
          {code.slice(1, -1)}
        </code>,
      );
    } else if (strong) {
      out.push(
        <strong key={key++} className="font-semibold text-ink">
          {inline(strong.slice(2, -2))}
        </strong>,
      );
    } else if (anchor) {
      const split = anchor.lastIndexOf("](");
      out.push(link(inline(anchor.slice(1, split)), anchor.slice(split + 2, -1), key++));
    } else if (em) {
      out.push(<em key={key++}>{inline(em.slice(1, -1))}</em>);
    } else if (url) {
      out.push(link(url, url, key++));
    } else {
      out.push(token);
    }
    last = start + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
