import "./floor.css";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getFloorOptions,
  getFloorReplayOptions,
  getRunOptions,
  listRepositorySetupHistoryOptions,
} from "@/api/@tanstack/react-query.gen";
import { Maximize2, Minimize2 } from "lucide-react";
import { Alert, Badge, Empty, ErrorAlert, KeyValue, Loading, PageHeader, Skeleton, SkeletonRows } from "@/components/layout";
import { SetupDetail } from "@/features/products/setup-history-page";
import { Diagnosis } from "@/features/runs/run-events";
import { formatCost, formatDuration, issueIdentifier, statusTone } from "@/features/runs/run-format";
import { RunEvents, Sessions, StageTimeline, Targets } from "@/features/runs/run-page";
import { useMe } from "@/lib/session";
import { pickWorkspace } from "@/lib/workspace";
import {
  ROLE_STATION,
  SILENT_MS,
  STATIONS,
  crateAt,
  floorAt,
  statusWords,
  type CrateState,
  type FloorJson,
  type FloorMoment,
  type StationKey,
} from "./model";
import { FloorScene, loadModels, type Pick } from "./scene";
import { REPLAY_SPEEDS, type FloorSearch } from "./search";

const MAX_REPLAY_MS = 7 * 24 * 60 * 60 * 1000;
const LIVE_POLL_MS = 5_000;

const formatClock = (at: number, withDay: boolean): string =>
  new Date(at).toLocaleString(undefined, withDay ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const hasWebGl = (): boolean => {
  try {
    const canvas = document.createElement("canvas");
    return canvas.getContext("webgl2") !== null || canvas.getContext("webgl") !== null;
  } catch {
    return false;
  }
};

/** docs/specs/factory-floor.md. The factory floor of a workspace: live, or a replay of a past window. */
export function FloorPage({ search }: { search: FloorSearch }) {
  const me = useMe();
  const workspace = pickWorkspace(me.data?.memberships ?? [], search.ws);
  const linearWorkspaceId = workspace?.linearWorkspaceId ?? "";
  const replay = search.from !== undefined && search.to !== undefined;
  const live = useQuery({
    ...getFloorOptions({ query: { linearWorkspaceId } }),
    enabled: Boolean(workspace) && !replay,
    refetchInterval: LIVE_POLL_MS,
  });
  const past = useQuery({
    ...getFloorReplayOptions({ query: { linearWorkspaceId, from: search.from ?? "", to: search.to ?? "" } }),
    enabled: Boolean(workspace) && replay,
    staleTime: Infinity,
  });
  const floor = replay ? past : live;
  const [webGl] = useState(hasWebGl);

  if (!workspace) {
    return (
      <>
        <PageHeader title="Floor" />
        <Alert tone="info">You are a member of no workspace where Factoree is installed.</Alert>
      </>
    );
  }
  if (!webGl) {
    return (
      <>
        <PageHeader title="Floor" />
        <Alert tone="info" title="This browser has no WebGL">
          The factory floor draws in WebGL.{" "}
          <Link to="/runs" search={{ ws: linearWorkspaceId }} className="link">
            Open the Runs list
          </Link>{" "}
          for the same runs.
        </Alert>
      </>
    );
  }
  if (floor.isError) {
    return (
      <>
        <PageHeader title="Floor" />
        <ErrorAlert error={floor.error} title="The factory floor did not load" />
      </>
    );
  }
  if (floor.data === undefined) {
    return (
      <Loading label="Loading the factory floor">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-4 h-[60vh] w-full" />
      </Loading>
    );
  }
  return <Floor floor={floor.data} receivedAt={floor.dataUpdatedAt} search={search} linearWorkspaceId={linearWorkspaceId} replay={replay} />;
}

function Floor({
  floor,
  receivedAt,
  search,
  linearWorkspaceId,
  replay,
}: {
  floor: FloorJson;
  receivedAt: number;
  search: FloorSearch;
  linearWorkspaceId: string;
  replay: boolean;
}) {
  const navigate = useNavigate();
  const stage = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const scene = useRef<FloorScene | null>(null);
  const [sceneError, setSceneError] = useState<unknown>(null);
  const [ready, setReady] = useState(false);
  const [pick, setPick] = useState<Pick | null>(search.run !== undefined ? { kind: "run", id: search.run } : null);
  const [panel, setPanel] = useState(search.run !== undefined);
  const reducedMotion = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  // The clock. Live follows the server time of the newest answer. Replay plays the window.
  const from = Date.parse(floor.from);
  const to = Date.parse(floor.to);
  const offset = Date.parse(floor.generatedAt) - receivedAt;
  const [at, setAt] = useState(() => (replay ? (search.run !== undefined ? runStart(floor, search.run) ?? from : from) : Date.now() + offset));
  const [playing, setPlaying] = useState(!reducedMotion);
  const speed = search.speed ?? (replay ? 60 : 1);
  useEffect(() => {
    if (!replay) {
      const timer = setInterval(() => setAt(Date.now() + offset), 250);
      return () => clearInterval(timer);
    }
    if (!playing) return;
    const timer = setInterval(() => setAt((value) => Math.min(to, value + 250 * speed)), 250);
    return () => clearInterval(timer);
  }, [replay, playing, speed, offset, to]);

  const moment: FloorMoment = useMemo(() => floorAt(floor, at, !replay), [floor, at, replay]);

  // The scene: built once the models load, kept for the life of the page.
  useEffect(() => {
    const container = stage.current;
    if (container === null) return;
    let disposed = false;
    loadModels()
      .then((models) => {
        if (disposed) return;
        scene.current = new FloorScene(container, models, {
          reducedMotion,
          onPick: (next) => {
            setPick(next);
            setPanel(next !== null);
          },
          onAnchor: (point) => {
            const element = bubble.current;
            if (element === null) return;
            element.hidden = point === null;
            if (point !== null) element.style.transform = `translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px)`;
          },
        });
        setReady(true);
      })
      .catch((error: unknown) => setSceneError(error));
    return () => {
      disposed = true;
      scene.current?.dispose();
      scene.current = null;
    };
  }, [reducedMotion]);

  useEffect(() => {
    scene.current?.setLines(floor.lines);
  }, [floor.lines, ready]);
  useEffect(() => {
    scene.current?.setMoment(moment);
  }, [moment, ready]);
  useEffect(() => {
    scene.current?.select(pick);
  }, [pick, ready]);

  const nextHuman = useRef(0);
  const showHuman = () => {
    if (moment.human.length === 0) return;
    const crate = moment.human[nextHuman.current % moment.human.length]!;
    nextHuman.current += 1;
    setPick({ kind: "run", id: crate.run.id });
    setPanel(true);
    scene.current?.focusRun(crate.run.id);
  };

  const setSearch = (next: Partial<FloorSearch>, replace = false) =>
    void navigate({ to: "/floor", search: (previous: FloorSearch) => (replace ? { ...(previous.ws ? { ws: previous.ws } : {}), ...next } : { ...previous, ...next }) });

  const startReplay = () => {
    const end = Date.now();
    setSearch({ from: new Date(end - 24 * 60 * 60 * 1000).toISOString(), to: new Date(end).toISOString(), speed: 60 }, true);
  };
  const approximate = moment.crates.some((crate) => crate.run.approximate);

  // docs/specs/floor-full-screen.md. Full screen on the stage, or the stage fixed over the window
  // where the browser has no full screen API for it.
  const [fullScreen, setFullScreen] = useState(false);
  const [fixed, setFixed] = useState(false);
  useEffect(() => {
    const changed = () => setFullScreen(document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    if (!fixed) return;
    const leave = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFixed(false);
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [fixed]);
  const toggleFullScreen = () => {
    const element = stage.current;
    if (element === null) return;
    if (fullScreen) {
      void document.exitFullscreen();
      return;
    }
    if (fixed) {
      setFixed(false);
      return;
    }
    if (document.fullscreenEnabled && typeof element.requestFullscreen === "function") {
      element.requestFullscreen().catch(() => setFixed(true));
      return;
    }
    setFixed(true);
  };
  const expanded = fullScreen || fixed;
  const title = replay ? `Replay of ${formatClock(from, true)} to ${formatClock(to, true)}` : "Live";

  if (sceneError !== null) return <ErrorAlert error={sceneError} title="The factory floor models did not load" />;

  return (
    <>
      <h1 className="sr-only">Floor</h1>
      <div
        className="floor-stage"
        ref={stage}
        role="region"
        aria-label="Factory floor"
        data-panel={panel && pick !== null ? "true" : "false"}
        data-fixed={fixed ? "true" : "false"}
      >
        <div className="floor-hud">
          <span className="floor-chip floor-title">
            Floor <span className="text-mute">·</span> <span className={replay ? "text-body" : "text-success"}>{title}</span>
          </span>
          <button type="button" className="floor-chip" data-tone="warn" onClick={showHuman} title="Pan to the next work item that waits for a human">
            <span className="floor-dot" />
            Needs a human <b>{moment.human.length}</b>
          </button>
          <span className="floor-chip">
            <span className="floor-dot" style={{ color: "var(--accent)" }} />
            Running <b>{moment.running}</b>
          </span>
          <Throughput days={floor.throughput} />
          {approximate ? <span className="floor-chip">Approximate times on older runs</span> : null}
          {!replay && moment.running === 0 ? (
            // docs/specs/factory-floor.md. A quiet floor offers the week that already happened.
            <button
              type="button"
              className="floor-chip"
              onClick={() => {
                const end = Date.now();
                setSearch({ from: new Date(end - MAX_REPLAY_MS).toISOString(), to: new Date(end).toISOString(), speed: 120 }, true);
              }}
            >
              Quiet now · <b>Replay the last 7 days</b>
            </button>
          ) : null}
          {!ready ? <span className="floor-chip">Loading the factory…</span> : null}
        </div>
        <div ref={bubble} className="floor-bubble" hidden>
          {pick !== null ? <BubbleContent pick={pick} floor={floor} moment={moment} onDetails={() => setPanel(true)} /> : null}
        </div>
        {panel && pick !== null ? (
          <aside className="floor-panel" aria-label="Details">
            <PanelContent
              pick={pick}
              floor={floor}
              moment={moment}
              linearWorkspaceId={linearWorkspaceId}
              onClose={() => setPanel(false)}
              onPick={(next) => setPick(next)}
              onReplayRun={(id) => {
                const window = runWindow(floor, id, Date.now());
                if (window !== null) setSearch({ from: window.from, to: window.to, run: id, speed: 60 });
              }}
            />
          </aside>
        ) : null}
        <div className="floor-bar">
          <div className="floor-seg" role="group" aria-label="Mode">
            <button type="button" aria-pressed={!replay} onClick={() => setSearch({}, true)}>
              Live
            </button>
            <button type="button" aria-pressed={replay} onClick={() => (replay ? undefined : startReplay())}>
              Replay
            </button>
          </div>
          {replay ? (
            <>
              <button type="button" className="floor-icon-button" onClick={() => setPlaying((value) => !value)} aria-label={playing ? "Pause" : "Play"}>
                {playing ? "❚❚" : "▶"}
              </button>
              <div className="floor-seg" role="group" aria-label="Speed">
                {REPLAY_SPEEDS.map((value) => (
                  <button key={value} type="button" aria-pressed={speed === value} onClick={() => setSearch({ speed: value })}>
                    {value}×
                  </button>
                ))}
              </div>
              <input
                type="range"
                aria-label="Replay position"
                min={from}
                max={to}
                step={1000}
                value={Math.min(to, Math.max(from, at))}
                onChange={(event) => setAt(Number(event.target.value))}
              />
              <ReplayWindow from={from} to={to} onChange={(window) => setSearch(window)} />
            </>
          ) : (
            <span className="ml-auto font-mono text-xs text-success">● live</span>
          )}
          <span className="font-mono text-xs text-ink tabular-nums">{formatClock(at, replay)}</span>
          <button type="button" className="floor-icon-button" aria-label="Zoom out" onClick={() => scene.current?.zoomBy(1 / 1.25)}>
            −
          </button>
          <button type="button" className="floor-icon-button" aria-label="Zoom in" onClick={() => scene.current?.zoomBy(1.25)}>
            +
          </button>
          <button
            type="button"
            className="floor-icon-button grid place-items-center"
            aria-label={expanded ? "Leave full screen" : "Full screen"}
            aria-pressed={expanded}
            title={expanded ? "Leave full screen (Esc)" : "Full screen"}
            onClick={toggleFullScreen}
          >
            {expanded ? <Minimize2 className="h-3.5 w-3.5" aria-hidden /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden />}
          </button>
        </div>
      </div>
    </>
  );
}

/** The window choices of a replay: the last day or the last week, both inside the 7-day cap. */
function ReplayWindow({ from, to, onChange }: { from: number; to: number; onChange: (window: { from: string; to: string }) => void }) {
  const span = to - from;
  const choose = (ms: number) => {
    const end = Date.now();
    onChange({ from: new Date(end - Math.min(ms, MAX_REPLAY_MS)).toISOString(), to: new Date(end).toISOString() });
  };
  return (
    <div className="floor-seg" role="group" aria-label="Window">
      <button type="button" aria-pressed={Math.abs(span - 24 * 3_600_000) < 60_000} onClick={() => choose(24 * 3_600_000)}>
        24h
      </button>
      <button type="button" aria-pressed={Math.abs(span - MAX_REPLAY_MS) < 60_000} onClick={() => choose(MAX_REPLAY_MS)}>
        7d
      </button>
    </div>
  );
}

/** The first status time of a run, where a single-run replay starts. */
function runStart(floor: FloorJson, id: string): number | null {
  const run = floor.runs.find((entry) => entry.id === id);
  return run === undefined || run.statuses.length === 0 ? null : Date.parse(run.statuses[0]!.at);
}

/** The replay window of one run: from a minute before its first status to ten minutes after its last change. */
function runWindow(floor: FloorJson, id: string, now: number): { from: string; to: string } | null {
  const run = floor.runs.find((entry) => entry.id === id);
  if (run === undefined || run.statuses.length === 0) return null;
  const times = [
    ...run.statuses.map((change) => Date.parse(change.at)),
    ...run.pullRequests.flatMap((pr) => (pr.closedAt === null ? [] : [Date.parse(pr.closedAt)])),
    ...run.deploys.map((deploy) => Date.parse(deploy.at)),
  ];
  const end = Math.min(now, Math.max(...times) + 10 * 60_000);
  const start = Math.max(end - MAX_REPLAY_MS, Math.min(...times) - 60_000);
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

function Throughput({ days }: { days: FloorJson["throughput"] }) {
  const arrived = days.reduce((sum, day) => sum + day.arrived, 0);
  const merged = days.reduce((sum, day) => sum + day.merged, 0);
  const top = Math.max(1, ...days.map((day) => Math.max(day.arrived, day.merged)));
  const points = (key: "arrived" | "merged") =>
    days.map((day, index) => `${(2 + (index / Math.max(1, days.length - 1)) * 92).toFixed(1)},${(20 - (day[key] / top) * 17).toFixed(1)}`).join(" ");
  return (
    <span className="floor-chip" title="Work items in and pull requests merged per day">
      {days.length > 1 ? (
        <svg width="96" height="22" viewBox="0 0 96 22" aria-hidden="true" className="max-sm:hidden">
          <polyline fill="none" stroke="var(--accent-text)" strokeWidth="1.5" points={points("arrived")} />
          <polyline fill="none" stroke="var(--success)" strokeWidth="1.5" points={points("merged")} />
        </svg>
      ) : null}
      <span>
        <span className="text-accent-text">
          In <b>{arrived}</b>
        </span>{" "}
        ·{" "}
        <span className="text-success">
          Merged <b>{merged}</b>
        </span>{" "}
        · {days.length}d
      </span>
    </span>
  );
}

function stationName(key: StationKey): string {
  return STATIONS.find((station) => station.key === key)?.name ?? key;
}

/** Level 1: one line of facts that follows the object. */
function BubbleContent({ pick, floor, moment, onDetails }: { pick: Pick; floor: FloorJson; moment: FloorMoment; onDetails: () => void }) {
  if (pick.kind === "run") {
    const crate = moment.crates.find((entry) => entry.run.id === pick.id);
    if (crate === undefined) return null;
    const operator = moment.operators.find((entry) => entry.owner === crate.run.id && ROLE_STATION[entry.role] === crate.place);
    const identifier = issueIdentifier(crate.run.url);
    return (
      <>
        <div className="flex items-center justify-between gap-2 font-mono text-xs text-accent-text">
          <span>{identifier ?? crate.run.id.slice(0, 8)}</span>
          <Badge tone={toneBadge(crate)}>{crate.label}</Badge>
        </div>
        <div className="text-sm text-ink">{crate.run.title ?? "Untitled work item"}</div>
        <div className="flex flex-wrap gap-x-2.5 gap-y-1 font-mono text-[11.5px] text-body tabular-nums">
          <span>attempt {crate.repairs + 1}</span>
          <span>{formatDuration(moment.at - crate.since)} here</span>
          <span>
            repairs {crate.repairs}/{crate.run.repairLimit}
          </span>
          {operator ? <span>{moment.at - operator.lastOutputAt > SILENT_MS ? "silent" : operator.toolKind}</span> : null}
          {crate.run.approximate ? <span className="text-mute">approximate times</span> : null}
        </div>
        <div className="flex items-center justify-between gap-2">
          {crate.run.url ? (
            <a className="link font-mono text-xs" href={crate.run.url} target="_blank" rel="noreferrer">
              Open in Linear ↗
            </a>
          ) : (
            <span />
          )}
          <button type="button" className="rounded-[2px] bg-accent px-2 py-1.5 font-mono text-xs text-accent-ink" onClick={onDetails}>
            Details
          </button>
        </div>
      </>
    );
  }
  if (pick.kind === "station") {
    const crates = moment.crates.filter((entry) => entry.run.productId === pick.productId && entry.place === pick.station);
    const line = floor.lines.find((entry) => entry.productId === pick.productId);
    return (
      <>
        <div className="font-mono text-xs text-accent-text">
          {stationName(pick.station)} · {line?.teamKey}
        </div>
        <div className="text-sm text-ink">{crates.length === 0 ? "Empty" : `${crates.length} work ${crates.length === 1 ? "item" : "items"} here`}</div>
        <BubbleDetails onDetails={onDetails} />
      </>
    );
  }
  if (pick.kind === "line") {
    const line = floor.lines.find((entry) => entry.productId === pick.productId);
    const crates = moment.crates.filter((entry) => entry.run.productId === pick.productId);
    return (
      <>
        <div className="font-mono text-xs text-accent-text">
          {line?.name} · {line?.teamKey}
        </div>
        <div className="text-sm text-ink">
          {crates.length} on the line · {crates.filter((crate) => crate.human).length} need a human
        </div>
        <BubbleDetails onDetails={onDetails} />
      </>
    );
  }
  const setup = moment.setups.find((entry) => entry.setup.id === pick.id);
  return (
    <>
      <div className="font-mono text-xs text-warning">Setup run</div>
      <div className="text-sm text-ink">{setup?.setup.repository ?? "Ended"}</div>
      <BubbleDetails onDetails={onDetails} />
    </>
  );
}

function BubbleDetails({ onDetails }: { onDetails: () => void }) {
  return (
    <div className="flex justify-end">
      <button type="button" className="rounded-[2px] bg-accent px-2 py-1.5 font-mono text-xs text-accent-ink" onClick={onDetails}>
        Details
      </button>
    </div>
  );
}

const toneBadge = (crate: CrateState) =>
  crate.tone === "danger" ? "danger" : crate.tone === "warning" ? "warning" : crate.tone === "success" ? "success" : crate.tone === "idle" ? "neutral" : "accent";

/** Level 2: the sections of the full page, without their actions, and the link to the page. */
function PanelContent({
  pick,
  floor,
  moment,
  linearWorkspaceId,
  onClose,
  onPick,
  onReplayRun,
}: {
  pick: Pick;
  floor: FloorJson;
  moment: FloorMoment;
  linearWorkspaceId: string;
  onClose: () => void;
  onPick: (pick: Pick) => void;
  onReplayRun: (id: string) => void;
}) {
  const close = (
    <button type="button" className="floor-icon-button absolute top-2.5 right-2.5" aria-label="Close details" onClick={onClose}>
      ×
    </button>
  );
  if (pick.kind === "run") return <RunPanel runId={pick.id} floor={floor} linearWorkspaceId={linearWorkspaceId} close={close} onReplayRun={onReplayRun} />;
  if (pick.kind === "station") return <StationPanel productId={pick.productId} station={pick.station} floor={floor} moment={moment} close={close} onPick={onPick} />;
  if (pick.kind === "line") return <LinePanel productId={pick.productId} floor={floor} moment={moment} linearWorkspaceId={linearWorkspaceId} close={close} onPick={onPick} />;
  return <SetupPanel setupId={pick.id} floor={floor} linearWorkspaceId={linearWorkspaceId} close={close} />;
}

function PanelFrame({ eyebrow, title, close, children, footer }: { eyebrow: ReactNode; title: ReactNode; close: ReactNode; children: ReactNode; footer: ReactNode }) {
  return (
    <>
      <header className="relative flex flex-col gap-1.5 border-b border-hairline px-4 pt-3.5 pb-3">
        {close}
        <div className="pr-9 font-mono text-xs text-accent-text">{eyebrow}</div>
        <h2 className="pr-9 text-[15px] font-semibold text-ink">{title}</h2>
      </header>
      <div className="floor-panel-body">{children}</div>
      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-4 py-3">
        <span className="font-mono text-[11px] text-mute">Read-only. Actions are on the full page.</span>
        {footer}
      </footer>
    </>
  );
}

function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="t-label mb-2">{title}</h3>
      {children}
    </section>
  );
}

function RunPanel({
  runId,
  floor,
  linearWorkspaceId,
  close,
  onReplayRun,
}: {
  runId: string;
  floor: FloorJson;
  linearWorkspaceId: string;
  close: ReactNode;
  onReplayRun: (id: string) => void;
}) {
  const run = useQuery({ ...getRunOptions({ path: { id: runId }, query: { linearWorkspaceId } }), refetchInterval: LIVE_POLL_MS });
  const floorRun = floor.runs.find((entry) => entry.id === runId);
  const identifier = issueIdentifier(floorRun?.url ?? null);
  const footer = (
    <div className="flex flex-wrap gap-3 font-mono text-xs">
      <button type="button" className="link" onClick={() => onReplayRun(runId)}>
        Replay this run
      </button>
      <Link className="link" to="/runs/$runId" params={{ runId }} search={{ ws: linearWorkspaceId }}>
        Open page
      </Link>
    </div>
  );
  if (run.isPending) {
    return (
      <PanelFrame eyebrow={identifier ?? runId.slice(0, 8)} title={floorRun?.title ?? "Run"} close={close} footer={footer}>
        <SkeletonRows rows={4} />
      </PanelFrame>
    );
  }
  if (run.isError) {
    return (
      <PanelFrame eyebrow={identifier ?? runId.slice(0, 8)} title={floorRun?.title ?? "Run"} close={close} footer={footer}>
        <ErrorAlert error={run.error} title="The run did not load" />
      </PanelFrame>
    );
  }
  const detail = run.data;
  return (
    <PanelFrame
      eyebrow={`${identifier ?? runId.slice(0, 8)} · ${detail.productName}`}
      title={detail.workItemTitle ?? "Untitled run"}
      close={close}
      footer={footer}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={statusTone(detail.status)}>{statusWords(detail.status)}</Badge>
        {detail.workItemUrl ? (
          <a className="link font-mono text-xs" href={detail.workItemUrl} target="_blank" rel="noreferrer">
            Open {identifier ?? "the issue"} in Linear ↗
          </a>
        ) : null}
      </div>
      {detail.diagnosis ? <Diagnosis diagnosis={detail.diagnosis} /> : null}
      <KeyValue
        items={[
          { label: "Duration", value: formatDuration(detail.durationMs) },
          { label: "Cost", value: formatCost(detail.costUsd) },
          { label: "Repairs", value: `${detail.repairCount}${detail.repairLimit === null ? "" : ` of ${detail.repairLimit}`}` },
          { label: "Autonomy", value: detail.autonomyLevel },
        ]}
      />
      <Targets run={detail} />
      <PanelSection title="Stages">
        <StageTimeline run={detail} />
      </PanelSection>
      <PanelSection title="Agent sessions">
        <Sessions run={detail} />
      </PanelSection>
      <PanelSection title="Events">
        <RunEvents runId={runId} workspaceId={linearWorkspaceId} />
      </PanelSection>
    </PanelFrame>
  );
}

/** What left a machine in the floor data: on to the next stage, or back for a repair. */
function stationResults(floor: FloorJson, productId: string, station: StationKey): { passed: number; sentBack: number } {
  let passed = 0;
  let sentBack = 0;
  for (const run of floor.runs) {
    if (run.productId !== productId) continue;
    run.statuses.forEach((change, index) => {
      const next = run.statuses[index + 1];
      if (next === undefined) return;
      const here = crateAt({ ...run, statuses: run.statuses.slice(0, index + 1) }, Date.parse(change.at));
      if (here?.place !== station) return;
      if (next.status === "REPAIRING") sentBack += 1;
      else passed += 1;
    });
  }
  return { passed, sentBack };
}

function CrateList({ crates, moment, onPick }: { crates: CrateState[]; moment: FloorMoment; onPick: (pick: Pick) => void }) {
  if (crates.length === 0) return <Empty>No work item is here now.</Empty>;
  return (
    <ul className="flex flex-col gap-1.5">
      {crates.map((crate) => (
        <li key={crate.run.id}>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-[2px] border border-hairline bg-raised px-2.5 py-2 text-left hover:border-hairline-strong"
            onClick={() => onPick({ kind: "run", id: crate.run.id })}
          >
            <span className="min-w-0">
              <span className="block font-mono text-xs text-accent-text">{issueIdentifier(crate.run.url) ?? crate.run.id.slice(0, 8)}</span>
              <span className="block truncate text-sm text-ink">{crate.run.title ?? "Untitled work item"}</span>
            </span>
            <span className="shrink-0 text-right">
              <Badge tone={toneBadge(crate)}>{crate.label}</Badge>
              <span className="mt-1 block font-mono text-[11px] text-mute tabular-nums">{formatDuration(moment.at - crate.since)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function StationPanel({
  productId,
  station,
  floor,
  moment,
  close,
  onPick,
}: {
  productId: string;
  station: StationKey;
  floor: FloorJson;
  moment: FloorMoment;
  close: ReactNode;
  onPick: (pick: Pick) => void;
}) {
  const line = floor.lines.find((entry) => entry.productId === productId);
  const crates = moment.crates.filter((entry) => entry.run.productId === productId && entry.place === station);
  const operators = moment.operators.filter((entry) => entry.productId === productId && ROLE_STATION[entry.role] === station);
  const results = stationResults(floor, productId, station);
  const deploys = floor.runs
    .filter((run) => run.productId === productId)
    .flatMap((run) => run.deploys.map((deploy) => ({ ...deploy, run })))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 10);
  return (
    <PanelFrame eyebrow={`${line?.name ?? ""} · ${line?.teamKey ?? ""}`} title={stationName(station)} close={close} footer={<span />}>
      <PanelSection title="Here now">
        <CrateList crates={crates} moment={moment} onPick={onPick} />
      </PanelSection>
      {operators.length > 0 ? (
        <PanelSection title="Agents at work">
          <KeyValue
            items={operators.map((operator) => ({
              label: operator.role,
              value: moment.at - operator.lastOutputAt > SILENT_MS ? `silent ${formatDuration(moment.at - operator.lastOutputAt)}` : operator.toolKind,
            }))}
          />
        </PanelSection>
      ) : null}
      {station === "gate" ? (
        <PanelSection title="Deploys">
          {deploys.length === 0 ? (
            <Empty>No deploy in this window.</Empty>
          ) : (
            <KeyValue
              items={deploys.map((deploy) => ({
                label: `${issueIdentifier(deploy.run.url) ?? deploy.run.id.slice(0, 8)} · ${deploy.environment}`,
                value: <Badge tone={deploy.state === "success" ? "success" : "danger"}>{deploy.state}</Badge>,
              }))}
            />
          )}
        </PanelSection>
      ) : (
        <PanelSection title="Results in this window">
          <KeyValue
            items={[
              { label: "Passed on", value: String(results.passed) },
              { label: "Sent back for repair", value: String(results.sentBack) },
            ]}
          />
        </PanelSection>
      )}
    </PanelFrame>
  );
}

function LinePanel({
  productId,
  floor,
  moment,
  linearWorkspaceId,
  close,
  onPick,
}: {
  productId: string;
  floor: FloorJson;
  moment: FloorMoment;
  linearWorkspaceId: string;
  close: ReactNode;
  onPick: (pick: Pick) => void;
}) {
  const line = floor.lines.find((entry) => entry.productId === productId);
  const crates = moment.crates.filter((entry) => entry.run.productId === productId);
  const runs = floor.runs.filter((run) => run.productId === productId);
  const merged = runs.filter((run) => run.pullRequests.some((pr) => pr.state === "merged")).length;
  return (
    <PanelFrame
      eyebrow={line?.teamKey ?? ""}
      title={line?.name ?? "Product"}
      close={close}
      footer={
        <Link className="link font-mono text-xs" to="/products/$productId" params={{ productId }} search={{ ws: linearWorkspaceId }}>
          Open page
        </Link>
      }
    >
      <KeyValue
        items={[
          { label: "Repositories", value: line?.repositories.join(", ") || "—", prose: true },
          { label: "On the line", value: String(crates.length) },
          { label: "Need a human", value: String(crates.filter((crate) => crate.human).length) },
          { label: "Merged in this window", value: String(merged) },
        ]}
      />
      <PanelSection title="Work items">
        <CrateList crates={crates} moment={moment} onPick={onPick} />
      </PanelSection>
    </PanelFrame>
  );
}

function SetupPanel({ setupId, floor, linearWorkspaceId, close }: { setupId: string; floor: FloorJson; linearWorkspaceId: string; close: ReactNode }) {
  const setup = floor.setups.find((entry) => entry.id === setupId);
  const history = useQuery({
    ...listRepositorySetupHistoryOptions({ path: { id: setup?.productId ?? "" }, query: { linearWorkspaceId, repository: setup?.repository ?? "" } }),
    enabled: setup !== undefined,
    refetchInterval: LIVE_POLL_MS,
  });
  const entries = history.data ?? [];
  const entry = entries.find((candidate) => candidate.id === setupId);
  return (
    <PanelFrame
      eyebrow="Setup run"
      title={setup?.repository ?? "Setup run"}
      close={close}
      footer={
        setup ? (
          <Link
            className="link font-mono text-xs"
            to="/products/$productId/setups"
            params={{ productId: setup.productId }}
            search={{ ws: linearWorkspaceId, repository: setup.repository }}
          >
            Open page
          </Link>
        ) : (
          <span />
        )
      }
    >
      {history.isPending ? <SkeletonRows rows={3} /> : null}
      {history.isError ? <ErrorAlert error={history.error} title="The setup history did not load" /> : null}
      {entry ? <SetupDetail entry={entry} entries={entries} linearWorkspaceId={linearWorkspaceId} /> : history.data ? <Empty>This setup run is not in the history.</Empty> : null}
    </PanelFrame>
  );
}
