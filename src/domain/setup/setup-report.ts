import { isMap, isSeq, parseDocument } from "yaml";

/**
 * docs/specs/repository-setup-and-services.md. One part of a proposed `.factoree/config.yaml` that
 * the setup proof checks on its own. The pull request holds only the parts that passed.
 */
export type SetupPartKind = "bootstrap" | "verify" | "services" | "preview" | "account";

export interface SetupPartResult {
  kind: SetupPartKind;
  /** The verify command name or the account name. The kind for the other parts. */
  name: string;
  passed: boolean;
  /** Why the part failed, in one line, or null when it passed. */
  reason: string | null;
  /** The last lines of the output of a failed part, already redacted. */
  logTail?: string;
}

/** The setup report: the result of every part, and what the setup sandbox reached. */
export interface SetupReport {
  parts: SetupPartResult[];
  /** The hosts the setup sandbox reached, when the provider records egress. */
  observedHosts: string[];
  /** The hosts outside the allow list that the setup sandbox tried, when the provider records egress. */
  deniedHosts: string[];
  /** False when the provider records no egress (E2B), so both host lists are empty. */
  egressRecorded: boolean;
  /** The fakes the proposal adds, by compose service and API. */
  fakes: Array<{ service: string; name: string }>;
  /** The app changes the setup agent names for parts it could not configure from `.factoree/`. */
  appChanges: string[];
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

const partLabel = (part: SetupPartResult): string =>
  part.kind === "verify" ? `verify command \`${part.name}\`` : part.kind === "account" ? `account \`${part.name}\`` : part.kind;

/** The pull request body and the report the product page shows. */
export const renderSetupReport = (report: SetupReport): string => {
  const lines: string[] = ["## Factoree setup", ""];
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
  }
  if (report.fakes.length > 0) {
    lines.push("### Fakes", "", ...report.fakes.map((fake) => `- ${fake.name}, answered by the compose service \`${fake.service}\`. Its data is not real.`), "");
  }
  if (report.appChanges.length > 0) {
    lines.push("### App changes a person must request", "", ...report.appChanges.map((change) => `- ${change}`), "");
  }
  lines.push("### Network", "");
  if (!report.egressRecorded) {
    lines.push("The sandbox provider records no egress, so the allow list is the whole ecosystem host list.");
  } else {
    lines.push(
      report.observedHosts.length === 0 ? "The bootstrap reached no host." : `The bootstrap reached: ${report.observedHosts.map((host) => `\`${host}\``).join(", ")}.`,
    );
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
