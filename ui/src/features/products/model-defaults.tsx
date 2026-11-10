import { useQuery } from "@tanstack/react-query";
import { listProductAgentSessionsOptions } from "@/api/@tanstack/react-query.gen";
import { Alert, Badge, Empty, ErrorAlert, Section, SkeletonRows } from "@/components/layout";
import { formatDate } from "@/lib/utils";

/**
 * Issue 6. What an empty field means. With no model, the opencode runner passes no --model
 * (src/adapters/runners/opencode/opencode-runner.ts), so opencode picks its own default, and the
 * claude runner passes no --model, so Claude Code picks its own. With no effort neither runner
 * passes one, so the model uses its default effort.
 */
export const DEFAULT_MODEL = {
  opencode: "opencode default, with no --model",
  claude: "Claude Code default, with no --model",
} as const;
/** docs/specs/claude-code-runner.md, the same lists as src/domain/products/agent-settings.ts. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CLAUDE_MODELS = ["opus", "sonnet", "haiku", "fable"] as const;
export const DEFAULT_EFFORT = "model default";

export function ModelWarning({ hasRunnerCredential, className }: { hasRunnerCredential: boolean; className?: string }) {
  return (
    <Alert tone="warning" title="This product sets no model" className={className}>
      {hasRunnerCredential ? (
        <p>
          opencode runs with no --model and picks its own default. The default depends on the providers that opencode
          has a credential for. Set a model, so that each run uses the model you expect.
        </p>
      ) : (
        <p>
          opencode runs with no --model and picks its own default. The product holds no runner credential, so the
          default can be a free model with a quota. A run can hang when the quota ends. Set a model and add a runner
          credential under Secrets.
        </p>
      )}
    </Alert>
  );
}

const OUTCOME_TONE = { finished: "success", hung: "danger", failed: "danger" } as const;

const SHOWN = 10;

/** Issue 6. The models and the efforts the newest sessions of the product really ran with. */
export function RecentSessionsSection({ productId, linearWorkspaceId }: { productId: string; linearWorkspaceId: string }) {
  const sessions = useQuery(
    listProductAgentSessionsOptions({ path: { id: productId }, query: { linearWorkspaceId, limit: SHOWN } }),
  );
  return (
    <Section
      title="Recent agent sessions"
      description="The model and the effort that each of the last sessions ran with. The model is the one the runner reported."
      flush={Boolean(sessions.data?.length)}
    >
      {sessions.isPending ? <SkeletonRows label="Loading the agent sessions" /> : null}
      <ErrorAlert error={sessions.error} title="The agent sessions did not load" />
      {sessions.data?.length === 0 ? <Empty>No agent session ran for this product yet.</Empty> : null}
      {sessions.data && sessions.data.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Role</th>
                <th>Model</th>
                <th>Effort</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {sessions.data.map((session) => (
                <tr key={session.id}>
                  <td className="whitespace-nowrap text-body">{formatDate(session.createdAt)}</td>
                  <td className="t-value">
                    <span className="block text-ink">{session.role}</span>
                    <span className="block text-mute">{session.runner}</span>
                  </td>
                  <td className="t-value whitespace-nowrap">
                    {session.model ? <span className="text-ink">{session.model}</span> : <span className="text-mute">not reported</span>}
                  </td>
                  <td className="t-value">
                    {session.effort ? <span className="text-ink">{session.effort}</span> : <span className="text-mute">default</span>}
                  </td>
                  <td>
                    <Badge tone={OUTCOME_TONE[session.outcome]}>{session.outcome}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Section>
  );
}
