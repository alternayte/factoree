import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agentSessionEventSchema,
  classifyAgentSessionEvent,
} from "~/adapters/linear/webhook-schemas.js";

const load = (name: string): unknown =>
  JSON.parse(readFileSync(`tests/fixtures/linear/${name}.json`, "utf8")) as unknown;

describe("agentSessionEventSchema", () => {
  it("parses a delegation event", () => {
    const event = agentSessionEventSchema.parse(load("agent-session-created"));
    expect(event.action).toBe("created");
    expect(event.organizationId).toBe("workspace-123");
    expect(event.agentSession.id).toBe("session-1");
    expect(event.agentSession.issue?.teamId).toBe("team-1");
    expect(classifyAgentSessionEvent(event)).toEqual({ kind: "delegation" });
  });

  it("parses a stop event", () => {
    const event = agentSessionEventSchema.parse(load("agent-session-prompted-stop"));
    expect(classifyAgentSessionEvent(event)).toEqual({ kind: "stop" });
  });

  it("classifies a follow-up prompt", () => {
    const raw = load("agent-session-prompted-stop") as Record<string, unknown>;
    const event = agentSessionEventSchema.parse({
      ...raw,
      agentActivity: { id: "activity-2", content: { type: "prompt", body: "please use Postgres" } },
    });
    expect(classifyAgentSessionEvent(event)).toEqual({ kind: "prompt", body: "please use Postgres" });
  });

  it("ignores an unknown action", () => {
    const raw = load("agent-session-created") as Record<string, unknown>;
    const event = agentSessionEventSchema.parse({ ...raw, action: "archived" });
    expect(classifyAgentSessionEvent(event).kind).toBe("ignore");
  });

  it("rejects a payload without an agent session", () => {
    const raw = load("agent-session-created") as Record<string, unknown>;
    delete raw.agentSession;
    expect(() => agentSessionEventSchema.parse(raw)).toThrow();
  });

  it("keeps unknown fields out of the parsed value", () => {
    const raw = load("agent-session-created") as Record<string, unknown>;
    const event = agentSessionEventSchema.parse({ ...raw, futureField: "ignored" });
    expect(event).not.toHaveProperty("futureField");
  });
});
