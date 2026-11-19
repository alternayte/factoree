const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The text blocks of one Claude assistant message, in order. A plain string `content` is one
 * block. A tool use block, a thinking block and every other block carry no text and are ignored.
 */
export const assistantTextBlocks = (message: unknown): string[] => {
  if (!isRecord(message)) return [];
  const content = message["content"];
  if (typeof content === "string") return content.length > 0 ? [content] : [];
  if (!Array.isArray(content)) return [];
  const blocks: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block["type"] !== "text") continue;
    const text = block["text"];
    if (typeof text === "string" && text.length > 0) blocks.push(text);
  }
  return blocks;
};

/** Joins every text block of one assistant message, or null when it has none. */
export const assistantText = (message: unknown): string | null => {
  const blocks = assistantTextBlocks(message);
  return blocks.length === 0 ? null : blocks.join("\n");
};
