import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const labelNames = ["tenant_id", "project_id"] as const;

export const metrics = {
  registry,
  runsStarted: new Counter({
    name: "factoree_runs_started_total",
    help: "Runs started",
    labelNames,
    registers: [registry],
  }),
  runsReady: new Counter({
    name: "factoree_runs_ready_total",
    help: "Runs that reached READY_FOR_HUMAN",
    labelNames,
    registers: [registry],
  }),
  runsFailed: new Counter({
    name: "factoree_runs_failed_total",
    help: "Runs that reached a failure state",
    labelNames: [...labelNames, "reason"],
    registers: [registry],
  }),
  runsCancelled: new Counter({
    name: "factoree_runs_cancelled_total",
    help: "Runs that were cancelled",
    labelNames,
    registers: [registry],
  }),
  runDuration: new Histogram({
    name: "factoree_run_duration_seconds",
    help: "Run duration in seconds",
    labelNames,
    buckets: [30, 60, 300, 900, 1800, 3600, 5400],
    registers: [registry],
  }),
  activeRuns: new Gauge({
    name: "factoree_active_runs",
    help: "Runs that are not in a terminal state",
    labelNames,
    registers: [registry],
  }),
  humanInterventions: new Counter({
    name: "factoree_human_interventions_total",
    help: "Human interventions such as elicitation answers and stop requests",
    labelNames,
    registers: [registry],
  }),
};
