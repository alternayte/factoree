import { ScheduleNotFoundError, ScheduleOverlapPolicy, WorkflowExecutionAlreadyStartedError, type Client } from "@temporalio/client";
import { manualRetroWorkflowId, retroCalendarOf, retroScheduleId, scheduledRetroWorkflowId, type RetroSettings } from "~/domain/retro/retro-settings.js";
import { retroWorkflow } from "~/workflows/retro.workflow.js";

/**
 * docs/specs/retro-agent.md. The one Temporal Schedule `retro-<tenantId>` per tenant. Each save of
 * the retro settings creates, updates or deletes it, and the worker reconciles it at start, so
 * the stored settings are the truth and the schedule follows them. A schedule survives a worker
 * restart or a deploy, and the time zone keeps "09:00" at 09:00 across daylight saving changes.
 */
export interface RetroScheduler {
  reconcile(settings: RetroSettings): Promise<void>;
  /** The time of the next scheduled retro, or null when the schedule is off or missing. */
  nextRun(tenantId: string): Promise<Date | null>;
  /** Starts a retro now. False when a retro with the same id already runs. */
  startNow(tenantId: string, at: Date): Promise<{ started: boolean; workflowId: string }>;
}

export const createRetroScheduler = (client: Client, taskQueue: string): RetroScheduler => ({
  async reconcile(settings) {
    const scheduleId = retroScheduleId(settings.tenantId);
    const calendar = retroCalendarOf(settings);
    const handle = client.schedule.getHandle(scheduleId);
    if (calendar === null) {
      try {
        await handle.delete();
      } catch (error) {
        if (!(error instanceof ScheduleNotFoundError)) throw error;
      }
      return;
    }
    const spec = { calendars: [calendar], timezone: settings.timeZone };
    const action = {
      type: "startWorkflow" as const,
      workflowType: retroWorkflow,
      taskQueue,
      workflowId: scheduledRetroWorkflowId(settings.tenantId),
      args: [{ tenantId: settings.tenantId, trigger: "schedule" as const }] as [Parameters<typeof retroWorkflow>[0]],
    };
    // SKIP: two retros never read the same runs. One hour of catch-up: an outage starts at most one missed retro.
    const policies = { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: "1 hour" };
    try {
      await handle.describe();
    } catch (error) {
      if (!(error instanceof ScheduleNotFoundError)) throw error;
      await client.schedule.create({ scheduleId, spec, action, policies });
      return;
    }
    await handle.update((previous) => ({ ...previous, spec, action, policies, state: { ...previous.state, paused: false } }));
  },

  async nextRun(tenantId) {
    try {
      const description = await client.schedule.getHandle(retroScheduleId(tenantId)).describe();
      return description.info.nextActionTimes[0] ?? null;
    } catch (error) {
      if (error instanceof ScheduleNotFoundError) return null;
      throw error;
    }
  },

  async startNow(tenantId, at) {
    const workflowId = manualRetroWorkflowId(tenantId, at);
    try {
      await client.workflow.start(retroWorkflow, { taskQueue, workflowId, args: [{ tenantId, trigger: "manual" }] });
      return { started: true, workflowId };
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) return { started: false, workflowId };
      throw error;
    }
  },
});
