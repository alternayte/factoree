import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Writes a tiny repository Task 10 drives through the real preview, the real Playwright
 * driver, and a real HTTP request. The page shows a project name, a text field, and a save
 * button. `GET /health` answers 200. `PATCH /projects/1` answers 403 for a request with no
 * `x-editor` header, and 200 for a request that carries one.
 *
 * `persistName` selects the shape of the bug the Phase 7 exit test proves a regression against.
 * `false` writes the page exactly as an Implementer would leave it before the fix: the server
 * always renders the original name, so a saved name does not survive a reload. `true` writes
 * the fixed page: the server renders the name it last saved, so a saved name survives a reload.
 */
export interface WritePreviewFixtureAppInput {
  root: string;
  persistName: boolean;
}

const packageJsonText = (): string =>
  `${JSON.stringify(
    {
      name: "preview-fixture-app",
      version: "1.0.0",
      private: true,
      scripts: { start: "node server.cjs" },
    },
    null,
    2,
  )}\n`;

const configYamlText = (): string =>
  [
    "verify:",
    "  commands:",
    '    - name: "unit"',
    '      run: "npm test"',
    "preview:",
    "  enabled: true",
    '  command: "node server.cjs"',
    '  readyUrl: "http://127.0.0.1:0/health"',
    "  timeoutSeconds: 30",
    "",
  ].join("\n");

/**
 * The Node HTTP server source for the fixture page. `persistName` decides the one line that
 * separates the buggy page from the fixed page: whether a GET of `/` reads the name last saved,
 * or always renders the name the server started with.
 */
const serverSource = (persistName: boolean): string => `
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT);
const STATE_FILE = path.join(__dirname, "state.json");
const INITIAL_NAME = "Original Project";

function readSavedName() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).name;
  } catch {
    return INITIAL_NAME;
  }
}

function writeSavedName(name) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ name: name }), "utf8");
}

// This is the one line the Phase 7 exit test's fixture change flips. Before the fix, a reload
// always shows the original name. After the fix, a reload shows the name last saved.
function currentName() {
  ${persistName ? "return readSavedName();" : "return INITIAL_NAME;"}
}

function renderPage(name) {
  return "<!doctype html>\\n" +
    "<html>\\n" +
    "<head><title>Fixture Project</title></head>\\n" +
    "<body>\\n" +
    "  <h1 id=\\"current\\">" + name + "</h1>\\n" +
    "  <form id=\\"form\\">\\n" +
    "    <input id=\\"name\\" type=\\"text\\" value=\\"" + name + "\\" />\\n" +
    "    <button id=\\"save\\" type=\\"submit\\">Save</button>\\n" +
    "  </form>\\n" +
    "  <script>\\n" +
    "    document.getElementById(\\"form\\").addEventListener(\\"submit\\", function (event) {\\n" +
    "      event.preventDefault();\\n" +
    "      var value = document.getElementById(\\"name\\").value;\\n" +
    "      fetch(\\"/projects/1\\", {\\n" +
    "        method: \\"PATCH\\",\\n" +
    "        headers: { \\"content-type\\": \\"application/json\\", \\"x-editor\\": \\"user\\" },\\n" +
    "        body: JSON.stringify({ name: value }),\\n" +
    "      })\\n" +
    "        .then(function (response) { return response.json(); })\\n" +
    "        .then(function (data) {\\n" +
    "          document.getElementById(\\"current\\").textContent = data.name;\\n" +
    "        });\\n" +
    "    });\\n" +
    "  </script>\\n" +
    "</body>\\n" +
    "</html>";
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(renderPage(currentName()));
    return;
  }

  if (req.method === "PATCH" && req.url === "/projects/1") {
    if (!req.headers["x-editor"]) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        parsed = {};
      }
      const name = typeof parsed.name === "string" ? parsed.name : currentName();
      writeSavedName(name);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: name }));
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, "127.0.0.1");
`;

/** Writes the fixture repository into `input.root`. */
export const writePreviewFixtureApp = async (input: WritePreviewFixtureAppInput): Promise<void> => {
  await mkdir(join(input.root, ".factoree"), { recursive: true });
  await writeFile(join(input.root, "package.json"), packageJsonText(), "utf8");
  await writeFile(join(input.root, ".factoree", "config.yaml"), configYamlText(), "utf8");
  await writeFile(join(input.root, "server.cjs"), serverSource(input.persistName), "utf8");
};

/**
 * Applies the UI fixture change, exactly as an Implementer would: the page now renders the name
 * last saved, so it survives a reload. Task 10 uses this in the Phase 7 exit test, after it
 * proves the negative half against the unfixed page.
 */
export const applyPreviewFixtureNamePersistenceFix = async (root: string): Promise<void> => {
  await writeFile(join(root, "server.cjs"), serverSource(true), "utf8");
};
