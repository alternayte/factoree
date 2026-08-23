/**
 * SDD section 18 forbids unbounded retrieval. A timeout bounds how long a remote answer takes;
 * it does not bound how large that answer is. A remote catalog or MCP server is untrusted, so
 * every HTTP client of an adapter reads its body through this reader, which stops at a cap.
 *
 * The reader answers `null` when the answer passes the cap. The caller then raises its own error
 * type, which names the safe URL and the cap and never the body.
 */
export const readTextWithCap = async (response: Response, maxBytes: number): Promise<string | null> => {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      // The declared length already fails the cap, so the body is never read. Cancel it so
      // undici releases the connection instead of holding it until the garbage collector runs.
      // `catch` guards a body that is absent or already cancelled, which must not throw here.
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
  }

  const body = response.body;
  if (body === null) {
    // A runtime without a body stream, or an answer with no body at all. The declared length
    // check above already ran, and the text below is still measured against the cap.
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") > maxBytes ? null : text;
  }

  // A chunked answer carries no `Content-Length`, so the cap is enforced while reading.
  // The body stream is typed loosely across runtimes, so it is narrowed to the byte stream it is.
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
};
