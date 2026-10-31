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
import type { BrowserScenario, BrowserStepResult, BrowserArtifact } from "../../src/domain/validation/browser-driver.js";

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

const startFixtureServer = (): Promise<{ server: Server; baseUrl: string }> =>
  new Promise((resolve) => {
    const server = createServer((_request, response) => {
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
});
