export interface AgentSessionPort {
  acknowledge(sessionId: string, message: string): Promise<void>;
  progress(sessionId: string, message: string): Promise<void>;
  elicit(sessionId: string, question: string): Promise<void>;
  respond(sessionId: string, body: string): Promise<void>;
  fail(sessionId: string, message: string): Promise<void>;
}
