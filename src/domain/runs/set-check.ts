import type { AccountConfig, PreviewConfig, ServicesConfig, VerificationCommand } from "./project-runtime-config.js";
import type { BrowserLimits } from "~/domain/validation/browser-limits.js";
import type { PlanTargetRules } from "~/domain/validation/validation-plan.js";
import type { ProcessRef, Sandbox, SandboxRef } from "./sandbox.js";
import { pauseServices, startServices, type FakeService, type StackHosts } from "./services.js";
import { PreviewStartError, startPreview, stopPreview, type PreviewHandle, type ReadinessProbe } from "./preview.js";
import type { Redactor } from "~/telemetry/redaction.js";

/**
 * docs/specs/change-sets.md, slice 6. The set check: what a check sprite of a change set knows of
 * each target, which targets run together, and how a wired group starts and stops.
 */

/** DI-21.146. One target of a change set as its check sprite runs it. */
export interface SetCheckTarget {
  repository: string;
  path: string;
  /** The base SHA the target checked out, which the in-between check resets a consumer to. */
  baseSha: string;
  /** The compose stack of the target, with the compose project of the target, or null. */
  services: ServicesConfig | null;
  preview: PreviewConfig | null;
  accounts: AccountConfig[];
  browserLimits?: BrowserLimits;
  /** The environment of a command Factoree runs in the target: its MISE_CONFIG_FILE. */
  environment: Record<string, string>;
  /** The fakes of the stack of the target. */
  fakes: FakeService[];
  /**
   * DI-21.150. The compose services of the stack that can take `/etc/hosts` entries. Absent in a
   * fact an older worker recorded.
   */
  hostServices?: string[];
  /** The bootstrap command, which the in-between check runs again at the base of a consumer. */
  bootstrapCommand: string | null;
  /** The verify commands of the target, named `<owner/repo>: <name>`, with its folder. */
  verifyCommands: VerificationCommand[];
}

/**
 * docs/specs/change-sets.md, DI-21.145. A provider and a consumer whose consumer fake names the
 * provider repository. In the check sprite the provider preview answers on the published ports of
 * the fake, in its place.
 */
export interface WiredPair {
  provider: string;
  consumer: string;
  /** The compose service of the consumer that the provider replaces. */
  fake: string;
  /** The host ports the fake publishes, which forward to the provider preview. */
  ports: number[];
  /**
   * DI-21.150. The path under the service name of the fake: each consumer service resolves the
   * fake's name to `address`, the sandbox address the containers reach, and a forward on each of
   * `ports`, the fake's container ports, answers there for the provider preview. Absent when the
   * fake declares no container port or the sandbox has no such address.
   */
  byName?: { address: string; ports: number[] };
}

/** DI-21.148. A labelled pair that runs alone, each target with its own stack, and why. */
export interface UnwiredPair {
  provider: string;
  consumer: string;
  fake: string;
  reason: string;
}

/** DI-21.146. What a check sprite of a change set records for its checks. */
export interface SetCheckFacts {
  targets: SetCheckTarget[];
  pairs: WiredPair[];
  alone: UnwiredPair[];
}

/**
 * DI-21.150. The first global IPv4 address of the sandbox, which a container reaches through the
 * rootless network (slirp4netns) and which a forward of the sandbox can listen on. Null when none.
 * Rootless Docker refuses the loopback of the sandbox to a container, so `host-gateway` does not serve.
 */
export const hostAddressOf = async (sandbox: Sandbox, ref: SandboxRef): Promise<string | null> => {
  const result = await sandbox.exec(ref, { file: "ip", args: ["-4", "-o", "addr", "show", "scope", "global"], cwd: "/" });
  if (result.exitCode !== 0) return null;
  const match = /\binet (\d{1,3}(?:\.\d{1,3}){3})\//.exec(result.stdout);
  return match?.[1] ?? null;
};

const sameName = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** The port of an enabled preview, or null. */
export const previewPortOf = (preview: PreviewConfig | null): number | null => {
  if (preview === null || !preview.enabled) return null;
  try {
    const port = Number(new URL(preview.readyUrl).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
};

/**
 * DI-21.145, DI-21.146. The wired pairs of a change set and the labelled pairs that run alone. A
 * fake labelled with the name of another target makes a pair. A pair runs alone when the snapshot
 * of the set could not start it (`unwired`), when the provider has no enabled preview with a port,
 * when the fake publishes no port, or when two previews or forwarded ports of its group share a port.
 */
export const wireTargets = (
  targets: readonly SetCheckTarget[],
  unwired: readonly UnwiredPair[] = [],
  /** DI-21.150. The sandbox address a container reaches, from `hostAddressOf`, or null. */
  hostAddress: string | null = null,
): { pairs: WiredPair[]; alone: UnwiredPair[] } => {
  const pairs: WiredPair[] = [];
  const alone: UnwiredPair[] = [];
  for (const consumer of targets) {
    for (const fake of consumer.fakes) {
      if (fake.repository === undefined) continue;
      const provider = targets.find((candidate) => candidate !== consumer && sameName(candidate.repository, fake.repository ?? ""));
      if (provider === undefined) continue;
      const pair = { provider: provider.repository, consumer: consumer.repository, fake: fake.service };
      const known = unwired.find((entry) => sameName(entry.provider, pair.provider) && sameName(entry.consumer, pair.consumer));
      if (known !== undefined) {
        alone.push({ ...pair, reason: known.reason });
      } else if (previewPortOf(provider.preview) === null) {
        alone.push({ ...pair, reason: `${provider.repository} configures no enabled preview with a port, so nothing can answer in place of the fake` });
      } else {
        // DI-21.150. Two paths reach the provider: the host ports the fake publishes, and the
        // fake's service name inside the stack. One path is enough to wire the pair.
        const byName = hostAddress !== null && (fake.containerPorts ?? []).length > 0 ? { address: hostAddress, ports: fake.containerPorts ?? [] } : null;
        if ((fake.ports ?? []).length === 0 && byName === null) {
          const why =
            (fake.containerPorts ?? []).length === 0
              ? `the fake "${fake.service}" publishes no port and declares no container port`
              : `the fake "${fake.service}" publishes no port and the sandbox has no network address its containers can reach`;
          alone.push({ ...pair, reason: `${why}, so Factoree cannot point ${consumer.repository} at ${provider.repository}` });
        } else {
          pairs.push({ ...pair, ports: fake.ports ?? [], ...(byName === null ? {} : { byName }) });
        }
      }
    }
  }
  // Two processes cannot listen on one port. A group whose previews or forwarded ports collide runs alone.
  const byName = new Map(targets.map((target) => [target.repository, target]));
  let wired = pairs;
  for (const group of checkGroupsOf(targets, pairs)) {
    if (group.length < 2) continue;
    const ports = new Map<number, string>();
    let collision: string | null = null;
    const claim = (port: number, owner: string): void => {
      const holder = ports.get(port);
      if (holder !== undefined && collision === null) collision = `${holder} and ${owner} both use port ${String(port)}`;
      ports.set(port, owner);
    };
    for (const name of group) {
      const port = previewPortOf(byName.get(name)?.preview ?? null);
      if (port !== null) claim(port, `the preview of ${name}`);
    }
    for (const pair of pairs.filter((candidate) => group.includes(candidate.consumer))) {
      for (const port of pair.ports) claim(port, `the fake "${pair.fake}" of ${pair.consumer}`);
      for (const port of serviceForwardPortsOf(pair, byName.get(pair.provider)?.preview ?? null)) {
        claim(port, `the service name of the fake "${pair.fake}" of ${pair.consumer}`);
      }
    }
    if (collision === null) continue;
    for (const pair of pairs.filter((candidate) => group.includes(candidate.consumer))) {
      alone.push({ provider: pair.provider, consumer: pair.consumer, fake: pair.fake, reason: `${collision as string}, so the group cannot run together` });
    }
    wired = wired.filter((candidate) => !group.includes(candidate.consumer));
  }
  return { pairs: wired, alone };
};

/**
 * DI-21.150. The container ports of a pair that get their own forward on the sandbox address: not
 * a port the fake publishes, whose forward listens on every address already, and not the port of
 * the provider preview, which answers there itself.
 */
export const serviceForwardPortsOf = (pair: WiredPair, providerPreview: PreviewConfig | null): number[] => {
  const previewPort = previewPortOf(providerPreview);
  return (pair.byName?.ports ?? []).filter((port) => !pair.ports.includes(port) && port !== previewPort);
};

/**
 * DI-21.150. The `/etc/hosts` entries of a consumer stack in a wired group: each service of the
 * stack, except the fakes the group replaces, resolves the name of each replaced fake that has a
 * path by name to the sandbox address.
 */
export const stackHostsOf = (target: SetCheckTarget, pairs: readonly WiredPair[]): StackHosts | undefined => {
  const own = pairs.filter((pair) => pair.consumer === target.repository);
  const entries = own.flatMap((pair) => (pair.byName === undefined ? [] : [`${pair.fake}:${pair.byName.address}`]));
  if (entries.length === 0) return undefined;
  const replaced = new Set(own.map((pair) => pair.fake));
  return { services: (target.hostServices ?? []).filter((service) => !replaced.has(service)), entries };
};

/**
 * DI-21.146. The groups of a check sprite in set order: each wired component together, and every
 * other target alone. A group lists its targets in set order.
 */
export const checkGroupsOf = (targets: readonly { repository: string }[], pairs: readonly WiredPair[]): string[][] => {
  const names = targets.map((target) => target.repository);
  const group = new Map(names.map((name) => [name, name]));
  const root = (name: string): string => {
    let current = name;
    while (group.get(current) !== current) current = group.get(current) ?? current;
    return current;
  };
  for (const pair of pairs) {
    const left = root(pair.provider);
    const right = root(pair.consumer);
    if (left !== right) group.set(right, left);
  }
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const key = root(name);
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  return [...groups.values()];
};

/** The pairs inside one group. */
export const pairsIn = (group: readonly string[], pairs: readonly WiredPair[]): WiredPair[] =>
  pairs.filter((pair) => group.includes(pair.consumer) && group.includes(pair.provider));

/**
 * DI-21.147. The target a `set` entry runs against: the one wired group of the run, through the
 * one consumer of it that no target of the group consumes. Null when no group or several, or when
 * the group has no such single consumer.
 */
export const setServerOf = (facts: Pick<SetCheckFacts, "targets" | "pairs">): string | null => {
  const wiredGroups = checkGroupsOf(facts.targets, facts.pairs).filter((group) => group.length > 1);
  if (wiredGroups.length !== 1) return null;
  const inGroup = pairsIn(wiredGroups[0] ?? [], facts.pairs);
  const tops = [...new Set(inGroup.map((pair) => pair.consumer))].filter((consumer) => !inGroup.some((pair) => pair.provider === consumer));
  return tops.length === 1 ? (tops[0] ?? null) : null;
};

/** DI-21.147. What an entry of the plan may name in this check sprite. */
export const planTargetRulesOf = (facts: SetCheckFacts): PlanTargetRules => ({
  targets: facts.targets.map((target) => ({ repository: target.repository, accounts: target.accounts.map((account) => account.name) })),
  setServer: setServerOf(facts),
});

/** DI-21.148. One line per pair that ran alone, for "Needs your attention". */
export const aloneNotes = (alone: readonly UnwiredPair[]): string[] =>
  alone.map(
    (pair) =>
      `Factoree tested ${pair.consumer} and ${pair.provider} alone, with the fake "${pair.fake}" in place of ${pair.provider}, because ${pair.reason.replace(/[.\s]+$/, "")}. ` +
      "Check the call between them yourself.",
  );

/**
 * DI-21.146, DI-21.150. A small TCP forward in the sandbox's Node, from a fake's port on an address
 * to the provider preview.
 */
const FORWARD_SCRIPT =
  "const net=require('net');const [from,to]=process.argv.slice(1,3).map(Number);const host=process.argv[3]||'0.0.0.0';" +
  "net.createServer((c)=>{const u=net.connect(to,'127.0.0.1');c.pipe(u);u.pipe(c);" +
  "c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());}).listen(from,host);";

/** The time a forward gets to listen. */
const FORWARD_WAIT = "for i in $(seq 1 100); do ss -ltnH \"sport = :$0\" | grep -q . && exit 0; sleep 0.1; done; exit 1";

export interface GroupDependencies {
  sandbox: Sandbox;
  probe: ReadinessProbe;
  redactor: Redactor;
}

/** DI-21.146. A wired group that runs: its forwards and the previews it started. */
export interface RunningGroup {
  group: string[];
  forwards: ProcessRef[];
  previews: Map<string, PreviewHandle>;
  /** Why a preview of the group did not start, or null. */
  problem: { repository: string; reason: string; log: string } | null;
}

/**
 * DI-21.146. Starts one group of a check sprite: the stack of each target, without each fake a
 * provider of the group replaces, the forward from each of its ports to the provider preview, and
 * the preview of each provider. `previews: "all"` starts the preview of every target of the group,
 * as the build-ahead of a set does to learn whether the group fits.
 */
export const startGroup = async (
  dependencies: GroupDependencies,
  ref: SandboxRef,
  facts: Pick<SetCheckFacts, "targets" | "pairs">,
  group: readonly string[],
  options: { previews: "providers" | "all"; environment: Record<string, string> },
): Promise<RunningGroup> => {
  const inGroup = pairsIn(group, facts.pairs);
  const targets = facts.targets.filter((target) => group.includes(target.repository));
  const running: RunningGroup = { group: [...group], forwards: [], previews: new Map(), problem: null };
  // The target whose forward or preview starts, so a failure names it.
  let starting = group[0] ?? "";
  try {
    for (const target of targets) {
      if (target.services === null) continue;
      const replaced = inGroup.filter((pair) => pair.consumer === target.repository).map((pair) => pair.fake);
      await startServices(dependencies.sandbox, ref, target.path, target.services, replaced, stackHostsOf(target, inGroup));
    }
    for (const pair of inGroup) {
      const provider = targets.find((target) => target.repository === pair.provider);
      const to = previewPortOf(provider?.preview ?? null);
      if (to === null) continue;
      starting = pair.provider;
      const listens = [
        ...pair.ports.map((port) => ({ from: port, host: "0.0.0.0" })),
        ...serviceForwardPortsOf(pair, provider?.preview ?? null).map((port) => ({ from: port, host: pair.byName?.address ?? "0.0.0.0" })),
      ];
      for (const { from, host } of listens) {
        running.forwards.push(
          await dependencies.sandbox.startProcess(ref, { file: "node", args: ["-e", FORWARD_SCRIPT, String(from), String(to), host], cwd: "/" }),
        );
        const listening = await dependencies.sandbox.exec(ref, { file: "sh", args: ["-c", FORWARD_WAIT, String(from)], cwd: "/" });
        if (listening.exitCode !== 0) {
          throw new PreviewStartError(`The forward from port ${String(from)} to ${pair.provider} did not listen.`, "not_ready", "");
        }
      }
    }
    const providers = new Set(inGroup.map((pair) => pair.provider));
    for (const target of targets) {
      if (options.previews === "providers" && !providers.has(target.repository)) continue;
      if (target.preview === null || !target.preview.enabled) continue;
      starting = target.repository;
      running.previews.set(
        target.repository,
        await startPreview({
          sandbox: dependencies.sandbox,
          ref,
          workingDirectory: target.path,
          preview: target.preview,
          environment: { ...options.environment, ...target.environment },
          probe: dependencies.probe,
          redactor: dependencies.redactor,
        }),
      );
    }
    // DI-21.150. A fake whose container port is the provider preview port: the preview listens
    // first, and a forward on the sandbox address serves a preview that listens on the loopback
    // only. When the preview listens on every address, the forward cannot listen and the preview
    // answers itself.
    for (const pair of inGroup) {
      const provider = targets.find((target) => target.repository === pair.provider);
      const port = previewPortOf(provider?.preview ?? null);
      if (port === null || pair.byName === undefined || !pair.byName.ports.includes(port) || pair.ports.includes(port)) continue;
      starting = pair.provider;
      running.forwards.push(
        await dependencies.sandbox.startProcess(ref, { file: "node", args: ["-e", FORWARD_SCRIPT, String(port), String(port), pair.byName.address], cwd: "/" }),
      );
    }
  } catch (error) {
    if (!(error instanceof PreviewStartError)) {
      await stopGroup(dependencies.sandbox, ref, facts, running);
      throw error;
    }
    running.problem = { repository: starting, reason: dependencies.redactor.redactText(error.message), log: dependencies.redactor.redactText(error.log) };
  }
  return running;
};

/** DI-21.146. Stops the previews and the forwards of a group, and pauses each of its stacks. */
export const stopGroup = async (
  sandbox: Sandbox,
  ref: SandboxRef,
  facts: Pick<SetCheckFacts, "targets">,
  running: RunningGroup,
): Promise<void> => {
  for (const handle of running.previews.values()) await stopPreview(sandbox, ref, handle).catch(() => undefined);
  running.previews.clear();
  for (const forward of running.forwards) await sandbox.cancelProcess(ref, forward).catch(() => undefined);
  running.forwards = [];
  for (const target of facts.targets.filter((candidate) => running.group.includes(candidate.repository))) {
    if (target.services !== null) await pauseServices(sandbox, ref, target.path, target.services);
  }
};
