import { describe, expect, it } from "vitest";
import { KilnClient } from "~/adapters/sandbox/kiln/kiln-client.js";
import { KilnSandbox } from "~/adapters/sandbox/kiln/kiln-sandbox.js";
import {
  basicOf,
  bindingsOf,
  credentialHostsOf,
  hostCredentialOf,
  realmOf,
  resolveHostCredentials,
  validateHostCredentials,
  type HostCredential,
  type HostCredentialAccess,
} from "~/domain/products/host-credentials.js";
import { applyEgress } from "~/domain/runs/credential-egress.js";
import { RunConfigurationError } from "~/domain/runs/run-configuration-error.js";
import { SandboxManager } from "~/domain/runs/sandbox-manager.js";
import { DEFAULT_PROJECT_DEFAULTS } from "~/domain/runs/project-runtime-config.js";
import { bootstrapKeyOf } from "~/domain/runs/warm-snapshot.js";
import { renderSetupPrompt } from "~/prompts/setup.js";
import { FakeSandbox } from "../support/fake-sandbox.js";

const IMAGE = `ghcr.io/alternayte/factoree-sandbox@sha256:${"c".repeat(64)}`;

const credential = (fields: Partial<HostCredential>): HostCredential => ({
  kind: "header",
  host: "npm.pkg.github.com",
  username: null,
  headerName: "Authorization",
  pathPrefix: null,
  realmHost: null,
  realmPath: null,
  redirectHosts: [],
  repositories: [],
  githubInstallationId: null,
  ...fields,
});

describe("host credential bindings (docs/specs/host-credentials.md)", () => {
  it("binds a registry login on its token service only, so the bearer token on /v2/ stays", () => {
    const ghcr = credential({ kind: "registry", host: "ghcr.io", username: "bot", headerName: null, realmHost: "ghcr.io", realmPath: "/token" });
    expect(bindingsOf(ghcr, "pat")).toEqual([
      { name: "registry:ghcr.io", host: "ghcr.io", header: "Authorization", value: basicOf("bot", "pat"), path: "/token", methods: ["GET", "HEAD"] },
    ]);
    const basicOnly = credential({ kind: "registry", host: "registry.acme.dev", username: "bot", headerName: null });
    expect(bindingsOf(basicOnly, "pat")).toEqual([
      { name: "registry:registry.acme.dev", host: "registry.acme.dev", header: "Authorization", value: basicOf("bot", "pat"), path: "/v2/", methods: ["GET", "HEAD"] },
    ]);
  });

  it("binds a github token as x-access-token Basic with POST, which a git fetch needs", () => {
    const github = credential({ kind: "github", host: "github.com", headerName: null, repositories: ["acme/lib"], githubInstallationId: "9" });
    expect(bindingsOf(github, "ghs_x")).toEqual([
      { name: "github:github.com", host: "github.com", header: "Authorization", value: basicOf("x-access-token", "ghs_x"), methods: ["GET", "HEAD", "POST"] },
    ]);
  });

  it("sends a header secret as entered, on its path prefix", () => {
    const nuget = credential({ host: "nuget.pkg.github.com", pathPrefix: "/acme/" });
    expect(bindingsOf(nuget, "Basic abc")).toEqual([
      { name: "header:nuget.pkg.github.com", host: "nuget.pkg.github.com", header: "Authorization", value: "Basic abc", path: "/acme/", methods: ["GET", "HEAD"] },
    ]);
  });

  it("reads the token service from a Bearer challenge and none from a Basic one", () => {
    expect(realmOf('Bearer realm="https://auth.docker.io/token",service="registry.docker.io"')).toEqual({ host: "auth.docker.io", path: "/token" });
    expect(realmOf('Basic realm="Registry"')).toBeNull();
  });

  it("refuses a wildcard host, more than 8 credentials, and a missing secret", () => {
    expect(validateHostCredentials([{ kind: "header", host: "*.pkg.github.com", headerName: "Authorization", secret: "x" }], new Set())).toEqual([
      'Host credential 1: "*.pkg.github.com" is not one exact host name. A wildcard is not allowed.',
    ]);
    const many = Array.from({ length: 9 }, (_, index) => ({ kind: "header" as const, host: `feed${index}.acme.dev`, headerName: "Authorization", secret: "x" }));
    expect(validateHostCredentials(many, new Set())).toContain("A product holds at most 8 host credentials.");
    expect(validateHostCredentials([{ kind: "header", host: "feed.acme.dev", headerName: "Authorization" }], new Set())).toEqual([
      "Host credential 1: a header credential needs a secret.",
    ]);
    expect(validateHostCredentials([{ kind: "header", host: "feed.acme.dev", headerName: "Authorization" }], new Set(["feed.acme.dev"]))).toEqual([]);
  });

  it("mints the github token for the listed and the product repositories of its installation", async () => {
    const minted: Array<{ installation: string; repositories: readonly string[] }> = [];
    const access = await resolveHostCredentials(
      {
        credentials: {
          list: () => Promise.resolve([credential({ kind: "github", host: "github.com", repositories: ["acme/lib"], githubInstallationId: "9" })]),
          replace: () => Promise.resolve(),
        },
        secrets: { get: () => Promise.resolve(null) },
        githubToken: (installation, repositories) => {
          minted.push({ installation, repositories });
          return Promise.resolve("ghs_x");
        },
        productRepositories: () => Promise.resolve(["acme/app"]),
      },
      "t1",
      "p1",
    );
    expect(minted).toEqual([{ installation: "9", repositories: ["acme/app", "acme/lib"] }]);
    expect(access.refreshes).toBe(true);
    expect(access.hosts).toEqual(["github.com"]);
  });

  it("keeps the bootstrap key of a product with no credentials, and changes it when a credential host changes", () => {
    const base = { bootstrapCommand: "npm ci", warmCommand: null, allowedDomains: ["registry.npmjs.org"] };
    expect(bootstrapKeyOf({ ...base, credentials: [] })).toBe(bootstrapKeyOf(base));
    expect(bootstrapKeyOf({ ...base, credentials: ["npm.pkg.github.com pkg-npm.githubusercontent.com"] })).not.toBe(bootstrapKeyOf(base));
  });

  it("joins the credential, token service and redirect hosts to the egress", () => {
    const records = [
      credential({ kind: "registry", host: "ghcr.io", realmHost: "ghcr.io", realmPath: "/token", redirectHosts: ["pkg-containers.githubusercontent.com"] }),
      hostCredentialOf({ kind: "header", host: "NPM.pkg.github.com", headerName: "Authorization", redirectHosts: ["pkg-npm.githubusercontent.com"] }),
    ];
    expect(credentialHostsOf(records)).toEqual(["ghcr.io", "npm.pkg.github.com", "pkg-containers.githubusercontent.com", "pkg-npm.githubusercontent.com"]);
  });
});

const access: HostCredentialAccess = {
  credentials: [credential({})],
  hosts: ["npm.pkg.github.com", "pkg-npm.githubusercontent.com"],
  bindings: [{ name: "header:npm.pkg.github.com", host: "npm.pkg.github.com", header: "Authorization", value: "Bearer s", methods: ["GET", "HEAD"] }],
  refreshes: false,
};

const fakeKiln = (answer: (method: string, path: string) => number) => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchStub: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const status = answer(method, url.pathname);
    return Promise.resolve(
      new Response(status === 200 ? "{}" : JSON.stringify({ error: { code: "conflict", message: "no" } }), { status }),
    );
  };
  return { client: new KilnClient({ baseUrl: "https://kiln.test", apiKey: "k", fetch: fetchStub, retryDelaysMs: [] }), calls };
};

describe("Kiln credential bindings", () => {
  const ref = { id: "sb1", adapter: "kiln", workspacePath: "/home/agent/workspace" };

  it("sets the egress list before the binding list, which Kiln checks against it", async () => {
    const { client, calls } = fakeKiln(() => 200);
    await new KilnSandbox({ client, image: IMAGE, pollMs: 0 }).applyNetworkPolicy(ref, { allowedDomains: access.hosts, credentials: access.bindings });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["PUT /v1/sandboxes/sb1/egress", "PUT /v1/sandboxes/sb1/credentials"]);
    expect(calls[1]?.body).toEqual({ credentials: [{ name: "header:npm.pkg.github.com", host: "npm.pkg.github.com", header: "Authorization", value: "Bearer s", methods: ["GET", "HEAD"] }] });
  });

  it("clears the bindings when the egress list drops a bound host, then sets it again", async () => {
    let egress = 0;
    const { client, calls } = fakeKiln((_method, path) => (path.endsWith("/egress") && (egress += 1) === 1 ? 409 : 200));
    await new KilnSandbox({ client, image: IMAGE, pollMs: 0 }).applyNetworkPolicy(ref, { allowedDomains: ["registry.npmjs.org"] });
    expect(calls.map((call) => call.path.split("/").pop())).toEqual(["egress", "credentials", "egress"]);
  });

  it("names a template built before credential injection as a configuration fault", async () => {
    const { client } = fakeKiln((_method, path) => (path.endsWith("/credentials") ? 409 : 200));
    await expect(
      new KilnSandbox({ client, image: IMAGE, pollMs: 0 }).applyNetworkPolicy(ref, { allowedDomains: access.hosts, credentials: access.bindings }),
    ).rejects.toThrow(RunConfigurationError);
  });
});

const CONFIG =
  "version: 1\nidentity:\n  product: shop\n  linear:\n    teamKey: SHOP\nbootstrap:\n  command: npm ci\nverify:\n  commands:\n    - name: test\n      run: npm test\n" +
  "sandbox:\n  allowedDomains:\n    - registry.npmjs.org\n";

const configured = (curlExit = 0): FakeSandbox => {
  const sandbox = new FakeSandbox();
  sandbox.onExec = (command) => {
    if (command.file === "cat" && (command.args.at(-1) ?? "").endsWith(".factoree/config.yaml")) return { exitCode: 0, stdout: CONFIG, stderr: "" };
    if (command.file === "cat") return { exitCode: 1, stdout: "", stderr: "" };
    if (command.file === "curl") return { exitCode: curlExit, stdout: "", stderr: "" };
    if (command.file === "git" && command.args.includes("rev-parse")) return { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return sandbox;
};

const prepareInput = {
  runId: "run-1",
  tenantId: "t1",
  productId: "p1",
  primary: { url: "https://github.com/acme/app.git", ref: "main" },
  references: [],
  defaults: { ...DEFAULT_PROJECT_DEFAULTS, allowedDomains: ["registry.npmjs.org"] },
};

describe("SandboxManager with host credentials", () => {
  it("binds the credentials and reaches their hosts in every phase, the agent phase included", async () => {
    const sandbox = configured();
    const prepared = await new SandboxManager({ sandbox, hostCredentials: () => Promise.resolve(access) }).prepare(prepareInput);
    expect(sandbox.networkPolicies).toHaveLength(3);
    for (const policy of sandbox.networkPolicies) {
      expect(policy.allowedDomains).toEqual(expect.arrayContaining(access.hosts));
      expect(policy.credentials).toEqual(access.bindings);
    }
    expect(prepared.allowedHosts).toEqual(expect.arrayContaining(["npm.pkg.github.com", "registry.npmjs.org"]));
  });

  it("asks for a github token that also reads every repository the sandbox checks out", async () => {
    const asked: Array<readonly string[]> = [];
    await new SandboxManager({
      sandbox: configured(),
      hostCredentials: (_tenant, _product, repositories) => {
        asked.push(repositories);
        return Promise.resolve(access);
      },
    }).prepare({
      ...prepareInput,
      references: [{ url: "https://github.com/acme/contracts.git", ref: "main" }],
      organizationSkills: { url: "https://github.com/acme/skills.git", ref: "main" },
    });
    expect(asked[0]).toEqual(["acme/app", "acme/contracts", "acme/skills"]);
  });

  it("fails before the create on a provider that cannot bind", async () => {
    const sandbox = new FakeSandbox({
      enforcesNetworkPolicy: true,
      supportsCheckpoints: true,
      supportsExposedServices: true,
      supportsCustomImage: false,
      supportsDocker: false,
      bindsCredentials: false,
    });
    await expect(new SandboxManager({ sandbox, hostCredentials: () => Promise.resolve(access) }).prepare(prepareInput)).rejects.toThrow(
      /cannot bind them/,
    );
    expect(sandbox.calls).not.toContain("create");
  });

  it("fails at preparation and names the host when it does not resolve from the provider", async () => {
    const sandbox = configured(6);
    await expect(new SandboxManager({ sandbox, hostCredentials: () => Promise.resolve(access) }).prepare(prepareInput)).rejects.toThrow(
      /npm\.pkg\.github\.com does not resolve or connect/,
    );
  });

  it("records a refreshing binding with the egress it applied, and clears one that no longer refreshes", async () => {
    const records: unknown[] = [];
    const store = { record: (_adapter: string, _id: string, binding: unknown) => (records.push(binding), Promise.resolve()), due: () => Promise.resolve([]) };
    const sandbox = new FakeSandbox();
    const ref = { id: "sb1", adapter: "kiln", workspacePath: "/w" };
    await applyEgress(sandbox, ref, ["github.com"], { tenantId: "t1", productId: "p1", access: { ...access, refreshes: true }, store });
    await applyEgress(sandbox, ref, ["github.com"], { tenantId: "t1", productId: "p1", access, store });
    expect(records).toEqual([
      { tenantId: "t1", productId: "p1", hosts: ["github.com", "npm.pkg.github.com", "pkg-npm.githubusercontent.com"], repositories: [] },
      null,
    ]);
  });
});

describe("setup prompt with host credentials", () => {
  it("names the credential hosts and says to commit no credential entry", () => {
    const prompt = renderSetupPrompt({
      repository: "acme/shop",
      primaryRepositoryPath: "/w",
      productSlug: "shop",
      linearTeamKey: "SHOP",
      testSecretNames: [],
      ecosystemHosts: ["registry.npmjs.org"],
      credentialHosts: ["npm.pkg.github.com"],
      appChangesPath: "/w/app-changes.md",
      existingConfig: null,
      previousNotProven: [],
      requestedChanges: [],
      previousProven: [],
      repositoryInstructions: null,
    });
    expect(prompt).toContain("- npm.pkg.github.com");
    expect(prompt).toContain("Commit no credential entry");
  });
});
