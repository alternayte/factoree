/**
 * docs/specs/proof-pack-and-visual-evidence.md. The implementer checks its own work in a browser
 * with agent-browser. Its output never reaches the Proof Pack. Factoree installs the tools in the
 * work sprite beside the bootstrap command, under the bootstrap policy plus the hosts below, so no
 * agent ever runs with this wider egress. A live probe on 2026-10-30 proved the script on a Sprite
 * (Ubuntu 26.04, user `sprite` with sudo).
 */

/** The hosts the install reaches: npm, the Chrome for Testing index and downloads, and apt. */
export const BROWSER_TOOL_HOSTS = [
  "archive.ubuntu.com",
  "googlechromelabs.github.io",
  "registry.npmjs.org",
  "security.ubuntu.com",
  "storage.googleapis.com",
] as const;

const PREFIX = "/home/sprite/.local";
const BROWSER_ROOT = "/home/sprite/.cache/factoree-browser";
/** The wrapper the install writes. It points agent-browser at the headless shell, on the PATH of a Sprite. */
export const AGENT_BROWSER_COMMAND = `${PREFIX}/bin/agent-browser`;

/** The shared libraries chrome-headless-shell needs. The Sprite image holds none of them. */
const CHROME_LIBRARIES = [
  "libasound2t64",
  "libatk-bridge2.0-0t64",
  "libatk1.0-0t64",
  "libatspi2.0-0t64",
  "libcairo2",
  "libcups2t64",
  "libdbus-1-3",
  "libgbm1",
  "libglib2.0-0t64",
  "libnspr4",
  "libnss3",
  "libpango-1.0-0",
  "libx11-6",
  "libxcb1",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxkbcommon0",
  "libxrandr2",
];

/**
 * npm 12 runs no install script, so the script runs the agent-browser postinstall itself. The
 * package ships the Linux binaries, so the postinstall downloads nothing. The wrapper replaces
 * the npm link, so a plain `agent-browser` call finds the headless shell.
 */
export const BROWSER_TOOLS_INSTALL_SCRIPT = [
  "set -e",
  "sudo -n apt-get update -qq",
  `sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ${CHROME_LIBRARIES.join(" ")} >/dev/null`,
  `npm install -g --prefix ${PREFIX} --no-audit --no-fund agent-browser@0.37.1`,
  `(cd ${PREFIX}/lib/node_modules/agent-browser && node scripts/postinstall.js)`,
  `npx -y @puppeteer/browsers@2 install chrome-headless-shell@stable --path ${BROWSER_ROOT}`,
  `shell=$(find ${BROWSER_ROOT} -type f -name chrome-headless-shell | head -n 1)`,
  'test -n "$shell"',
  `rm -f ${AGENT_BROWSER_COMMAND}`,
  `printf '#!/bin/sh\\nexport AGENT_BROWSER_EXECUTABLE_PATH="%s"\\nexec node ${PREFIX}/lib/node_modules/agent-browser/bin/agent-browser.js "$@"\\n' "$shell" > ${AGENT_BROWSER_COMMAND}`,
  `chmod 755 ${AGENT_BROWSER_COMMAND}`,
].join("\n");

/** The longest wait for the install after the bootstrap ends. A slower install is abandoned. */
export const BROWSER_TOOLS_WAIT_MS = 5 * 60 * 1000;
/** The delay between two reads of the install process. */
export const BROWSER_TOOLS_POLL_MS = 1000;
