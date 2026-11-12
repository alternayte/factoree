import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type * as FsPromises from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const traceReadControl = vi.hoisted(() => ({ failTraceRead: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const readFile = async (target: string): Promise<Buffer> => {
    if (traceReadControl.failTraceRead && target.endsWith("trace.zip")) {
      throw new Error("simulated unreadable trace file");
    }
    return await actual.readFile(target);
  };
  return { ...actual, readFile };
});
import {
  PlaywrightBrowserDriver,
  resolveGotoUrl,
} from "../../src/adapters/browser/playwright/playwright-browser-driver.js";
import type { BrowserScenario, BrowserStepEvent, BrowserStepResult, BrowserArtifact } from "../../src/domain/validation/browser-driver.js";

const PAGE_HTML = `<!doctype html>
<html>
<head><title>Fixture</title></head>
<body>
  <p id="current">Original</p>
  <form id="form">
    <input id="name" type="text" value="Original" />
    <button id="save" type="submit">Save</button>
  </form>
  <script>
    console.log("fixture page loaded");
    var stored = localStorage.getItem("name") || "Original";
    document.getElementById("current").textContent = stored;
    document.getElementById("name").value = stored;
    document.getElementById("form").addEventListener("submit", function (event) {
      event.preventDefault();
      var value = document.getElementById("name").value;
      localStorage.setItem("name", value);
      document.getElementById("current").textContent = value;
    });
  </script>
</body>
</html>`;

// browser-network-control.md. A page whose API call shows a loading state, then the result or
// the error.
const CONFIGS_HTML = `<!doctype html>
<html>
<body>
  <p id="status">Loading configs...</p>
  <script>
    fetch("/api/configs")
      .then(function (response) {
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then(function (body) {
        document.getElementById("status").textContent = body.count + " configs";
        document.body.insertAdjacentHTML("beforeend", '<p id="loaded">loaded</p>');
      })
      .catch(function (error) {
        var reason = error instanceof TypeError ? "network" : error.message;
        document.body.insertAdjacentHTML("beforeend", '<p id="error">Could not load configs (' + reason + ')</p>');
      });
  </script>
</body>
</html>`;

// repository-setup-and-services.md. A sign-in that keeps its session in local storage.
const LOGIN_HTML = `<!doctype html><html><body>
  <input id="email" /><input id="password" type="password" /><button id="submit">Sign in</button>
  <script>
    document.getElementById("submit").addEventListener("click", function () {
      if (document.getElementById("password").value !== "local-pass") return;
      localStorage.setItem("user", document.getElementById("email").value);
      document.body.insertAdjacentHTML("beforeend", '<p id="profile">profile</p>');
    });
  </script>
</body></html>`;

// Issue #44. A Blazor Server page: the markup shows at once, and the click handler attaches later,
// when the circuit is up. It then shows #ready.
const LATE_HANDLER_HTML = `<!doctype html><html><body>
  <button id="apply">Apply</button><p id="count">0</p>
  <script>
    setTimeout(function () {
      document.getElementById("apply").addEventListener("click", function () {
        var count = document.getElementById("count");
        count.textContent = String(Number(count.textContent) + 1);
      });
      document.body.insertAdjacentHTML("beforeend", '<div id="ready">ready</div>');
    }, 2500);
  </script>
</body></html>`;

// A cold SPA: the form renders only after its first load.
const SLOW_LOGIN_HTML = `<!doctype html><html><body>
  <script>
    setTimeout(function () {
      document.body.insertAdjacentHTML("beforeend", '<input id="email" /><input id="password" type="password" /><button id="submit">Sign in</button>');
      document.getElementById("submit").addEventListener("click", function () {
        if (document.getElementById("password").value !== "local-pass") return;
        document.body.insertAdjacentHTML("beforeend", '<p id="profile">profile</p>');
      });
    }, 3000);
  </script>
</body></html>`;

const ACCOUNT_HTML = `<!doctype html><html><body><p id="who"></p>
  <script>
    var user = localStorage.getItem("user");
    document.getElementById("who").textContent = user ? "Signed in as " + user : "Signed out";
  </script>
</body></html>`;

const startFixtureServer = (): Promise<{ server: Server; baseUrl: string }> =>
  new Promise((resolve) => {
    const server = createServer((request, response) => {
      if (request.url === "/api/configs") {
        response.setHeader("Content-Type", "application/json");
        response.writeHead(200);
        response.end(JSON.stringify({ count: 2 }));
        return;
      }
      if (request.url === "/login" || request.url === "/account") {
        response.setHeader("Content-Type", "text/html");
        response.writeHead(200);
        response.end(request.url === "/login" ? LOGIN_HTML : ACCOUNT_HTML);
        return;
      }
      if (request.url === "/late-handler") {
        response.setHeader("Content-Type", "text/html");
        response.writeHead(200);
        response.end(LATE_HANDLER_HTML);
        return;
      }
      if (request.url === "/slow-login") {
        response.setHeader("Content-Type", "text/html");
        response.writeHead(200);
        response.end(SLOW_LOGIN_HTML);
        return;
      }
      if (request.url === "/configs") {
        response.setHeader("Content-Type", "text/html");
        response.writeHead(200);
        response.end(CONFIGS_HTML);
        return;
      }
      response.setHeader("Content-Type", "text/html");
      response.writeHead(200);
      response.end(PAGE_HTML);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });

describe("PlaywrightBrowserDriver", () => {
  let server: Server;
  let baseUrl: string;
  let driver: PlaywrightBrowserDriver;
  const scenario: BrowserScenario = {
    baseUrl: "",
    steps: [{ action: "goto", path: "/" }],
    captureVideo: false,
    captureTrace: false,
    timeoutMs: 30_000,
    stepTimeoutMs: 5_000,
  };

  beforeAll(async () => {
    const fixture = await startFixtureServer();
    server = fixture.server;
    baseUrl = fixture.baseUrl;
    scenario.baseUrl = baseUrl;
    driver = new PlaywrightBrowserDriver();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    // Each test only reads scenario.baseUrl; nothing to reset per test.
  });

  it("has the name playwright", () => {
    expect(driver.name).toBe("playwright");
  });

  it("runs a scenario, asserts the page state, and returns a screenshot", async () => {
    const result = await driver.run({
      baseUrl,
      steps: [
        { action: "goto", path: "/" },
        { action: "fill", selector: "#name", value: "Renamed" },
        { action: "click", selector: "#save" },
        { action: "reload" },
        { action: "expectText", selector: "#current", text: "Renamed" },
        { action: "screenshot", name: "after-reload" },
      ],
      captureVideo: false,
      captureTrace: false,
      timeoutMs: 30_000,
      stepTimeoutMs: 5_000,
    });

    expect(result.passed).toBe(true);
    expect(result.steps.every((step: BrowserStepResult) => step.passed)).toBe(true);
    const screenshot = result.artifacts.find((a: BrowserArtifact) => a.name === "after-reload");
    expect(screenshot?.kind).toBe("screenshot");
    expect(screenshot!.bytes.byteLength).toBeGreaterThan(1_000);
    expect(result.network.some((entry: { status: number | null }) => entry.status === 200)).toBe(true);
  }, 60_000);

  it("passes when the element holds the expected text among other text (FAC-47 live run)", async () => {
    // FAC-47: the footer read "I'm here to stay (Footer) v0.1.0", and an exact match failed a
    // change that showed the version.
    const result = await driver.run({
      ...scenario,
      steps: [
        { action: "goto", path: "/" },
        { action: "expectText", selector: "body", text: "Original" },
      ],
    });
    expect(result.passed).toBe(true);
  }, 60_000);

  it("fails the scenario when the expected text is absent, and still returns a screenshot", async () => {
    const result = await driver.run({
      ...scenario,
      steps: [
        { action: "goto", path: "/" },
        { action: "expectText", selector: "#current", text: "Never" },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.failureReason).toBeTruthy();
    expect(result.artifacts.some((a: BrowserArtifact) => a.name === "final")).toBe(true);
  }, 60_000);

  it("stops the scenario after a thrown step and marks later steps not run", async () => {
    const result = await driver.run({
      ...scenario,
      steps: [
        { action: "goto", path: "/" },
        { action: "click", selector: "#does-not-exist" },
        { action: "expectVisible", selector: "#current" },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.steps[1]!.passed).toBe(false);
    expect(result.steps[2]!.passed).toBe(false);
    expect(result.steps[2]!.detail).toBe("not run");
  }, 60_000);

  it("captures a trace when the scenario asks for one", async () => {
    const result = await driver.run({ ...scenario, captureTrace: true });
    const trace = result.artifacts.find((a: BrowserArtifact) => a.kind === "trace");
    expect(trace).toBeDefined();
    expect(trace!.bytes.byteLength).toBeGreaterThan(0);
  }, 60_000);

  it("captures a video when the scenario asks for one", async () => {
    const result = await driver.run({ ...scenario, captureVideo: true });
    const video = result.artifacts.find((a: BrowserArtifact) => a.kind === "video");
    expect(video).toBeDefined();
    expect(video!.bytes.byteLength).toBeGreaterThan(0);
  }, 60_000);

  it("reports console output from the page", async () => {
    const result = await driver.run(scenario);
    expect(result.consoleLines.some((line: string) => line.includes("fixture page loaded"))).toBe(true);
  }, 60_000);

  it("returns a result, not a rejection, when the trace file cannot be read", async () => {
    traceReadControl.failTraceRead = true;
    try {
      const result = await driver.run({ ...scenario, captureTrace: true });
      expect(result.artifacts.some((a: BrowserArtifact) => a.kind === "trace")).toBe(false);
      expect(
        result.consoleLines.some((line: string) => line.includes("failed to read the trace file")),
      ).toBe(true);
      expect(result.passed).toBe(true);
    } finally {
      traceReadControl.failTraceRead = false;
    }
  }, 60_000);

  it("rejects a goto path that does not start with a slash", async () => {
    const result = await driver.run({
      ...scenario,
      steps: [{ action: "goto", path: "https://example.com" }],
    });
    expect(result.passed).toBe(false);
    expect(result.failureReason).toBeTruthy();
  }, 60_000);
  it.each(["//example.com", "///example.com", "/\\example.com"])(
    "refuses the goto path %s, which resolves to a foreign origin",
    async (path) => {
      // The plan parser rejects such a path. This control repeats the check, because a defence
      // in depth control must not trust the parser.
      expect(() => resolveGotoUrl(baseUrl, path)).toThrow();
      const result = await driver.run({ ...scenario, steps: [{ action: "goto", path }] });
      expect(result.passed).toBe(false);
      expect(result.failureReason).toBeTruthy();
      // The driver never left the preview origin, so no response of a foreign host was recorded.
      for (const entry of result.network) {
        expect(new URL(entry.url).origin).toBe(new URL(baseUrl).origin);
      }
    },
    60_000,
  );

  it("resolves an ordinary goto path onto the preview origin", () => {
    expect(resolveGotoUrl(baseUrl, "/projects/1")).toBe(`${baseUrl}/projects/1`);
    expect(new URL(resolveGotoUrl(baseUrl, "/")).origin).toBe(new URL(baseUrl).origin);
  });

  describe("network control (browser-network-control.md)", () => {
    const run = (steps: BrowserScenario["steps"], target = driver) =>
      target.run({ ...scenario, baseUrl, steps, timeoutMs: 30_000 });

    it("holds a matching request until the release, so the loading state shows every time", async () => {
      const result = await run([
        { action: "holdRequest", url: "**/api/configs" },
        { action: "goto", path: "/configs" },
        { action: "expectText", selector: "#status", text: "Loading configs..." },
        { action: "screenshot", name: "loading" },
        { action: "releaseRequests" },
        { action: "expectVisible", selector: "#loaded" },
        { action: "expectText", selector: "#status", text: "2 configs" },
      ]);
      expect(result.failureReason).toBeNull();
      expect(result.passed).toBe(true);
      expect(result.steps[0]!.requests).toEqual([
        { method: "GET", url: `${baseUrl}/api/configs`, effect: "held", autoReleased: false, failedWith: null },
      ]);
      expect(result.steps[0]!.detail).toBe(`Held 1 request that match **/api/configs: GET ${baseUrl}/api/configs.`);
      expect(result.steps[4]!.detail).toBe("Released 1 held request.");
      expect(result.network.some((entry) => entry.url.endsWith("/api/configs") && entry.status === 200)).toBe(true);
    }, 60_000);

    it("releases a held request by itself after the hold limit", async () => {
      const result = await run(
        [
          { action: "holdRequest", url: "**/api/configs" },
          { action: "goto", path: "/configs" },
          { action: "expectText", selector: "#status", text: "Loading configs..." },
          { action: "expectVisible", selector: "#loaded" },
        ],
        new PlaywrightBrowserDriver(500),
      );
      expect(result.passed).toBe(true);
      expect(result.steps[0]!.requests?.[0]?.autoReleased).toBe(true);
      expect(result.steps[0]!.detail).toContain("(released by the hold limit)");
    }, 60_000);

    it("releases a held request when the scenario ends", async () => {
      const started = Date.now();
      const result = await run([
        { action: "holdRequest", url: "**/api/configs" },
        { action: "goto", path: "/configs" },
        { action: "expectText", selector: "#status", text: "Loading configs..." },
      ]);
      expect(result.passed).toBe(true);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(result.steps[0]!.requests?.[0]?.autoReleased).toBe(false);
    }, 60_000);

    it("answers a matching request with the HTTP status and an empty body", async () => {
      const result = await run([
        { action: "failRequest", url: "**/api/configs", status: 500 },
        { action: "goto", path: "/configs" },
        { action: "expectText", selector: "#error", text: "Could not load configs (500)" },
      ]);
      expect(result.failureReason).toBeNull();
      expect(result.steps[0]!.requests).toEqual([
        { method: "GET", url: `${baseUrl}/api/configs`, effect: "failed", autoReleased: false, failedWith: 500 },
      ]);
      expect(result.network.some((entry) => entry.url.endsWith("/api/configs") && entry.status === 500)).toBe(true);
    }, 60_000);

    it("fails a matching request as a network error", async () => {
      const result = await run([
        { action: "failRequest", url: "**/api/configs", status: "network" },
        { action: "goto", path: "/configs" },
        { action: "expectText", selector: "#error", text: "Could not load configs (network)" },
      ]);
      expect(result.failureReason).toBeNull();
      expect(result.steps[0]!.requests?.[0]?.failedWith).toBe("network");
      expect(result.network.some((entry) => entry.url.endsWith("/api/configs") && entry.status === null)).toBe(true);
    }, 60_000);

    it("names no request when nothing matched the pattern", async () => {
      const result = await run([
        { action: "failRequest", url: "https://api.example.com/**", status: 503 },
        { action: "goto", path: "/configs" },
        { action: "expectVisible", selector: "#loaded" },
      ]);
      expect(result.passed).toBe(true);
      expect(result.steps[0]!.detail).toBe("No request matched https://api.example.com/**.");
    }, 60_000);
  });

  describe("step limits, ready wait and stop (issue #44)", () => {
    it("fails a selector that never matches in the step limit, with a readable reason (DI-21.68, DI-21.70)", async () => {
      const events: BrowserStepEvent[] = [];
      const started = Date.now();
      const result = await driver.run({
        ...scenario,
        timeoutMs: 600_000,
        stepTimeoutMs: 1_000,
        onStep: (event) => events.push(event),
        steps: [
          { action: "goto", path: "/" },
          { action: "click", selector: "#does-not-exist" },
          { action: "expectVisible", selector: "#current" },
        ],
      });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(result.passed).toBe(false);
      expect(result.failureReason).toBe("The selector `#does-not-exist` never matched an element that takes a click within 1 s.");
      expect(result.steps[1]!.detail).toBe(result.failureReason);
      expect(events.filter((event) => event.kind === "started").map((event) => event.index)).toEqual([0, 1]);
      expect(events.find((event) => event.kind === "timed_out")).toEqual({
        kind: "timed_out",
        index: 1,
        action: "click",
        selector: "#does-not-exist",
        limitMs: 1_000,
      });
    }, 60_000);

    it("names a selector that never becomes visible in plain words", async () => {
      const result = await driver.run({
        ...scenario,
        stepTimeoutMs: 1_000,
        steps: [
          { action: "goto", path: "/" },
          { action: "expectVisible", selector: "#never" },
        ],
      });
      expect(result.failureReason).toBe("The selector `#never` never became visible within 1 s.");
    }, 60_000);

    it("cuts a step to what is left of the scenario limit", async () => {
      const started = Date.now();
      const result = await driver.run({
        ...scenario,
        timeoutMs: 1_500,
        stepTimeoutMs: 30_000,
        steps: [
          { action: "goto", path: "/" },
          { action: "expectVisible", selector: "#never" },
        ],
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(result.failureReason).toMatch(/^The selector `#never` never became visible within 1(\.\d)? s\.$/);
    }, 60_000);

    it("clicks only after the ready selector shows, so the late handler takes the click (DI-21.69)", async () => {
      const steps = [
        { action: "goto" as const, path: "/late-handler" },
        { action: "click" as const, selector: "#apply" },
        { action: "expectText" as const, selector: "#count", text: "1" },
      ];
      const ready = await driver.run({ ...scenario, readySelector: "#ready", steps });
      expect(ready.failureReason).toBeNull();
      // Without the ready selector the click lands before the handler, so the count stays 0.
      const early = await driver.run({ ...scenario, steps });
      expect(early.passed).toBe(false);
    }, 60_000);

    it("fails the click with a clear reason when the ready selector never shows", async () => {
      const result = await driver.run({
        ...scenario,
        stepTimeoutMs: 1_000,
        readySelector: "#never-ready",
        steps: [
          { action: "goto", path: "/" },
          { action: "click", selector: "#save" },
        ],
      });
      expect(result.failureReason).toBe(
        "The page never became ready: the preview.readySelector `#never-ready` never became visible within 1 s.",
      );
    }, 60_000);

    it("closes the browser on a stop and rejects with the abort reason within seconds (DI-21.71)", async () => {
      const stop = new AbortController();
      const reason = new Error("stopped");
      setTimeout(() => stop.abort(reason), 1_000);
      const started = Date.now();
      await expect(
        driver.run({
          ...scenario,
          stepTimeoutMs: 30_000,
          signal: stop.signal,
          steps: [
            { action: "goto", path: "/" },
            { action: "expectVisible", selector: "#never" },
          ],
        }),
      ).rejects.toBe(reason);
      expect(Date.now() - started).toBeLessThan(10_000);
    }, 60_000);
  });

  describe("sign-in (repository-setup-and-services.md)", () => {
    const steps = (password: string) => [
      { action: "goto" as const, path: "/login" },
      { action: "fill" as const, selector: "#email", value: "member@example.test" },
      { action: "fill" as const, selector: "#password", value: password },
      { action: "click" as const, selector: "#submit" },
      { action: "expectVisible" as const, selector: "#profile" },
    ];

    it("signs in once and starts a later scenario signed in", async () => {
      const signIn = await driver.signIn({ baseUrl, steps: steps("local-pass"), timeoutMs: 20_000 });
      expect(signIn.signedIn).toBe(true);
      if (!signIn.signedIn) return;
      const signedIn = await driver.run({
        ...scenario,
        baseUrl,
        storageState: signIn.storageState,
        steps: [
          { action: "goto", path: "/account" },
          { action: "expectText", selector: "#who", text: "Signed in as member@example.test" },
        ],
      });
      expect(signedIn.failureReason).toBeNull();
      const anonymous = await driver.run({
        ...scenario,
        baseUrl,
        steps: [
          { action: "goto", path: "/account" },
          { action: "expectText", selector: "#who", text: "Signed out" },
        ],
      });
      expect(anonymous.failureReason).toBeNull();
    }, 60_000);

    it("gives a slow first step what is left of the budget (DI-21.16)", async () => {
      // anthology setup: an equal share of the budget per step failed the first fill on a cold app.
      const slow = [{ action: "goto" as const, path: "/slow-login" }, ...steps("local-pass").slice(1)];
      const signIn = await driver.signIn({ baseUrl, steps: slow, timeoutMs: 10_000 });
      expect(signIn.signedIn).toBe(true);
    }, 60_000);

    it("names the step at which a sign-in fails", async () => {
      const signIn = await driver.signIn({ baseUrl, steps: steps("wrong"), timeoutMs: 5_000 });
      expect(signIn).toMatchObject({ signedIn: false, failedStep: 5 });
    }, 60_000);
  });
});
