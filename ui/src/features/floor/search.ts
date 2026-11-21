/** docs/specs/factory-floor.md. The search of the floor: a replay window and speed, and a run in focus. */
export type FloorSearch = { ws?: string; from?: string; to?: string; speed?: number; run?: string };

export const REPLAY_SPEEDS = [1, 10, 60, 120] as const;

export function floorSearch(search: Record<string, unknown>): FloorSearch {
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const date = (value: unknown) => {
    const raw = text(value);
    return raw !== undefined && !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : undefined;
  };
  const ws = text(search.ws);
  const from = date(search.from);
  const to = date(search.to);
  const speed = Number(search.speed);
  const run = text(search.run);
  return {
    ...(ws ? { ws } : {}),
    ...(from && to ? { from, to } : {}),
    ...((REPLAY_SPEEDS as readonly number[]).includes(speed) ? { speed } : {}),
    ...(run ? { run } : {}),
  };
}

