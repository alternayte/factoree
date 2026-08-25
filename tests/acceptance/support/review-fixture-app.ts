import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The fixture repository of the Phase 8 exit test. It holds one known defect, and a second
 * revision that repairs it.
 *
 * The defect is an authorization defect. `PATCH /projects/1` saves the new name for every
 * caller, so a reader with no editor rights can rename the project. The repository rule that
 * the defect breaks is stated in `CONTRIBUTING.md` of the fixture.
 *
 * The defect is deliberately invisible to the frozen Validation Contract. The contract states
 * the editor path only, so user validation passes on both revisions. The independent review is
 * the step that must find the defect. That is the point the exit condition proves.
 */
export interface WriteReviewFixtureAppInput {
  root: string;
  /** False writes the defective revision. True writes the repaired revision. */
  requireEditor: boolean;
}

/** The repository rule the known defect breaks. The fixture states it in `CONTRIBUTING.md`. */
export const REVIEW_FIXTURE_RULE =
  "Every write endpoint must reject a request that carries no x-editor header.";

/** The exact line the repaired revision adds. The second review diff must carry it. */
export const EDITOR_HEADER_CHECK = 'if (!req.headers["x-editor"])';

/** The exact comment the defective revision carries. The first review diff must carry it. */
export const DEFECT_MARKER =
  "// Factoree fixture defect: this endpoint saves the change for every caller.";

/** The name of the one defective file. The changed-file list must name it. */
export const DEFECTIVE_FILE = "server.cjs";

const packageJsonText = (): string =>
  `${JSON.stringify(
    {
      name: "review-fixture-app",
      version: "1.0.0",
      private: true,
      scripts: { start: "node server.cjs" },
    },
    null,
    2,
  )}\n`;

/**
 * The Node HTTP server source of the fixture. `requireEditor` decides the one block that
 * separates the defective revision from the repaired revision: whether `PATCH /projects/1`
 * rejects a request with no editor header.
 */
const serverSource = (requireEditor: boolean): string => `
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

function renderPage(name) {
  return "<!doctype html>\\n" +
    "<html>\\n" +
    "<head><title>Fixture Project</title></head>\\n" +
    "<body><h1 id=\\"current\\">" + name + "</h1></body>\\n" +
    "</html>";
}

function savePatch(req, res) {
${
  requireEditor
    ? `  // The repaired revision. ${REVIEW_FIXTURE_RULE}
  ${EDITOR_HEADER_CHECK} {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }`
    : `  ${DEFECT_MARKER}
  // It breaks the rule stated in CONTRIBUTING.md.`
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
    const name = typeof parsed.name === "string" ? parsed.name : readSavedName();
    writeSavedName(name);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: name }));
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(renderPage(readSavedName()));
    return;
  }

  if (req.method === "PATCH" && req.url === "/projects/1") {
    savePatch(req, res);
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, "127.0.0.1");
`;

/** Writes the fixture application into `input.root`. */
export const writeReviewFixtureApp = async (input: WriteReviewFixtureAppInput): Promise<void> => {
  await mkdir(input.root, { recursive: true });
  await writeFile(join(input.root, "package.json"), packageJsonText(), "utf8");
  await writeFile(join(input.root, DEFECTIVE_FILE), serverSource(input.requireEditor), "utf8");
};

/**
 * Applies the second revision to the primary worktree. Controller ruling C states this rule:
 * the repair step of the exit test writes the fixed revision itself, because the Implementer is
 * not the subject of the Phase 8 exit condition.
 */
export const applyReviewFixtureAuthorizationFix = async (root: string): Promise<void> => {
  await writeFile(join(root, DEFECTIVE_FILE), serverSource(true), "utf8");
};

/** The files the base commit of the fixture repository holds, before the change under review. */
export const REVIEW_FIXTURE_BASE_FILES: Array<{ path: string; text: string }> = [
  {
    path: "CONTRIBUTING.md",
    text: `# Contributing\n\n${REVIEW_FIXTURE_RULE}\n`,
  },
  // The preview process writes `state.json` while it serves a request. It is not part of the
  // change under review, so the base commit ignores it.
  { path: ".gitignore", text: "state.json\n" },
];
