import { blockersOf, type BlockerReader, type InverseRelationNode, type ReadBlocker } from "~/domain/runs/blocker-wait.js";
import { graphql } from "./linear-issue-status.js";

/**
 * DI-21.87. A page of 25 issues with 50 relations each keeps one query far under Linear's
 * complexity limit. A tenant with more waiting issues reads further pages of the same query.
 */
const ISSUE_PAGE = 25;
const RELATION_PAGE = 50;

/**
 * docs/specs/blocked-by-wait.md. "Blocked by" is each `inverseRelations` node of type `blocks`.
 * The connection takes no filter, so the type is checked in code (schema.graphql, 2026-11-11).
 */
const BLOCKERS_QUERY = `query($ids: [ID!], $after: String) {
  issues(filter: { id: { in: $ids } }, first: ${ISSUE_PAGE}, after: $after) {
    nodes {
      id
      inverseRelations(first: ${RELATION_PAGE}) {
        nodes { type issue { id identifier url state { type } } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface BlockersPage {
  issues: {
    nodes: Array<{ id: string; inverseRelations: { nodes: InverseRelationNode[] } }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/**
 * The blockers of several work items of one workspace, in one batched query per page. An issue the
 * Linear app cannot read is not returned, so it holds nothing.
 */
export const createLinearBlockerReader = (accessToken: string, call: typeof fetch = fetch): BlockerReader => ({
  async read(issueIds) {
    const blockers = new Map<string, ReadBlocker[]>();
    if (issueIds.length === 0) return blockers;
    let after: string | null = null;
    for (;;) {
      const page: BlockersPage = await graphql<BlockersPage>(accessToken, BLOCKERS_QUERY, { ids: [...issueIds], after }, call);
      for (const issue of page.issues.nodes) blockers.set(issue.id, blockersOf(issue.inverseRelations.nodes));
      if (!page.issues.pageInfo.hasNextPage || page.issues.pageInfo.endCursor === null) return blockers;
      after = page.issues.pageInfo.endCursor;
    }
  },
});
