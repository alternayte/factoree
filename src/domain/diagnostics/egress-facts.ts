import type { Sandbox, SandboxRef } from "~/domain/runs/sandbox.js";
import { hostHintsOf } from "./host-hints.js";

/** The sandbox a fault happened in, and its effective allow list, or null where none is known. */
export interface FaultSandbox {
  sandbox: Sandbox;
  ref: SandboxRef;
  allowList: readonly string[] | null;
}

export interface FaultEgressFacts {
  egress: "recorded" | "not_recorded" | "unreadable";
  deniedHosts: string[];
  hostHints: string[];
}

/**
 * docs/specs/run-diagnostics.md. The egress facts of one fault: the hosts the Kiln egress log
 * denied, and the host hints of the output tail. A read must happen before the sandbox is
 * destroyed. A failed read never fails the caller.
 */
export const faultEgressFacts = async (where: FaultSandbox | null, log: string | null): Promise<FaultEgressFacts> => {
  // A host hint needs the allow list. Without it every host in the output would read as a hint.
  const hostHints = where?.allowList == null ? [] : hostHintsOf(log, where.allowList);
  if (where === null || where.sandbox.egressLog === undefined) return { egress: "not_recorded", deniedHosts: [], hostHints };
  try {
    const records = await where.sandbox.egressLog(where.ref);
    if (records === null) return { egress: "not_recorded", deniedHosts: [], hostHints };
    // DI-21.20. A name with no dot is a local lookup, never a host the allow list could name.
    const deniedHosts = [
      ...new Set(records.filter((record) => record.decision === "denied" && record.host.includes(".")).map((record) => record.host)),
    ].sort();
    return { egress: "recorded", deniedHosts, hostHints };
  } catch {
    return { egress: "unreadable", deniedHosts: [], hostHints };
  }
};

/** The one-line message of a fault: its own sentence, then the denied hosts when the log has any. */
export const withDeniedHosts = (sentence: string, facts: FaultEgressFacts): string =>
  facts.deniedHosts.length === 0 ? sentence : `${sentence} The sandbox egress log denied ${facts.deniedHosts.join(", ")}.`;
