import type { BrowserStep } from "./validation-plan.js";

/**
 * A browser scenario for one validation run. SDD section 37 fixes the
 * order: start preview, wait for readiness, expose the service, execute
 * Playwright, capture required evidence. This type feeds step 4.
 */
export interface BrowserScenario {
  /** The exposed preview URL. Every `goto` path is resolved against it. */
  baseUrl: string;
  steps: BrowserStep[];
  /** SDD section 37. The driver records these only when the frozen assertion requires them. */
  captureVideo: boolean;
  captureTrace: boolean;
  timeoutMs: number;
}

export interface BrowserStepResult {
  index: number;
  action: string;
  passed: boolean;
  /** One readable line. It becomes the assertion log. */
  detail: string;
}

export interface BrowserArtifact {
  kind: "screenshot" | "video" | "trace";
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface BrowserNetworkEntry {
  method: string;
  url: string;
  status: number | null;
}

export interface BrowserRunResult {
  passed: boolean;
  steps: BrowserStepResult[];
  consoleLines: string[];
  network: BrowserNetworkEntry[];
  artifacts: BrowserArtifact[];
  /** Null when every step passed. */
  failureReason: string | null;
}

/**
 * The port for a browser assertion. An adapter drives a real browser
 * against the exposed preview URL and returns the evidence SDD section 37
 * allows. Core workflow policy depends on this port only, never on a
 * provider SDK.
 */
export interface BrowserDriver {
  readonly name: string;
  run(scenario: BrowserScenario): Promise<BrowserRunResult>;
}
