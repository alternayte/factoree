import type { GetFloorResponse } from "@/api/types.gen";

/**
 * docs/specs/factory-floor.md. The floor at one moment, computed from the API answer. Live and
 * replay share it: live asks for the present, replay for a moment of the window.
 */
export type FloorJson = GetFloorResponse;
export type FloorRunJson = FloorJson["runs"][number];
export type FloorSetupJson = FloorJson["setups"][number];
export type ToolKind = FloorJson["pulses"][number]["toolKind"];

/** The stations of one line, in order. The index is the position along the line. */
export const STATIONS = [
  { key: "intake", name: "Intake" },
  { key: "refinery", name: "Refinery" },
  { key: "prep", name: "Prep" },
  { key: "workshop", name: "Workshop" },
  { key: "test", name: "Test bench" },
  { key: "lab", name: "User lab" },
  { key: "inspect", name: "Inspection" },
  { key: "dock", name: "Shipping dock" },
  { key: "yard", name: "PR yard" },
  { key: "gate", name: "Deploy gate" },
] as const;
export type StationKey = (typeof STATIONS)[number]["key"];
export const stationIndex = (key: StationKey): number => STATIONS.findIndex((station) => station.key === key);

/** Where a crate is: a station, the reject bin, or gone through the deploy gate. */
export type Place = StationKey | "bin" | "gone";

/** The station of each running status. */
const STATUS_STATION: Record<string, StationKey> = {
  RECEIVED: "intake",
  WAITING_FOR_BLOCKERS: "intake",
  WAITING_FOR_UPDATE: "intake",
  QUEUED: "intake",
  REFINING: "refinery",
  WAITING_FOR_INPUT: "refinery",
  BLOCKED_TARGET: "refinery",
  RESOLVING_CONTEXT: "refinery",
  BUILDING_VALIDATION_CONTRACT: "refinery",
  PREPARING: "prep",
  IMPLEMENTING: "workshop",
  REPAIRING: "workshop",
  VERIFYING: "test",
  USER_VALIDATING: "lab",
  REVIEWING: "inspect",
  PUBLISHING: "dock",
};

const REJECTED = new Set(["FAILED", "FAILED_REVIEW", "FAILED_CONFIGURATION", "STALE_BASE", "BLOCKED_ROUTING", "CANCELLED"]);
/** The statuses that wait for a human. */
export const HUMAN_STATUSES = new Set(["WAITING_FOR_INPUT", "BLOCKED_TARGET", "READY_FOR_HUMAN"]);

/** How long an ended crate stays on the floor. */
const ENDED_VISIBLE_MS = 24 * 60 * 60 * 1000;
/** How long a merged crate with no deploy waits at the gate before it leaves. */
const MERGED_VISIBLE_MS = 60 * 60 * 1000;
/** How long a failed check marks its machine. */
export const ALERT_MS = 60_000;
/** A pulse older than this, in replay, belongs to a session that ended. */
const REPLAY_PULSE_MS = 15_000;
/** A session with no output for this long shows how long it is silent. */
export const SILENT_MS = 60_000;

export type Tone = "accent" | "warning" | "danger" | "success" | "idle";

export interface CrateState {
  run: FloorRunJson;
  place: Place;
  status: string;
  /** What the crate shows: the status in words, with its tone. */
  label: string;
  tone: Tone;
  /** When the crate reached its current status. */
  since: number;
  repairs: number;
  /** True while the crate waits for a human. */
  human: boolean;
  /** The station the crate came from, for the path it takes now. */
  from: Place | null;
  /** True when the move from `from` goes back on the repair belt. */
  repair: boolean;
  /** The ended mark at the dock: reported, or draft. */
  mark: "reported" | "draft" | "merged" | "deployed" | null;
}

export interface OperatorState {
  owner: string;
  role: string;
  toolKind: ToolKind;
  lastOutputAt: number;
  productId: string;
}

export interface SetupState {
  setup: FloorSetupJson;
  status: string;
}

export interface FloorMoment {
  at: number;
  crates: CrateState[];
  operators: OperatorState[];
  setups: SetupState[];
  /** The machines whose check failed within ALERT_MS, by product id and station. */
  alerts: Array<{ productId: string; station: StationKey }>;
  human: CrateState[];
  running: number;
}

const ms = (iso: string): number => new Date(iso).getTime();

/** The newest change at or before `at`, or null before the first change. */
const changeAt = <T extends { at: string }>(changes: T[], at: number): { change: T; index: number } | null => {
  let found: { change: T; index: number } | null = null;
  changes.forEach((change, index) => {
    if (ms(change.at) <= at) found = { change, index };
  });
  return found;
};

const placeOfStatus = (status: string): Place | null => STATUS_STATION[status] ?? (REJECTED.has(status) ? "bin" : null);

const TONE_OF_STATION: Partial<Record<Place, Tone>> = { intake: "idle", dock: "success", gate: "success", bin: "danger" };

const STATUS_WORDS: Record<string, string> = {
  RECEIVED: "Received",
  WAITING_FOR_BLOCKERS: "Waiting for blockers",
  WAITING_FOR_UPDATE: "Waiting for the update",
  QUEUED: "Queued",
  REFINING: "Refining",
  WAITING_FOR_INPUT: "Waiting for input",
  BLOCKED_TARGET: "Waits for a repository",
  RESOLVING_CONTEXT: "Resolving context",
  BUILDING_VALIDATION_CONTRACT: "Building the contract",
  PREPARING: "Preparing",
  IMPLEMENTING: "Implementing",
  REPAIRING: "Repairing",
  VERIFYING: "Verifying",
  USER_VALIDATING: "User validating",
  REVIEWING: "Reviewing",
  PUBLISHING: "Publishing",
  READY_FOR_HUMAN: "Ready for review",
  REPORTED: "Reported",
  DRAFT_PUBLISHED: "Draft published",
  STALE_BASE: "Stale base",
  FAILED_CONFIGURATION: "Failed: configuration",
  FAILED: "Failed",
  FAILED_REVIEW: "Failed review",
  CANCELLED: "Cancelled",
  BLOCKED_ROUTING: "Blocked: routing",
};
export const statusWords = (status: string): string => STATUS_WORDS[status] ?? status;

/**
 * Where one run is at `at`, or null when it is not on the floor: not created yet, or ended so
 * long ago that the floor dropped it.
 */
export const crateAt = (run: FloorRunJson, at: number): CrateState | null => {
  const current = changeAt(run.statuses, at);
  if (current === null) return null;
  const status = current.change.status;
  const since = ms(current.change.at);
  const previous = current.index > 0 ? run.statuses[current.index - 1]!.status : null;
  const repairs = run.statuses.filter((change, index) => index <= current.index && change.status === "REPAIRING").length;
  const base = { run, status, since, repairs, mark: null as CrateState["mark"] };

  const running = placeOfStatus(status);
  if (running !== null && running !== "bin") {
    const from = previous === null ? (run.followsPullRequest ? "yard" : null) : placeOfStatus(previous);
    const repair = running === "workshop" && from !== null && from !== "workshop" && from !== "refinery" && from !== "prep" && from !== "intake";
    const human = HUMAN_STATUSES.has(status);
    const tone: Tone = human ? "warning" : (TONE_OF_STATION[running] ?? "accent");
    return { ...base, place: running, label: statusWords(status), tone, human, from, repair };
  }

  // The run ended. Its pull requests decide where it is now.
  const opened = run.pullRequests.filter((pr) => ms(pr.openedAt) <= at);
  const open = opened.filter((pr) => pr.closedAt === null || ms(pr.closedAt) > at);
  const merged = opened.filter((pr) => pr.state === "merged" && pr.closedAt !== null && ms(pr.closedAt) <= at);
  const closed = opened.filter((pr) => pr.state === "closed" && pr.closedAt !== null && ms(pr.closedAt) <= at);
  const fromDock = { from: "dock" as Place, repair: false };
  if (open.length > 0) {
    return { ...base, ...fromDock, place: "yard", label: "PR open · waits for review", tone: "warning", human: true };
  }
  if (merged.length > 0) {
    const mergedAt = Math.max(...merged.map((pr) => ms(pr.closedAt!)));
    const deployed = run.deploys.filter((deploy) => deploy.state === "success" && ms(deploy.at) <= at);
    if (deployed.length > 0) {
      const deployedAt = Math.max(...deployed.map((deploy) => ms(deploy.at)));
      if (at - deployedAt > 60_000) return null;
      return { ...base, from: "gate", repair: false, place: "gone", since: deployedAt, label: `Deployed to ${deployed.at(-1)!.environment}`, tone: "success", human: false, mark: "deployed" };
    }
    if (at - mergedAt > MERGED_VISIBLE_MS) return null;
    const failedDeploy = run.deploys.some((deploy) => deploy.state === "failure" && ms(deploy.at) <= at);
    return {
      ...base,
      from: "yard",
      repair: false,
      place: "gate",
      since: mergedAt,
      label: failedDeploy ? "Merged · deploy failed" : "Merged",
      tone: failedDeploy ? "danger" : "success",
      human: false,
      mark: "merged",
    };
  }
  if (at - since > ENDED_VISIBLE_MS) return null;
  if (closed.length > 0) return { ...base, from: "yard", repair: false, place: "bin", label: "PR closed", tone: "danger", human: false };
  if (status === "REPORTED" || status === "DRAFT_PUBLISHED" || status === "READY_FOR_HUMAN") {
    return {
      ...base,
      ...fromDock,
      place: "dock",
      label: statusWords(status),
      tone: status === "DRAFT_PUBLISHED" ? "warning" : "success",
      human: status === "READY_FOR_HUMAN",
      mark: status === "REPORTED" ? "reported" : status === "DRAFT_PUBLISHED" ? "draft" : null,
    };
  }
  return { ...base, from: previous === null ? null : placeOfStatus(previous), repair: false, place: "bin", label: statusWords(status), tone: "danger", human: false };
};

/** The checks that failed into a repair within ALERT_MS before `at`, by machine. */
const alertsAt = (runs: FloorRunJson[], at: number): FloorMoment["alerts"] => {
  const alerts: FloorMoment["alerts"] = [];
  for (const run of runs) {
    run.statuses.forEach((change, index) => {
      if (change.status !== "REPAIRING" || index === 0) return;
      const when = ms(change.at);
      if (when > at || at - when > ALERT_MS) return;
      const place = placeOfStatus(run.statuses[index - 1]!.status);
      if (place === "test" || place === "lab" || place === "inspect") alerts.push({ productId: run.productId, station: place });
    });
  }
  return alerts;
};

/**
 * The floor at `at`. Live passes the present and the newest pulses. Replay passes a moment of the
 * window, and each session shows its newest pulse of the 15 seconds before it.
 */
export const floorAt = (floor: FloorJson, at: number, live: boolean): FloorMoment => {
  const crates = floor.runs.flatMap((run) => {
    const crate = crateAt(run, at);
    return crate === null ? [] : [crate];
  });
  const productOfRun = new Map(floor.runs.map((run) => [run.id, run.productId]));
  const productOfSetup = new Map(floor.setups.map((setup) => [setup.id, setup.productId]));
  const newest = new Map<string, FloorJson["pulses"][number]>();
  for (const pulse of floor.pulses) {
    const when = ms(pulse.at);
    if (!live && (when > at || at - when > REPLAY_PULSE_MS)) continue;
    const key = `${pulse.runId ?? `setup:${pulse.setupId ?? ""}`}:${pulse.role}`;
    const known = newest.get(key);
    if (known === undefined || ms(known.at) < when) newest.set(key, pulse);
  }
  const placeOfRun = new Map(crates.map((crate) => [crate.run.id, crate]));
  const operators: OperatorState[] = [];
  for (const pulse of newest.values()) {
    const productId = pulse.runId !== null ? productOfRun.get(pulse.runId) : productOfSetup.get(pulse.setupId ?? "");
    if (productId === undefined) continue;
    // A run that ended has no running session, whatever its last pulse said.
    if (pulse.runId !== null && (placeOfRun.get(pulse.runId) === undefined || isEnded(placeOfRun.get(pulse.runId)!))) continue;
    operators.push({
      owner: pulse.runId ?? `setup:${pulse.setupId ?? ""}`,
      role: pulse.role,
      toolKind: pulse.toolKind,
      lastOutputAt: ms(pulse.lastOutputAt),
      productId,
    });
  }
  const setups = floor.setups.flatMap((setup) => {
    const current = changeAt(setup.statuses, at);
    if (current === null) return [];
    const status = current.change.status;
    return status === "queued" || status === "running" ? [{ setup, status }] : [];
  });
  const human = crates.filter((crate) => crate.human);
  const running = crates.filter((crate) => !crate.human && !isEnded(crate) && crate.place !== "intake").length;
  return { at, crates, operators, setups, alerts: alertsAt(floor.runs, at), human, running };
};

/** True for a crate whose run ended: in the yard, at the gate, in the bin, gone or at the dock after its end. */
export const isEnded = (crate: CrateState): boolean =>
  crate.place === "yard" || crate.place === "gate" || crate.place === "bin" || crate.place === "gone" || crate.mark !== null || crate.status === "READY_FOR_HUMAN";

/** The machine where each role works. */
export const ROLE_STATION: Record<string, StationKey | "setup"> = {
  refiner: "refinery",
  implementer: "workshop",
  validator: "lab",
  reviewer: "inspect",
  setup: "setup",
};

/** docs/specs/floor-growth.md. The buildings a line gains from its lifetime merged pull requests. */
export const GROWTH = [
  { key: "racks", at: 5, name: "storage racks" },
  { key: "tanks", at: 25, name: "tank farm" },
  { key: "warehouse", at: 100, name: "warehouse" },
  { key: "trucks", at: 250, name: "truck bay" },
] as const;
export type GrowthKey = (typeof GROWTH)[number]["key"];

export const builtAt = (mergedTotal: number): Set<GrowthKey> => new Set(GROWTH.filter((tier) => mergedTotal >= tier.at).map((tier) => tier.key));

/** The next building of a line, or null when it has all of them. */
export const nextBuilding = (mergedTotal: number): (typeof GROWTH)[number] | null => GROWTH.find((tier) => mergedTotal < tier.at) ?? null;

/** The crew of each station: an agent role, or a Factoree bot. */
export const STATION_CREW: Partial<Record<StationKey, { kind: "agent" | "bot"; name: string }>> = {
  refinery: { kind: "agent", name: "refiner" },
  prep: { kind: "bot", name: "prep bot" },
  workshop: { kind: "agent", name: "implementer" },
  test: { kind: "bot", name: "check bot" },
  lab: { kind: "agent", name: "validator" },
  inspect: { kind: "agent", name: "reviewer" },
  dock: { kind: "bot", name: "dock bot" },
};
