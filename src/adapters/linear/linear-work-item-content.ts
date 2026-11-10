import type { WorkItemComment } from "~/domain/context/work-item-content.js";

const GRAPHQL_URL = "https://api.linear.app/graphql";
const TIMEOUT_MS = 15_000;
/** One image of 10 MiB on a slow link. */
const IMAGE_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const COMMENT_PAGE = 100;

const graphql = async <T>(accessToken: string, query: string, variables: Record<string, unknown>, call: typeof fetch): Promise<T> => {
  const response = await call(GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as { data?: T | null; errors?: Array<{ message?: unknown }> };
  if (!response.ok || body.errors !== undefined || body.data === undefined || body.data === null) {
    const said = body.errors?.map((error) => (typeof error.message === "string" ? error.message : "")).filter(Boolean).join("; ") ?? "";
    throw new Error(`the Linear API answered ${response.status}${said === "" ? "" : `: ${said}`}`);
  }
  return body.data;
};

interface CommentNode {
  id: string;
  body: string | null;
  createdAt: string;
  parent: { id: string } | null;
  agentSession: { id: string } | null;
  botActor: { id: string | null } | null;
  user: { name: string | null; displayName: string | null; app: boolean | null } | null;
  externalUser: { name: string | null } | null;
}

const COMMENTS_QUERY = `query($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: ${COMMENT_PAGE}, after: $after) {
      nodes {
        id body createdAt
        parent { id }
        agentSession { id }
        botActor { id }
        user { name displayName app }
        externalUser { name }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const ISSUE_QUERY = "query($id: String!) { issue(id: $id) { identifier title description } }";

/**
 * Reads the bytes of one URL with the Linear token. A redirect is followed by hand and only on the
 * same host, so the token never reaches another host and the worker never reads one
 * (docs/specs/work-item-images-and-links.md). The body stops at `maxBytes`.
 */
const download = async (accessToken: string, url: string, maxBytes: number, call: typeof fetch): Promise<Uint8Array> => {
  const signal = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
  let current = new URL(url);
  const host = current.host;
  for (let redirects = 0; ; redirects += 1) {
    const response = await call(current.href, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "manual",
      signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (location === null) throw new Error(`the image URL answered ${response.status} without a location`);
      const next = new URL(location, current);
      if (next.host !== host || next.protocol !== "https:") {
        throw new Error(`the image URL redirects to ${next.host}, and Factoree refuses a redirect to another host`);
      }
      if (redirects >= MAX_REDIRECTS) throw new Error(`the image URL redirects more than ${MAX_REDIRECTS} times`);
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`the image URL answered ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      throw new Error(`the image is ${declared} bytes, more than ${maxBytes}`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body !== null) {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`the image is more than ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
};

/**
 * docs/specs/work-item-images-and-links.md. The Linear reads of one workspace: the comments of an
 * issue, one linked issue, and one uploaded image. The token is the install's Linear token of
 * that workspace, and it never leaves the worker.
 */
export const createLinearWorkItemReader = (accessToken: string, call: typeof fetch = fetch) => ({
  async comments(issueId: string): Promise<WorkItemComment[]> {
    const comments: WorkItemComment[] = [];
    let after: string | null = null;
    for (;;) {
      const data: {
        issue: { comments: { nodes: CommentNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null;
      } = await graphql(accessToken, COMMENTS_QUERY, { id: issueId, after }, call);
      if (data.issue === null) throw new Error(`the Linear API knows no issue ${issueId}`);
      for (const node of data.issue.comments.nodes) {
        comments.push({
          id: node.id,
          body: node.body ?? "",
          createdAt: node.createdAt,
          author: node.user?.displayName ?? node.user?.name ?? node.externalUser?.name ?? "an unknown author",
          bot: node.botActor !== null || node.user?.app === true || (node.user === null && node.externalUser === null),
          agentSessionId: node.agentSession?.id ?? null,
          parentId: node.parent?.id ?? null,
        });
      }
      const page = data.issue.comments.pageInfo;
      if (!page.hasNextPage || page.endCursor === null) return comments;
      after = page.endCursor;
    }
  },

  async issue(identifier: string): Promise<{ title: string; content: string }> {
    const data = await graphql<{ issue: { identifier: string; title: string; description: string | null } | null }>(
      accessToken,
      ISSUE_QUERY,
      { id: identifier },
      call,
    );
    if (data.issue === null) throw new Error(`the Linear API knows no issue ${identifier}`);
    const title = `${data.issue.identifier} ${data.issue.title}`;
    return { title, content: `# ${title}\n\n${data.issue.description ?? ""}`.trimEnd() + "\n" };
  },

  downloadImage: (url: string, maxBytes: number): Promise<Uint8Array> => download(accessToken, url, maxBytes, call),
});
