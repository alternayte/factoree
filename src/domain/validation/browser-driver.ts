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
  /**
   * docs/specs/repository-setup-and-services.md. The browser state of a signed-in account, as the
   * driver's `signIn` returned it. The scenario then starts signed in. Absent starts anonymous.
   */
  storageState?: string | undefined;
}

/** docs/specs/repository-setup-and-services.md. One sign-in of one account. */
export interface BrowserSignIn {
  baseUrl: string;
  steps: BrowserStep[];
  timeoutMs: number;
}

export type BrowserSignInResult =
  | { signedIn: true; storageState: string }
  /** `failedStep` counts from 1. The check step is the step after the last sign-in step. */
  | { signedIn: false; failedStep: number; reason: string };

/**
 * docs/specs/browser-network-control.md. One request a holdRequest or a failRequest step
 * affected, so the proof shows which call the step changed.
 */
export interface BrowserControlledRequest {
  method: string;
  url: string;
  effect: "held" | "failed";
  /** For a held request: true when the hold limit released it, not a releaseRequests step. */
  autoReleased: boolean;
  /** For a failed request: the HTTP status it got, or `network`. Null for a held request. */
  failedWith: number | "network" | null;
}

export interface BrowserStepResult {
  index: number;
  action: string;
  passed: boolean;
  /** One readable line. It becomes the assertion log. */
  detail: string;
  /** The requests a holdRequest or a failRequest step affected. Absent for every other step. */
  requests?: BrowserControlledRequest[];
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
  /** Runs the sign-in steps in a fresh browser and returns its storage state. */
  signIn(input: BrowserSignIn): Promise<BrowserSignInResult>;
}
