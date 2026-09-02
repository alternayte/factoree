/**
 * Drives one real Fly Sprite through every step a Run takes inside the sandbox, and reports each
 * step separately.
 *
 * A Run reaches the sandbox after a Linear delegation, a refinement, and a context resolution, so
 * one fault inside the sandbox costs ten minutes and a Linear issue to find. This script starts
 * at the sandbox instead. It exercises the checkout, the network policy, the bootstrap command,
 * the verification commands, and the three agent session shapes of SDD sections 34, 36, and 40.
 *
 * It uses the real adapters and the real domain code, so a fault it does not find is a fault the
 * Run will not find either. Every earlier failure of this project inside the sandbox appears here
 * as a failing step: the workspace path, the shell environment, the model of a session, the
 * permission to read the repository, and the arguments of the command.
 *
 * Run it with `just smoke`. It creates one Sprite and destroys it, unless `--keep` is given.
 */
import { FlySpriteSandbox } from "../../dist/adapters/sandbox/fly-sprites/fly-sprite-sandbox.js";
import { createSpritesGateway } from "../../dist/adapters/sandbox/fly-sprites/sprites-client.js";
import { OpenCodeRunner } from "../../dist/adapters/runners/opencode/opencode-runner.js";
import { SandboxManager } from "../../dist/domain/runs/sandbox-manager.js";
import { runVerification } from "../../dist/domain/runs/verification.js";
import { buildActionPolicy } from "../../dist/domain/policy/action-policy.js";
import { createPrismaClient } from "../../dist/persistence/prisma/client.js";
import { decryptSecret } from "../../dist/domain/policy/crypto.js";
import { createLogger } from "../../dist/telemetry/logger.js";
import { Redactor } from "../../dist/telemetry/redaction.js";

const keep = process.argv.includes("--keep");
const need = (name) => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`Set ${name} in .env first.`);
    process.exit(1);
  }
  return value;
};

const spritesToken = need("SPRITES_TOKEN");
const slug = need("SETUP_GITHUB_REPOSITORY");
const baseUrl = process.env.GITHUB_BASE_URL ?? "https://github.com";
const branch = process.env.SETUP_DEFAULT_BRANCH ?? "main";
const repositoryUrl = `${baseUrl.replace(/\/+$/, "")}/${slug.replace(/\.git$/, "")}.git`;

/** The runner credentials of the Project, read the way an activity reads them. */
const runnerEnvironment = async () => {
  if (process.env.DATABASE_URL === undefined || process.env.FACTOREE_SECRET_KEY === undefined) return {};
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  try {
    const rows = await prisma.projectSecret.findMany({ where: { kind: "runner_credential" } });
    const environment = {};
    for (const row of rows) {
      environment[row.name] = decryptSecret(row.valueCipher, process.env.FACTOREE_SECRET_KEY);
    }
    return environment;
  } finally {
    await prisma.$disconnect();
  }
};

const results = [];
const step = async (name, body) => {
  const started = Date.now();
  try {
    const detail = await body();
    results.push({ name, ok: true, seconds: (Date.now() - started) / 1000, detail: detail ?? "" });
    console.log(`  ok   ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, seconds: (Date.now() - started) / 1000, detail: message });
    console.log(`  FAIL ${name}: ${message.slice(0, 200)}`);
  }
};

const redactor = new Redactor();
const logger = createLogger({ level: "error", redactor, sink: () => undefined });
const sandbox = new FlySpriteSandbox({ gateway: createSpritesGateway({ token: spritesToken }) });
const manager = new SandboxManager({ sandbox, logger });
const runner = new OpenCodeRunner({ redactor, pollIntervalMs: 3000, idleTimeoutMs: 240_000 });

console.log(`Repository: ${repositoryUrl} at ${branch}\n`);
let prepared = null;

await step("prepare the sandbox: checkout, network policy, bootstrap", async () => {
  prepared = await manager.prepare({
    runId: `smoke-${Date.now()}`,
    tenantId: "smoke",
    projectId: "smoke",
    primary: { url: repositoryUrl, ref: branch },
    references: [],
    defaults: { stagingRead: false, spriteRetentionHours: 1 },
    environment: await runnerEnvironment(),
  });
  return `sprite ${prepared.ref.id}, base ${prepared.checkout.primary.baseSha.slice(0, 7)}`;
});

if (prepared === null) {
  console.log("\nThe sandbox never prepared, so no later step can run.");
  process.exit(1);
}

const ref = prepared.ref;
const primaryPath = prepared.checkout.primary.path;

await step("the toolchain resolves in the sandbox shell", async () => {
  const result = await sandbox.exec(ref, {
    file: "sh",
    args: ["-c", "command -v git node npm opencode | tr '\\n' ' '"],
    cwd: primaryPath,
  });
  if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}: ${result.stderr.trim()}`);
  return result.stdout.trim();
});

await step("the verification commands of the repository pass", async () => {
  const outcome = await runVerification({
    sandbox,
    ref,
    workingDirectory: primaryPath,
    commands: prepared.verifyCommands,
    environment: {},
    timeoutMs: 600_000,
    redactor,
  });
  const failed = outcome.checks.filter((check) => !check.passed);
  if (failed.length > 0) {
    throw new Error(failed.map((check) => `${check.name}: ${(check.log ?? "").slice(-160)}`).join(" | "));
  }
  return outcome.checks.map((check) => check.name).join(", ");
});

await step("a verification command holds no runner credential", async () => {
  // The shell decides, not the log: a passing check retains no log, so an assertion that reads
  // the log reports a leak for every clean Run. `test -z` exits non-zero when the value is set,
  // and a failing check is the signal.
  const outcome = await runVerification({
    sandbox,
    ref,
    workingDirectory: primaryPath,
    commands: [{ name: "credential", run: 'test -z "${OPENCODE_API_KEY:-}"' }],
    environment: {},
    timeoutMs: 60_000,
    redactor,
  });
  if (outcome.checks[0]?.passed !== true) {
    throw new Error("a runner credential reached a verification command, against SDD section 30");
  }
  return "absent, as SDD section 30 requires";
});

/** One agent session of the given shape. The validator and the reviewer work from a scratch directory. */
const session = async (role, directory) => {
  if (directory !== primaryPath) {
    await sandbox.exec(ref, { file: "mkdir", args: ["-p", directory], cwd: "/" });
  }
  const marker = `${directory}/smoke-${role}.txt`;
  const result = await runner.run({
    runId: `smoke-${role}`,
    tenantId: "smoke",
    role,
    sandbox,
    ref,
    workingDirectory: directory,
    repositoryPath: primaryPath,
    prompt:
      `Read the file ${primaryPath}/package.json. Then write the file ${marker}, whose only line ` +
      "is the name field of that package. Reply with the word done.",
    promptVersion: "smoke/1",
    environment: {},
    actionPolicy: buildActionPolicy(),
    timeoutMs: 300_000,
  });
  if (!result.completed) throw new Error(`exit ${result.exitCode}: ${result.summary.slice(0, 200)}`);
  const wrote = await sandbox.exec(ref, { file: "cat", args: [marker], cwd: "/" });
  if (wrote.exitCode !== 0) throw new Error("the session wrote no file, so it proved nothing");
  return `wrote ${wrote.stdout.trim().slice(0, 40)}`;
};

await step("an implementer session works in the primary worktree", () => session("implementer", primaryPath));
await step("a validator session works from a scratch directory", () =>
  session("validator", `${ref.workspacePath}/validation`));
await step("a reviewer session works from a scratch directory", () =>
  session("reviewer", `${ref.workspacePath}/review`));

if (!keep) {
  await step("destroy the sandbox", async () => {
    await sandbox.destroy(ref);
    return "removed";
  });
} else {
  console.log(`\nKept the sprite: ${ref.id}`);
}

console.log("\n--- summary ---");
for (const result of results) {
  console.log(`${result.ok ? "ok  " : "FAIL"}  ${result.seconds.toFixed(1).padStart(6)}s  ${result.name}`);
  if (!result.ok) console.log(`        ${result.detail.slice(0, 300)}`);
}
const failures = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failures} of ${results.length} steps passed.`);
process.exit(failures === 0 ? 0 : 1);
