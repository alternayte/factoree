import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { egressRecordsOfDnsLog } from "~/adapters/sandbox/e2b/e2b-sandbox.js";

/**
 * docs/specs/preview-host-and-e2b-egress.md. The preview proxy of the sandbox image, run against
 * a real server. Vite, Rails and Django refuse a foreign Host or Origin, so a header the proxy
 * fails to rewrite fails a preview on every provider.
 */
const PROXY = join(__dirname, "../../sandbox/factoree-preview-proxy");

let upstream: Server;
let upstreamPort = 0;
let proxyPort = 0;
let proxy: ChildProcess;
let seen: IncomingHttpHeaders = {};
let upgradeSeen: IncomingHttpHeaders = {};
const upgraded: Duplex[] = [];

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

const get = (path: string, headers: Record<string, string>) =>
  new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const sent = request({ host: "127.0.0.1", port: proxyPort, path, headers }, (answer) => {
      let body = "";
      answer.setEncoding("utf8");
      answer.on("data", (chunk: string) => (body += chunk));
      answer.on("end", () => resolve({ status: answer.statusCode ?? 0, headers: answer.headers, body }));
    });
    sent.on("error", reject);
    sent.end();
  });

beforeAll(async () => {
  upstream = createServer((incoming, answer) => {
    seen = incoming.headers;
    if (incoming.url === "/redirect") {
      answer.writeHead(302, { location: `http://localhost:${upstreamPort}/signed-in`, "set-cookie": ["s=1; Path=/; Domain=localhost; HttpOnly"] });
      answer.end();
      return;
    }
    answer.end("ok");
  });
  upstream.on("upgrade", (incoming, socket) => {
    upgradeSeen = incoming.headers;
    upgraded.push(socket);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (data) => socket.write(data));
  });
  upstreamPort = await listen(upstream);
  const probe = createServer();
  proxyPort = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  proxy = spawn(process.execPath, [PROXY, String(proxyPort), String(upstreamPort)], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    proxy.stdout?.on("data", () => resolve());
    proxy.on("exit", (code) => reject(new Error(`the proxy exited with ${String(code)}`)));
  });
});

afterAll(async () => {
  proxy.kill();
  for (const socket of upgraded) socket.destroy();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe("factoree-preview-proxy", () => {
  it("sends Host, Origin, Referer and X-Forwarded-Host as localhost", async () => {
    const answer = await get("/form", {
      host: "3000-abc.e2b.app",
      origin: "https://3000-abc.e2b.app",
      referer: "https://3000-abc.e2b.app/login?next=/",
      "x-forwarded-host": "3000-abc.e2b.app",
      "x-forwarded-proto": "https",
    });
    expect(answer.body).toBe("ok");
    const local = `localhost:${String(upstreamPort)}`;
    expect(seen.host).toBe(local);
    expect(seen.origin).toBe(`http://${local}`);
    expect(seen.referer).toBe(`http://${local}/login?next=/`);
    expect(seen["x-forwarded-host"]).toBe(local);
    expect(seen["x-forwarded-proto"]).toBe("http");
  });

  it("sends a redirect and a cookie back to the public host", async () => {
    const answer = await get("/redirect", { host: "3000-abc.e2b.app", "x-forwarded-proto": "https" });
    expect(answer.status).toBe(302);
    expect(answer.headers.location).toBe("https://3000-abc.e2b.app/signed-in");
    expect(answer.headers["set-cookie"]).toEqual(["s=1; Path=/; HttpOnly"]);
  });

  it("passes a websocket upgrade with the rewritten host", async () => {
    const socket = connect(proxyPort, "127.0.0.1");
    const echoed = await new Promise<string>((resolve) => {
      let text = "";
      socket.on("data", (data) => {
        text += data.toString("utf8");
        if (text.includes("\r\n\r\n") && !text.endsWith("\r\n\r\n")) resolve(text);
        else if (text.endsWith("\r\n\r\n")) socket.write("ping");
      });
      socket.write("GET /hmr HTTP/1.1\r\nHost: 3000-abc.e2b.app\r\nOrigin: https://3000-abc.e2b.app\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    socket.destroy();
    expect(echoed).toContain("101 Switching Protocols");
    expect(echoed.endsWith("ping")).toBe(true);
    expect(upgradeSeen.host).toBe(`localhost:${String(upstreamPort)}`);
    expect(upgradeSeen.origin).toBe(`http://localhost:${String(upstreamPort)}`);
  });
});

describe("egressRecordsOfDnsLog", () => {
  it("judges each lookup against the policy in force at its line", () => {
    const records = egressRecordsOfDnsLog(
      [
        "Q early.example.org",
        "#factoree-policy registry.npmjs.org,*.docker.io",
        "Q registry.npmjs.org",
        "Q registry-1.docker.io",
        "Q 1.0.0.10.in-addr.arpa",
        "Q localhost",
        "#factoree-policy api.nuget.org",
        "Q registry-1.docker.io",
      ].join("\n"),
    );
    expect(records).toEqual([
      { host: "early.example.org", decision: "denied" },
      { host: "registry.npmjs.org", decision: "allowed" },
      { host: "registry-1.docker.io", decision: "allowed" },
      { host: "registry-1.docker.io", decision: "denied" },
    ]);
  });

  it("returns null when the sandbox holds no DNS log", () => {
    expect(egressRecordsOfDnsLog("missing\n")).toBeNull();
  });
});
