import { describe, expect, it, vi } from "vitest";
import { LinearAgentClient } from "~/adapters/linear/linear-agent-client.js";

const spyClient = () => {
  const calls: Array<{ agentSessionId: string; content: Record<string, unknown> }> = [];
  return {
    calls,
    createAgentActivity: vi.fn((input: { agentSessionId: string; content: Record<string, unknown> }) => {
      calls.push(input);
      return Promise.resolve({ success: true });
    }),
  };
};

describe("LinearAgentClient", () => {
  it("acknowledges a session with a thought activity", async () => {
    const client = spyClient();
    await new LinearAgentClient(client).acknowledge("session-1", "Factoree accepted the work.");
    expect(client.calls[0]).toEqual({
      agentSessionId: "session-1",
      content: { type: "thought", body: "Factoree accepted the work." },
    });
  });

  it("reports progress with a thought activity", async () => {
    const client = spyClient();
    await new LinearAgentClient(client).progress("session-1", "Resolving context.");
    expect(client.calls[0]?.content).toEqual({ type: "thought", body: "Resolving context." });
  });

  it("asks a question with an elicitation activity", async () => {
    const client = spyClient();
    await new LinearAgentClient(client).elicit("session-1", "Which database?");
    expect(client.calls[0]?.content).toEqual({ type: "elicitation", body: "Which database?" });
  });

  it("sends the final result with a response activity", async () => {
    const client = spyClient();
    await new LinearAgentClient(client).respond("session-1", "Proof Pack");
    expect(client.calls[0]?.content).toEqual({ type: "response", body: "Proof Pack" });
  });

  it("reports a failure with an error activity", async () => {
    const client = spyClient();
    await new LinearAgentClient(client).fail("session-1", "Run failed.");
    expect(client.calls[0]?.content).toEqual({ type: "error", body: "Run failed." });
  });
});
