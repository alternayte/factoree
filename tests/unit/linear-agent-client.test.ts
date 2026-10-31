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
    issue: vi.fn(() => Promise.resolve(null)),
    updateAgentSession: vi.fn(() => Promise.resolve({ success: true })),
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

  it("adds a link to the session without replacing the links it holds", async () => {
    const client = spyClient();
    await new LinearAgentClient(client).addLink("session-1", "Pull request", "https://github.com/acme/api/pull/1");
    expect(client.updateAgentSession).toHaveBeenCalledWith("session-1", {
      addedExternalUrls: [{ label: "Pull request", url: "https://github.com/acme/api/pull/1" }],
    });
  });
});

describe("the Work Item labels of SDD section 28 and its Linear project", () => {
  it("reads the label names and the project name of one issue", async () => {
    const client = new LinearAgentClient({
      createAgentActivity: () => Promise.resolve({}),
      updateAgentSession: () => Promise.resolve({}),
      issue: () =>
        Promise.resolve({
          labels: () => Promise.resolve({ nodes: [{ name: "security" }, { name: "backend" }] }),
          project: Promise.resolve({ name: "Dashboard" }),
        }),
    });
    expect(await client.facts("issue-1")).toEqual({ labels: ["security", "backend"], project: "Dashboard" });
  });

  it("reports no label when the issue does not exist", async () => {
    const client = new LinearAgentClient({
      createAgentActivity: () => Promise.resolve({}),
      updateAgentSession: () => Promise.resolve({}),
      issue: () => Promise.resolve(null),
    });
    expect(await client.facts("issue-1")).toEqual({ labels: [], project: null });
  });
});
