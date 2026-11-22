import type { StationKey } from "./model";

/**
 * docs/specs/factory-floor.md. The Kenney Factory Kit 3.0 and City Kit Industrial 2.0 models (CC0,
 * licence beside them) the floor draws, bundled under ui/public so the CSP default-src 'self'
 * holds. The scene fits each model to its footprint and gives it the Night shift materials, so
 * only the shape of a model counts.
 */
export const MODEL_BASE = "/floor-models/";

export type ModelName = StationKey | "conveyor" | "bin";

export const MODELS: Record<ModelName, string> = {
  intake: "factory/hopper-high-square.glb",
  refinery: "factory/machine-connection-pipe.glb",
  prep: "factory/machine-bed.glb",
  workshop: "factory/machine-fortified.glb",
  test: "factory/scanner-high.glb",
  lab: "factory/machine-window.glb",
  inspect: "factory/machine-window-bar.glb",
  dock: "city/building-s.glb",
  yard: "factory/indicator-special-area.glb",
  gate: "factory/structure-doorway-wide.glb",
  conveyor: "factory/conveyor-long.glb",
  bin: "factory/hopper-square.glb",
};
