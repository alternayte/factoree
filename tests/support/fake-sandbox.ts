import type {
  Command,
  CommandResult,
  CheckpointRef,
  NetworkPolicy,
  ProcessRef,
  ProcessSnapshot,
  Sandbox,
  SandboxCapabilities,
  SandboxCreateInput,
  SandboxRef,
  ServiceRef,
} from "~/domain/runs/sandbox.js";

interface ScriptedResult {
  matcher: RegExp;
  result: Partial<CommandResult>;
}

/**
 * An in-memory Sandbox. Lifecycle tests assert on `calls`, which records the order of every
 * port method. It records commands; it does not run them.
 */
export class FakeSandbox implements Sandbox {
  readonly name = "fake";
  readonly calls: string[] = [];
  readonly commands: Command[] = [];
  readonly policies: NetworkPolicy[] = [];
  readonly checkpoints: string[] = [];
  readonly destroyed: string[] = [];
  private readonly scripted: ScriptedResult[] = [];
  private counter = 0;
  private readonly processes = new Map<string, ProcessSnapshot>();

  constructor(readonly capabilities: SandboxCapabilities = {
    enforcesNetworkPolicy: true,
    supportsCheckpoints: true,
    supportsExposedServices: true,
  }) {}

  /** The first matcher whose pattern matches `file` plus its arguments wins. */
  scriptExec(matcher: RegExp, result: Partial<CommandResult>): void {
    this.scripted.push({ matcher, result });
  }

  finishProcess(id: string, snapshot: Partial<ProcessSnapshot>): void {
    const current = this.processes.get(id);
    if (current === undefined) throw new Error(`unknown process ${id}`);
    this.processes.set(id, { ...current, running: false, exitCode: 0, ...snapshot });
  }

  create(input: SandboxCreateInput): Promise<SandboxRef> {
    this.calls.push("create");
    this.counter += 1;
    return Promise.resolve({
      id: `fake-${input.runId}-${this.counter}`,
      adapter: this.name,
      workspacePath: "/workspace",
    });
  }

  applyNetworkPolicy(_ref: SandboxRef, policy: NetworkPolicy): Promise<void> {
    this.calls.push("applyNetworkPolicy");
    this.policies.push(policy);
    return Promise.resolve();
  }

  exec(_ref: SandboxRef, command: Command): Promise<CommandResult> {
    this.calls.push(`exec:${command.file}`);
    this.commands.push(command);
    const line = [command.file, ...command.args].join(" ");
    const scripted = this.scripted.find((entry) => entry.matcher.test(line));
    return Promise.resolve({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 1,
      ...scripted?.result,
    });
  }

  startProcess(_ref: SandboxRef, command: Command): Promise<ProcessRef> {
    this.calls.push(`startProcess:${command.file}`);
    this.commands.push(command);
    this.counter += 1;
    const id = `process-${this.counter}`;
    this.processes.set(id, { running: true, exitCode: null, stdout: "", stderr: "" });
    return Promise.resolve({ id });
  }

  readProcess(_ref: SandboxRef, process: ProcessRef): Promise<ProcessSnapshot> {
    const snapshot = this.processes.get(process.id);
    if (snapshot === undefined) throw new Error(`unknown process ${process.id}`);
    return Promise.resolve(snapshot);
  }

  cancelProcess(_ref: SandboxRef, process: ProcessRef): Promise<void> {
    this.calls.push("cancelProcess");
    const snapshot = this.processes.get(process.id);
    if (snapshot !== undefined) {
      this.processes.set(process.id, { ...snapshot, running: false, exitCode: 143 });
    }
    return Promise.resolve();
  }

  checkpoint(_ref: SandboxRef, name: string): Promise<CheckpointRef> {
    this.calls.push(`checkpoint:${name}`);
    this.checkpoints.push(name);
    return Promise.resolve({ id: `checkpoint-${this.checkpoints.length}`, name });
  }

  exposeService(_ref: SandboxRef, port: number): Promise<ServiceRef> {
    this.calls.push(`exposeService:${port}`);
    return Promise.resolve({ port, url: `http://fake.invalid:${port}` });
  }

  destroy(ref: SandboxRef): Promise<void> {
    this.calls.push("destroy");
    this.destroyed.push(ref.id);
    return Promise.resolve();
  }
}
