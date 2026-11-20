import { Context } from "@temporalio/activity";

/**
 * GitHub issue 54. The interval between two heartbeats of a long activity. The activity options
 * set a heartbeat timeout of two minutes, so a dead worker is found in two minutes, not after the
 * whole start-to-close timeout.
 */
export const LONG_ACTIVITY_HEARTBEAT_INTERVAL_MS = 30_000;

/** GitHub issue 54. The heartbeat timeout of every activity that runs `withHeartbeat`. */
export const LONG_ACTIVITY_HEARTBEAT_TIMEOUT = "2 minutes";

/**
 * GitHub issue 54. Runs `work` and heartbeats every 30 seconds until it ends. Outside an activity,
 * as in a unit test, it runs `work` alone.
 */
export const withHeartbeat = async <T>(work: () => Promise<T>): Promise<T> => {
  let context: Context;
  try {
    context = Context.current();
  } catch {
    return work();
  }
  context.heartbeat();
  const timer = setInterval(() => context.heartbeat(), LONG_ACTIVITY_HEARTBEAT_INTERVAL_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
};

/**
 * GitHub issue 54. The same activities, with each named one run under `withHeartbeat`. A method
 * keeps its own `this`.
 */
export const withHeartbeats = <T extends object>(activities: T, names: ReadonlyArray<keyof T>): T => {
  const wrapped = { ...activities } as Record<PropertyKey, unknown>;
  for (const name of names) {
    const method: unknown = activities[name];
    if (typeof method !== "function") continue;
    wrapped[name] = (...args: unknown[]) => withHeartbeat(() => (method as (...a: unknown[]) => Promise<unknown>).apply(activities, args));
  }
  return wrapped as T;
};
