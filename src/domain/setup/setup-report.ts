import { isMap, isSeq, parseDocument } from "yaml";
import type { DerivedHost } from "./derived-hosts.js";
import { NUGET_FEED_MAPPING, NUGET_MIRROR_HOST } from "./nuget-feeds.js";
import type { NugetPrecheckReport } from "./nuget-precheck.js";

/**
 * docs/specs/repository-setup-and-services.md. One part of a proposed `.factoree/config.yaml` that
 * the setup proof checks on its own. The pull request holds only the parts that passed.
 */
export type SetupPartKind = "bootstrap" | "verify" | "services" | "preview" | "account" | "stack";

export interface SetupPartResult {
  kind: SetupPartKind;
  /**
   * The verify command name, the account name, or the stack name. The kind for the other parts.
   * GitHub issue 82: a `stack` is a stack the setup agent found and did not propose, so it never
   * passes and Factoree never proves it.
   */
  name: string;
  passed: boolean;
  /** Why the part failed, in one line, or null when it passed. */
  reason: string | null;
  /** The last lines of the output of a failed part, already redacted. */
  logTail?: string;
  /**
   * docs/specs/private-stack-onboarding.md. Where the setup agent took the part from: a file and a
   * step, such as `.github/workflows/ci.yml step "Test"`, or "none". Absent in an older report.
   */
  source?: string;
}

/** The setup report: the result of every part, and what the setup sandbox reached. */
export interface SetupReport {
  parts: SetupPartResult[];
  /** The hosts the setup sandbox reached, when the provider records egress. */
  observedHosts: string[];
  /** The hosts outside the allow list that the setup sandbox tried, when the provider records egress. */
  deniedHosts: string[];
  /**
   * docs/specs/host-credentials.md. The credential hosts and redirect hosts the setup sandbox
   * reached. Absent in a report written before host credentials existed.
   */
  credentialHosts?: string[];
  /** False when the provider records no egress (E2B), so both host lists are empty. */
  egressRecorded: boolean;
  /** The fakes the proposal adds, by compose service and API. */
  fakes: Array<{ service: string; name: string }>;
  /** The app changes the setup agent names for parts it could not configure from `.factoree/`. */
  appChanges: string[];
  /**
   * docs/specs/setup-app-change-issues.md. The app changes an open app-change issue already
   * requests, with that issue. Absent in a report made before it existed.
   */
  alreadyRequested?: Array<{ change: string; issue: string }>;
  /**
   * docs/specs/claude-code-runner.md. True when the proposal held an `agents` block, which the
   * proven config drops. Absent in a report made before it existed.
   */
  agentsBlockRemoved?: boolean;
  /**
   * docs/specs/private-stack-onboarding.md. The derived hosts that nothing covered when the proof
   * ran, so the operator adds each one. Absent in a report made before it existed.
   */
  derivedHosts?: DerivedHost[];
  /**
   * docs/specs/private-stack-onboarding.md. "passed", "failed", or "skipped" when the provider has
   * no warm snapshots. Absent when no warm proof was due, such as after a failed cold bootstrap.
   */
  warmProof?: "passed" | "failed" | "skipped";
  /**
   * docs/specs/sandbox-memory-and-size.md. The peak memory and disk of the proof sandboxes, next to
   * the memory and the disk the guest had, in MB. Absent when no sampler ran.
   */
  resources?: { peakMemoryMb: number; peakDiskMb: number; memoryMb: number; diskMb: number };
  /**
   * docs/specs/nuget-private-feed-mapping.md. The NuGet pre-check with its per-package evidence.
   * Absent when the repository needed none, and in a report made before it existed.
   */
  nuget?: NugetPrecheckReport;
}

/** Why a part that depends on another part did not run. */
const DEPENDS_ON_PREVIEW = "it needs the preview, which failed";

/**
 * Builds the config the pull request proposes: the agent's proposal without the parts that failed.
 * Comments and key order of the proposal stay. Null when nothing can be proposed: the bootstrap
 * failed, or no verify command passed, which the config schema requires.
 */
export const provenConfigOf = (proposal: string, parts: readonly SetupPartResult[]): string | null => {
  const failed = (kind: SetupPartKind, name?: string): boolean =>
    parts.some((part) => part.kind === kind && !part.passed && (name === undefined || part.name === name));
  if (failed("bootstrap")) return null;

  const document = parseDocument(proposal);
  const verify = document.getIn(["verify", "commands"]);
  if (isSeq(verify)) {
    verify.items = verify.items.filter((item) => !(isMap(item) && failed("verify", String(item.get("name")))));
    if (verify.items.length === 0) return null;
  }
  if (failed("services")) {
    document.delete("services");
    document.delete("docker");
  }
  if (failed("preview")) document.delete("preview");
  // docs/specs/claude-code-runner.md. The Product selects the runner of each role, so a proven
  // config holds no `agents` block.
  document.delete("agents");
  const accounts = document.get("accounts");
  if (isSeq(accounts)) {
    accounts.items = accounts.items.filter((item) => !(isMap(item) && failed("account", String(item.get("name")))));
    if (accounts.items.length === 0) document.delete("accounts");
  }
  return document.toString();
};

/** Marks every account as failed when the preview failed, because an account signs in on the preview. */
export const withPreviewDependents = (parts: readonly SetupPartResult[]): SetupPartResult[] => {
  const previewFailed = parts.some((part) => part.kind === "preview" && !part.passed);
  return parts.map((part) =>
    previewFailed && part.kind === "account" && part.passed ? { ...part, passed: false, reason: DEPENDS_ON_PREVIEW } : part,
  );
};

const partName = (part: SetupPartResult): string =>
  part.kind === "verify"
    ? `verify command \`${part.name}\``
    : part.kind === "account"
      ? `account \`${part.name}\``
      : part.kind === "stack"
        ? `stack \`${part.name}\` (not proposed)`
        : part.kind;

const partLabel = (part: SetupPartResult): string =>
  part.source === undefined ? partName(part) : `${partName(part)} (from ${part.source === "none" ? "no repository file" : part.source})`;

/**
 * docs/specs/private-stack-onboarding.md. The sources file the setup agent writes: one line per
 * part, `<kind>[ <name>]: <source>`, such as `verify test: .github/workflows/ci.yml step "Test"`.
 */
export const parseSetupSources = (text: string): Map<string, string> => {
  const sources = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*(bootstrap|services|preview|verify|account)(?:\s+([^:]+?))?\s*:\s*(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const kind = match[1]!;
    const name = match[2] ?? kind;
    sources.set(`${kind}:${name}`, match[3]!.slice(0, 300));
  }
  return sources;
};

/** The most stacks one left-out file can name, and the longest output kept for one. */
const LEFT_OUT_LIMIT = 20;
const LEFT_OUT_LOG_CHARS = 2_000;

/**
 * GitHub issue 82. The left-out file the setup agent writes: one entry per stack it found and did
 * not propose, as `<stack>: <reason>`, optionally followed by indented lines of command output.
 * Each entry becomes a failed `stack` part, so the report and the next setup name it.
 */
export const parseLeftOutStacks = (text: string): SetupPartResult[] => {
  const parts: SetupPartResult[] = [];
  let current: { name: string; reason: string; log: string[] } | null = null;
  const flush = (): void => {
    if (current === null) return;
    const log = current.log.join("\n").trim();
    parts.push({
      kind: "stack",
      name: current.name,
      passed: false,
      reason: current.reason,
      ...(log === "" ? {} : { logTail: log.slice(-LEFT_OUT_LOG_CHARS) }),
    });
    current = null;
  };
  for (const line of text.split("\n")) {
    const entry = /^(\S[^:]{0,60}?)\s*:\s*(\S.*)$/.exec(line);
    if (entry !== null && !/^\s/.test(line)) {
      flush();
      if (parts.length >= LEFT_OUT_LIMIT) break;
      current = { name: entry[1]!.trim(), reason: entry[2]!.trim().slice(0, 300), log: [] };
      continue;
    }
    if (current !== null && line.trim() !== "") current.log.push(line.replace(/^ {1,4}/, ""));
  }
  flush();
  return parts.slice(0, LEFT_OUT_LIMIT);
};

/** Each part with the source the setup agent named for it. */
export const withSources = (parts: readonly SetupPartResult[], sources: ReadonlyMap<string, string>): SetupPartResult[] =>
  parts.map((part) => {
    const source = sources.get(`${part.kind}:${part.name}`);
    return source === undefined ? part : { ...part, source };
  });

const CREDENTIAL_TEXT: Record<NugetPrecheckReport["credential"], string> = {
  present: "present",
  missing: "missing",
  invalid: "not usable",
  not_needed: "not needed, because no package needs the mirror",
};

/** docs/specs/nuget-private-feed-mapping.md. The NuGet pre-check, with each package that is not public. */
const renderNugetPrecheck = (nuget: NugetPrecheckReport): string[] => {
  const lines = ["### NuGet feeds", ""];
  if (nuget.outcome === "failed" && nuget.failure !== null) lines.push(...nuget.failure.split("\n"), "");
  if (nuget.configPath !== null) {
    const mapped = nuget.mirroredIds.length === 0
      ? `leaves out \`${NUGET_FEED_MAPPING.from}\`, which serves no package of this repository`
      : `replaces \`${NUGET_FEED_MAPPING.from}\` with \`${NUGET_FEED_MAPPING.to}\` and maps ${nuget.mirroredIds.map((id) => `\`${id}\``).join(", ")} to it`;
    lines.push(`Factoree wrote \`${nuget.configPath}\`: it ${mapped}, and keeps every other source. Restore with \`dotnet restore --configfile ${nuget.configPath}\`.`, "");
  }
  lines.push(
    `Sources: ${nuget.feeds.length === 0 ? "none" : nuget.feeds.map((feed) => `\`${feed.key}\` (${feed.kind}, from \`${feed.file}\`)`).join(", ")}.`,
    `nuget.org has ${String(nuget.publicPackages)} of the referenced packages, listed, at the exact version.`,
    `The host credential for ${NUGET_MIRROR_HOST} is ${CREDENTIAL_TEXT[nuget.credential]}.`,
  );
  if (nuget.restore.outcome === "passed") {
    lines.push(`\`dotnet restore\` with the file passed after ${String(nuget.restore.rounds)} round${nuget.restore.rounds === 1 ? "" : "s"}.${nuget.restore.detail === null ? "" : ` ${nuget.restore.detail}`}`);
  }
  if (nuget.restore.outcome === "not_run" && nuget.restore.detail !== null) lines.push(nuget.restore.detail);
  if (nuget.restore.outcome === "failed") lines.push(`\`dotnet restore\` with the file failed in round ${String(nuget.restore.rounds)}.`);
  lines.push("");
  if (nuget.packages.length > 0) {
    for (const entry of nuget.packages) {
      const where = [...entry.projects, ...(entry.parents === undefined || entry.parents.length === 0 ? [] : [`through ${entry.parents.join(" > ")}`])].join(", ");
      lines.push(`- \`${entry.id}\` ${entry.version}${where === "" ? "" : ` (${where})`}: ${entry.detail}`);
    }
    lines.push("");
  }
  if (nuget.restore.detail !== null && nuget.restore.outcome === "failed") {
    lines.push("```", ...nuget.restore.detail.split("\n"), "```", "");
  }
  return lines;
};

/** The pull request body and the report the product page shows. */
export const renderSetupReport = (report: SetupReport): string => {
  const lines: string[] = ["## Factoree setup", ""];
  // docs/specs/nuget-private-feed-mapping.md. A failed pre-check started no session, so only its evidence is the report.
  if (report.nuget?.outcome === "failed") {
    lines.push("The NuGet pre-check failed, so Factoree started no setup agent and proved nothing.", "", ...renderNugetPrecheck(report.nuget));
    return `${lines.join("\n").trimEnd()}\n`;
  }
  const passed = report.parts.filter((part) => part.passed);
  const failed = report.parts.filter((part) => !part.passed);
  lines.push(
    failed.length === 0
      ? "Factoree proved every part of this configuration in a fresh sandbox."
      : "Factoree proved the parts below in a fresh sandbox. The configuration holds only the parts that passed.",
    "",
    "### Proven",
    "",
    ...(passed.length === 0 ? ["Nothing."] : passed.map((part) => `- ${partLabel(part)}`)),
    "",
  );
  if (failed.length > 0) {
    lines.push("### Not proven, so left out", "");
    for (const part of failed) {
      lines.push(`- ${partLabel(part)}: ${part.reason ?? "it failed."}`);
      if (part.logTail !== undefined && part.logTail.trim() !== "") {
        lines.push("", "  ```", ...part.logTail.split("\n").map((line) => `  ${line}`), "  ```");
      }
    }
    lines.push("");
    // GitHub issue 86. An empty list of denied hosts says nothing when the provider records none.
    if (!report.egressRecorded) {
      lines.push("The sandbox provider records no blocked requests, so a part that failed on a host outside the allow list names no host here.", "");
    }
  }
  if (report.fakes.length > 0) {
    lines.push("### Fakes", "", ...report.fakes.map((fake) => `- ${fake.name}, answered by the compose service \`${fake.service}\`. Its data is not real.`), "");
  }
  if (report.appChanges.length > 0) {
    const requested = new Map((report.alreadyRequested ?? []).map((found) => [found.change, found.issue]));
    lines.push(
      "### App changes",
      "",
      "When this pull request merges, Factoree creates a Linear issue for each change below that no open issue requests, and delegates it to itself.",
      "",
      ...report.appChanges.map((change) => {
        const issue = requested.get(change);
        return issue === undefined ? `- ${change}` : `- ${change} (already requested: ${issue})`;
      }),
      "",
    );
  }
  if (report.agentsBlockRemoved === true) {
    lines.push(
      "### Agents block",
      "",
      "Factoree removed the `agents` block. The product page selects the runner of each role, and Factoree ignores the block.",
      "",
    );
  }
  if (report.warmProof === "passed") {
    lines.push("The bootstrap and the services also passed in a sandbox restored from a snapshot, as every run starts.", "");
  } else if (report.warmProof === "skipped") {
    lines.push("The sandbox provider takes no snapshots, so Factoree did not prove a warm restore. A run on it starts cold.", "");
  }
  // docs/specs/sandbox-memory-and-size.md. The peaks of the proof next to the sandbox size.
  if (report.resources !== undefined) {
    const { peakMemoryMb, peakDiskMb, memoryMb, diskMb } = report.resources;
    const share = (peak: number, total: number): string => (total > 0 ? ` (${Math.round((peak / total) * 100)}%)` : "");
    lines.push(
      "### Sandbox resources",
      "",
      `The proof used at most ${peakMemoryMb} MB of ${memoryMb} MB memory${share(peakMemoryMb, memoryMb)} and ${peakDiskMb} MB of ${diskMb} MB disk${share(peakDiskMb, diskMb)}.`,
      "",
    );
  }
  if (report.nuget !== undefined) lines.push(...renderNugetPrecheck(report.nuget));
  if ((report.derivedHosts ?? []).length > 0) {
    lines.push(
      "### Hosts the repository names",
      "",
      "The committed files name these hosts, and no allow list or host credential covers them. Add each one to the product allow list, or add a host credential for a private feed. Sandboxes reach public-internet hosts only.",
      "",
      ...(report.derivedHosts ?? []).map((entry) =>
        `- \`${entry.host}\`${entry.repository === undefined ? "" : ` (\`${entry.repository}\`)`}, from \`${entry.source}\``,
      ),
      "",
    );
  }
  lines.push("### Network", "");
  if (!report.egressRecorded) {
    lines.push("The sandbox provider records no egress, so the allow list is the whole ecosystem host list.");
  } else {
    lines.push(
      report.observedHosts.length === 0 ? "The bootstrap reached no host." : `The bootstrap reached: ${report.observedHosts.map((host) => `\`${host}\``).join(", ")}.`,
    );
    if ((report.credentialHosts ?? []).length > 0) {
      lines.push("", `The host credentials reached: ${(report.credentialHosts ?? []).map((host) => `\`${host}\``).join(", ")}.`);
    }
    if (report.deniedHosts.length > 0) {
      lines.push(
        "",
        `Denied, because they are outside the ecosystem host list: ${report.deniedHosts.map((host) => `\`${host}\``).join(", ")}. ` +
          "Add a host to the product allow list once, then run setup again.",
      );
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
};

const FIRST_ERROR = /\b(error|exception|fatal|failed)\b|\[FAIL\]/i;

/**
 * DI-21.14. The excerpt of a failed command in the setup report. A test runner prints the reason
 * of the first failure and then a list of every failed test, so the tail alone holds only names:
 * the anthology setup of 2026-11-05 reported 28 failed tests and no reason. The excerpt keeps the
 * lines from the first error on, and the tail.
 */
export const failureExcerpt = (log: string, headLines = 25, tailLines = 15, maxChars = 4000): string => {
  const lines = log.trim().split("\n");
  if (lines.length <= headLines + tailLines) return lines.join("\n").slice(-maxChars);
  const first = lines.findIndex((line) => FIRST_ERROR.test(line));
  const tail = lines.slice(-tailLines);
  if (first === -1 || first >= lines.length - tailLines) return lines.slice(-(headLines + tailLines)).join("\n").slice(-maxChars);
  const head = lines.slice(first, Math.min(first + headLines, lines.length - tailLines));
  const gap = lines.length - tailLines - (first + head.length);
  const excerpt = [...head, ...(gap > 0 ? [`… ${String(gap)} lines …`] : []), ...tail].join("\n");
  return excerpt.length <= maxChars ? excerpt : `${excerpt.slice(0, maxChars / 2)}\n…\n${excerpt.slice(-maxChars / 2)}`;
};
