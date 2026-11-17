import { describe, expect, it } from "vitest";
import { checkGroupsOf, serviceForwardPortsOf, setServerOf, stackHostsOf, wireTargets, type SetCheckTarget } from "~/domain/runs/set-check.js";
import { fakesOfComposeConfig, stackOfComposeConfig } from "~/domain/runs/services.js";
import { parseValidationPlan, ValidationPlanInvalidError, type PlanTargetRules } from "~/domain/validation/validation-plan.js";
import type { ValidationContract } from "~/domain/validation/validation-contract.js";
import { runSetUserValidation, inBetweenConsumersOf } from "~/domain/validation/set-validation.js";
import { FakeSandbox } from "../support/fake-sandbox.js";
import { Redactor } from "~/telemetry/redaction.js";
import { createLogger } from "~/telemetry/logger.js";
import type { UserValidatorDependencies } from "~/domain/validation/user-validator.js";

const preview = (port: number) => ({ enabled: true, command: "npm start", readyUrl: `http://localhost:${String(port)}/`, timeoutSeconds: 30 });
const SERVICES = { compose: "docker-compose.yml", profiles: [], seed: null, waitTimeoutSeconds: 60 };

const target = (repository: string, over: Partial<SetCheckTarget> = {}): SetCheckTarget => ({
  repository,
  path: `/workspace/targets/${repository}`,
  baseSha: "b".repeat(40),
  services: null,
  preview: null,
  accounts: [],
  environment: { MISE_CONFIG_FILE: `/workspace/targets/${repository}/.factoree/mise.toml` },
  fakes: [],
  bootstrapCommand: null,
  verifyCommands: [],
  ...over,
});

describe("the compose fakes of a change set (docs/specs/change-sets.md, DI-21.145)", () => {
  it("reads the repository label and the published ports of a fake", () => {
    const json = JSON.stringify({
      services: {
        api: { labels: { "factoree.fake": "Acme API", "factoree.fake.repository": "acme/api" }, ports: [{ target: 8080, published: "4010", protocol: "tcp" }] },
        mail: { labels: ["factoree.fake=Mailgun"] },
      },
    });
    expect(fakesOfComposeConfig(json)).toEqual([
      { service: "api", name: "Acme API", repository: "acme/api", ports: [4010], containerPorts: [8080] },
      { service: "mail", name: "Mailgun" },
    ]);
  });
});

describe("wireTargets (DI-21.146, DI-21.148)", () => {
  const api = target("acme/api", { preview: preview(5000) });
  const fake = { service: "api-fake", name: "Acme API", repository: "ACME/api", ports: [4010] };
  const web = target("acme/web", { preview: preview(3000), fakes: [fake] });
  const docs = target("acme/docs", { preview: preview(3001) });

  it("wires the consumer to the provider its fake names, and leaves every other target alone", () => {
    const wired = wireTargets([api, web, docs]);
    expect(wired).toEqual({ pairs: [{ provider: "acme/api", consumer: "acme/web", fake: "api-fake", ports: [4010] }], alone: [] });
    expect(checkGroupsOf([api, web, docs], wired.pairs)).toEqual([["acme/api", "acme/web"], ["acme/docs"]]);
    expect(setServerOf({ targets: [api, web, docs], pairs: wired.pairs })).toBe("acme/web");
  });

  it("tests a pair alone when its snapshot could not start it, when no port can answer, or when two ports collide", () => {
    expect(wireTargets([api, web], [{ provider: "acme/api", consumer: "acme/web", fake: "api-fake", reason: "the sandbox ran out of memory" }])).toEqual({
      pairs: [],
      alone: [{ provider: "acme/api", consumer: "acme/web", fake: "api-fake", reason: "the sandbox ran out of memory" }],
    });
    expect(wireTargets([target("acme/api"), web]).alone[0]?.reason).toContain("no enabled preview");
    expect(wireTargets([api, target("acme/web", { fakes: [{ ...fake, ports: [] }] })]).alone[0]?.reason).toContain("publishes no port");
    const collides = wireTargets([api, target("acme/web", { preview: preview(5000), fakes: [fake] })]);
    expect(collides.pairs).toEqual([]);
    expect(collides.alone[0]?.reason).toContain("both use port 5000");
    expect(setServerOf({ targets: [api, web], pairs: collides.pairs })).toBeNull();
  });
});

describe("the path by the fake's service name (DI-21.150)", () => {
  const api = target("acme/api", { preview: preview(5000) });
  const byNameOnly = { service: "api-fake", name: "Acme API", repository: "acme/api", containerPorts: [8080] };

  it("reads the container ports of a fake and the services that take host entries", () => {
    const json = JSON.stringify({
      services: {
        app: {},
        sidecar: { network_mode: "service:app" },
        "api-fake": { labels: { "factoree.fake": "Acme API" }, ports: [{ target: 8080, published: "4010" }], expose: ["9090/tcp"] },
      },
    });
    expect(stackOfComposeConfig(json)).toEqual({
      fakes: [{ service: "api-fake", name: "Acme API", ports: [4010], containerPorts: [8080, 9090] }],
      hostServices: ["api-fake", "app"],
    });
  });

  it("wires a fake that publishes no port through its service name, and only when the sandbox has an address", () => {
    const web = target("acme/web", { preview: preview(3000), fakes: [byNameOnly], hostServices: ["api-fake", "app", "worker"] });
    const wired = wireTargets([api, web], [], "10.0.0.7");
    expect(wired).toEqual({
      pairs: [{ provider: "acme/api", consumer: "acme/web", fake: "api-fake", ports: [], byName: { address: "10.0.0.7", ports: [8080] } }],
      alone: [],
    });
    expect(stackHostsOf(web, wired.pairs)).toEqual({ services: ["app", "worker"], entries: ["api-fake:10.0.0.7"] });
    expect(wireTargets([api, web]).alone[0]?.reason).toContain("no network address");
    const silent = target("acme/web", { fakes: [{ ...byNameOnly, containerPorts: [] }] });
    expect(wireTargets([api, silent], [], "10.0.0.7").alone[0]?.reason).toContain("declares no container port");
  });

  it("forwards each container port that no published forward and no preview already serves", () => {
    const pair = { provider: "acme/api", consumer: "acme/web", fake: "api-fake", ports: [4010], byName: { address: "10.0.0.7", ports: [4010, 5000, 8080] } };
    expect(serviceForwardPortsOf(pair, preview(5000))).toEqual([8080]);
    const collides = wireTargets([api, target("acme/web", { preview: preview(8080), fakes: [{ ...byNameOnly, containerPorts: [8080] }] })], [], "10.0.0.7");
    expect(collides.pairs).toEqual([]);
    expect(collides.alone[0]?.reason).toContain("both use port 8080");
  });
});

describe("a Validation Plan of a change set (DI-21.147)", () => {
  const contract: ValidationContract = {
    version: 1,
    runId: "run-1",
    workItem: "FAC-1",
    goal: "Rename the endpoint.",
    assertions: [
      { id: "VAL-1", requirement: "AC-1", statement: "The page lists orders.", method: "browser", evidence: ["screenshot"], preconditions: [] },
    ],
  };
  const rules: PlanTargetRules = {
    targets: [
      { repository: "acme/api", accounts: [] },
      { repository: "acme/web", accounts: ["member"] },
    ],
    setServer: null,
  };
  const plan = (entry: Record<string, unknown>) =>
    JSON.stringify({ version: 1, entries: [{ assertionId: "VAL-1", kind: "browser", steps: [{ action: "goto", path: "/" }, { action: "expectVisible", selector: "text=Orders" }], ...entry }] });
  const reasons = (text: string, given = rules): string[] => {
    try {
      parseValidationPlan(text, contract, [], given);
      return [];
    } catch (error) {
      if (error instanceof ValidationPlanInvalidError) return error.reasons;
      throw error;
    }
  };

  it("needs a target on each entry, and checks the account against that target", () => {
    expect(reasons(plan({ target: "acme/web", as: "member" }))).toEqual([]);
    expect(reasons(plan({}))[0]).toContain("names no target");
    expect(reasons(plan({ target: "acme/other" }))[0]).toContain("not a target of this run");
    expect(reasons(plan({ target: "acme/api", as: "member" }))[0]).toContain('signs in as "member"');
  });

  it("allows the set only when one wired group serves it", () => {
    expect(reasons(plan({ target: "set" }))[0]).toContain("no wired pair");
    expect(reasons(plan({ target: "set", as: "member" }), { ...rules, setServer: "acme/web" })).toEqual([]);
  });
});

describe("runSetUserValidation (DI-21.146, DI-21.149)", () => {
  const ref = { id: "check-1", adapter: "fake", workspacePath: "/workspace" };
  const BASE = "c".repeat(40);
  const contract: ValidationContract = {
    version: 1,
    runId: "run-1",
    workItem: "FAC-1",
    goal: "Rename the endpoint.",
    assertions: [
      { id: "VAL-API", requirement: "AC-1", statement: "The API answers.", method: "command", evidence: ["command-output"], preconditions: [] },
      { id: "VAL-WEB", requirement: "AC-2", statement: "The web tests pass.", method: "command", evidence: ["command-output"], preconditions: [] },
    ],
  };
  const planText = JSON.stringify({
    version: 1,
    entries: [
      { assertionId: "VAL-API", kind: "command", target: "acme/api", command: { run: "npm run check-api", expectExitCode: 0 } },
      { assertionId: "VAL-WEB", kind: "command", target: "acme/web", command: { run: "npm run check-web", expectExitCode: 0 } },
    ],
  });
  const api = target("acme/api", { baseSha: BASE, services: { ...SERVICES, project: "acme-api" } });
  const web = target("acme/web", {
    baseSha: BASE,
    services: { ...SERVICES, project: "acme-web" },
    bootstrapCommand: "npm ci",
    verifyCommands: [{ name: "acme/web: test", run: "npm test", workingDirectory: "/workspace/targets/acme/web", env: {} }],
  });

  const run = async (webAtBaseFails: boolean) => {
    const sandbox = new FakeSandbox();
    let webAtBase = false;
    sandbox.onExec = (command) => {
      const line = `${command.cwd ?? ""}|${command.file} ${command.args.join(" ")}`;
      if (command.file === "/usr/bin/git" && command.args.includes("reset") && command.args.includes("--hard") && line.includes("acme/web")) webAtBase = true;
      if (command.file === "/usr/bin/git" && command.args.includes("apply")) webAtBase = false;
      if (command.file === "/bin/sh" && command.args[1] === 'base64 < "$0"') return { exitCode: 0, stdout: "ZGlmZgo=", stderr: "" };
      if (command.file === "/usr/bin/git" && command.args.includes("write-tree")) return { exitCode: 0, stdout: `${"d".repeat(40)}\n`, stderr: "" };
      if (line.startsWith("/workspace/targets/acme/web|sh -c npm test") && webAtBase && webAtBaseFails) return { exitCode: 1, stdout: "", stderr: "GET /orders 404" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const redactor = new Redactor();
    const dependencies = {
      sandbox,
      browser: {} as UserValidatorDependencies["browser"],
      fetchImpl: (() => Promise.reject(new Error("no fetch"))) as unknown as UserValidatorDependencies["fetchImpl"],
      probe: () => Promise.resolve(null),
      redactor,
      logger: createLogger({ level: "error", redactor }),
    };
    const outcome = await runSetUserValidation(dependencies, {
      runId: "run-1",
      tenantId: "tenant-1",
      ref,
      targetsPath: "/workspace/targets",
      contract,
      planText,
      environment: {},
      timeoutMs: 60_000,
      facts: { targets: [api, web], pairs: [], alone: [] },
      edges: [{ provider: "acme/api", consumer: "acme/web" }],
      changed: ["acme/api", "acme/web"],
    });
    const lines = sandbox.commands.map((command) => `${command.cwd ?? ""}|${command.file} ${command.args.join(" ")}`);
    return { outcome, lines };
  };

  it("runs each target with its own stack alone, one after the other", async () => {
    const { outcome, lines } = await run(false);
    expect(outcome.passed).toBe(true);
    const order = lines.filter((line) => line.includes("compose -p") || line.includes("npm run check-"));
    expect(order.map((line) => line.replace(/ -f .*?(up|stop).*/, " $1"))).toEqual([
      "/workspace/targets/acme/api|docker compose -p acme-api up",
      "/workspace/targets/acme/api|sh -c npm run check-api",
      "/workspace/targets/acme/api|docker compose -p acme-api stop",
      "/workspace/targets/acme/web|docker compose -p acme-web up",
      "/workspace/targets/acme/web|sh -c npm run check-web",
      "/workspace/targets/acme/web|docker compose -p acme-web stop",
      // The in-between check: the consumer at its base, its bootstrap and its verify commands.
      "/workspace/targets/acme/web|docker compose -p acme-web up",
      "/workspace/targets/acme/web|docker compose -p acme-web stop",
    ]);
  });

  it("resets the consumer to its base with the provider patch kept, and a failure is a repair finding that names both", async () => {
    const { outcome, lines } = await run(true);
    expect(outcome.passed).toBe(false);
    expect(outcome.outcomes.every((entry) => entry.result === "PASS")).toBe(true);
    expect(outcome.inBetweenFailures).toHaveLength(1);
    expect(outcome.inBetweenFailures[0]).toContain(`the patch of acme/api breaks acme/web at its base ${BASE.slice(0, 7)}`);
    expect(outcome.inBetweenFailures[0]).toContain('"acme/web: test" exited 1');
    expect(outcome.failures).toContain(outcome.inBetweenFailures[0]);
    const reset = lines.findIndex((line) => line.includes(`-C /workspace/targets/acme/web reset -q --hard ${BASE}`));
    const bootstrap = lines.findIndex((line) => line.startsWith("/workspace/targets/acme/web|sh -c") && line.includes("npm ci"));
    const verify = lines.findIndex((line) => line.startsWith("/workspace/targets/acme/web|sh -c npm test"));
    const restored = lines.findLastIndex((line) => line.includes("-C /workspace/targets/acme/web apply --binary"));
    expect(reset).toBeGreaterThan(-1);
    expect(bootstrap).toBeGreaterThan(reset);
    expect(verify).toBeGreaterThan(bootstrap);
    expect(restored).toBeGreaterThan(verify);
    // The provider is never reset.
    expect(lines.some((line) => line.includes("-C /workspace/targets/acme/api reset"))).toBe(false);
  });

  it("lists no fake that a wired provider answered for, and names the target of each other fake", async () => {
    const sandbox = new FakeSandbox();
    const redactor = new Redactor();
    const replacedFake = { service: "api-fake", name: "Acme API", repository: "acme/api", ports: [4010] };
    const mail = { service: "mail", name: "Mailgun" };
    const outcome = await runSetUserValidation(
      {
        sandbox,
        browser: {} as UserValidatorDependencies["browser"],
        fetchImpl: () => Promise.reject(new Error("no fetch")),
        probe: () => Promise.resolve(null),
        redactor,
        logger: createLogger({ level: "error", redactor }),
      },
      {
        runId: "run-1",
        tenantId: "tenant-1",
        ref,
        targetsPath: "/workspace/targets",
        contract,
        planText: null,
        environment: {},
        timeoutMs: 60_000,
        facts: {
          targets: [target("acme/api", { preview: preview(5000) }), target("acme/web", { fakes: [replacedFake, mail] })],
          pairs: [{ provider: "acme/api", consumer: "acme/web", fake: "api-fake", ports: [4010] }],
          alone: [],
        },
        edges: [],
        changed: [],
      },
    );
    expect(outcome.fakes).toEqual([{ ...mail, target: "acme/web" }]);
    expect(outcome.outcomes.every((entry) => entry.result === "BLOCKED")).toBe(true);
  });

  it("checks the base of a consumer only when it and one of its providers changed", () => {
    const facts = { targets: [api, web], pairs: [] };
    expect(inBetweenConsumersOf(facts, [{ provider: "acme/api", consumer: "acme/web" }], ["acme/api", "acme/web"])).toEqual([
      { consumer: "acme/web", providers: ["acme/api"] },
    ]);
    expect(inBetweenConsumersOf(facts, [{ provider: "acme/api", consumer: "acme/web" }], ["acme/api"])).toEqual([]);
    expect(inBetweenConsumersOf(facts, [{ provider: "acme/api", consumer: "acme/web" }], ["acme/web"])).toEqual([]);
  });
});
