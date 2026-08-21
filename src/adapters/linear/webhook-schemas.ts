import { z } from "zod";

const issueSchema = z.object({
  id: z.string(),
  identifier: z.string().optional(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  teamId: z.string().optional(),
  url: z.string().optional(),
});

const agentSessionSchema = z.object({
  id: z.string(),
  appUserId: z.string().optional(),
  organizationId: z.string().optional(),
  issueId: z.string().nullable().optional(),
  commentId: z.string().nullable().optional(),
  creatorId: z.string().nullable().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  url: z.string().nullable().optional(),
  issue: issueSchema.nullable().optional(),
  creator: z.object({ id: z.string(), name: z.string().optional() }).nullable().optional(),
});

const agentActivitySchema = z.object({
  id: z.string().optional(),
  signal: z.string().nullable().optional(),
  content: z
    .object({ type: z.string().optional(), body: z.string().optional() })
    .nullable()
    .optional(),
});

export const agentSessionEventSchema = z.object({
  type: z.literal("AgentSessionEvent"),
  action: z.string(),
  organizationId: z.string(),
  oauthClientId: z.string().optional(),
  appUserId: z.string().optional(),
  webhookId: z.string().optional(),
  webhookTimestamp: z.number().optional(),
  promptContext: z.string().nullable().optional(),
  agentActivity: agentActivitySchema.nullable().optional(),
  agentSession: agentSessionSchema,
});

export type AgentSessionEvent = z.infer<typeof agentSessionEventSchema>;

export type AgentSessionCommand =
  | { kind: "delegation" }
  | { kind: "prompt"; body: string }
  | { kind: "stop" }
  | { kind: "ignore"; reason: string };

export const classifyAgentSessionEvent = (event: AgentSessionEvent): AgentSessionCommand => {
  if (event.action === "created") return { kind: "delegation" };
  if (event.action !== "prompted") return { kind: "ignore", reason: `unsupported action ${event.action}` };
  if (event.agentActivity?.signal === "stop") return { kind: "stop" };
  return { kind: "prompt", body: event.agentActivity?.content?.body ?? "" };
};
