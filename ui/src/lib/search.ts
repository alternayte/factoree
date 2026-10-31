/** The product pages name the Linear workspace in ?ws=. */
export type WsSearch = { ws?: string };

export function wsSearch(search: Record<string, unknown>): WsSearch {
  return typeof search.ws === "string" && search.ws ? { ws: search.ws } : {};
}
