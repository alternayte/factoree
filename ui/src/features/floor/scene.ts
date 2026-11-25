import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { builtAt, nextBuilding, ROLE_STATION, SILENT_MS, STATION_CREW, STATIONS, stationIndex, type CrateState, type FloorMoment, type Place, type StationKey, type Tone } from "./model";
import { MODEL_BASE, MODELS, type ModelName } from "./models";
import { barrels, crewFigure, emptyAnimated, lampPost, pallet, propMaterials, racks, rail, seeded, silo, tankFarm, truckBay, walkway, warehouse, type Animated } from "./props";

/**
 * docs/specs/factory-floor.md. The Night shift scene: matte machines in the DESIGN.md tokens on the
 * canvas floor, and light only from state: accent where a session runs, warning where a human is
 * needed, danger on a failed check, success at shipping and deploy.
 */
const TOKENS = {
  canvas: 0x0b0d0e,
  panel: 0x0f1315,
  raised: 0x131a1d,
  hairline: 0x1a2427,
  hairlineStrong: 0x24343a,
  mute: 0x6f878d,
  accent: 0x00e5ff,
  warning: 0xffd84d,
  danger: 0xff5d73,
  success: 0x3dffa8,
  idleGlow: 0x283033,
  /** docs/specs/floor-growth.md. Cardboard: a neutral the state band reads against. */
  crate: 0x8f7556,
} as const;

/** The grey each kind of model is drawn in, before its texture shading. */
const MODEL_TINT = { machine: 0xb2bec1, belt: 0x5c6c72, bin: 0x7a6d70 } as const;

/**
 * docs/specs/floor-growth.md. The Lit factory colour of each station, muted so it never reads as a
 * state colour. It replaces the warm accent parts of each model.
 */
const STATION_COLOR: Record<StationKey, number> = {
  intake: 0x5d676b,
  refinery: 0x6f6491,
  prep: 0x587580,
  workshop: 0x9a7740,
  test: 0x4d7a6c,
  lab: 0x52698f,
  inspect: 0x8a5d68,
  dock: 0x667050,
  yard: 0x4a5257,
  gate: 0x4c7a84,
};

const TONE_COLOR: Record<Tone, number> = {
  accent: TOKENS.accent,
  warning: TOKENS.warning,
  danger: TOKENS.danger,
  success: TOKENS.success,
  idle: TOKENS.mute,
};

/** The distance between two stations, and between two lines. */
const STEP = 6;
/** docs/specs/floor-growth.md. Room behind a line for its silos and buildings, and in front for its yard. */
const LINE_GAP = 27;
/** The camera position relative to its target: the angle of the Night shift concept. */
const CAMERA_OFFSET = new THREE.Vector3(22, 40, 48);
/**
 * docs/specs/floor-growth.md. Where the silos of a line stand, one per repository. Up to SILO_ROW
 * stand in one row behind the dock, each named. More fill a field across the back of the line,
 * behind its buildings, at the largest scale that keeps the field at most SILO_FIELD_ROWS deep.
 */
const SILO_ROW = 8;
const SILO_FIELD_ROWS = 6;
interface SiloLayout {
  field: boolean;
  scale: number;
  gap: number;
  columns: number;
  rows: number;
  x0: number;
  z0: number;
}
const siloLayout = (count: number): SiloLayout => {
  if (count <= SILO_ROW) return { field: false, scale: 1, gap: 2.6, columns: SILO_ROW, rows: 1, x0: STEP * 6.2, z0: -10.2 };
  const x0 = -1;
  const width = STEP * 9 + 5 - x0;
  const scales = [0.8, 0.65, 0.5, 0.4];
  for (const scale of scales) {
    const gap = 2.6 * scale;
    const columns = Math.floor(width / gap) + 1;
    const rows = Math.ceil(count / columns);
    if (rows <= SILO_FIELD_ROWS || scale === scales.at(-1)) return { field: true, scale, gap, columns, rows, x0, z0: -15 };
  }
  throw new Error("unreachable");
};
/** The crates the PR yard shows before the rest wait there as a "+N" count. */
const YARD_SHOWN = 36;
/** docs/specs/floor-growth.md. The PR yard is a pad in front of the belt, past the dock. */
const YARD_Z = 4.2;
/**
 * docs/specs/floor-growth.md. The PR yard: a raised concrete slab, lighter than the floor, with a
 * painted border, a painted bay line per row of crates, and a bollard at each corner, so the crates
 * stand in a yard and not loose beside the belt.
 */
const yardPad = (size: { w: number; d: number }): THREE.Group => {
  const group = new THREE.Group();
  const slab = new THREE.Mesh(new THREE.BoxGeometry(size.w, 0.22, size.d), new THREE.MeshStandardMaterial({ color: 0x4a5053, roughness: 0.95 }));
  slab.position.y = 0.11;
  const paint = new THREE.MeshStandardMaterial({ color: 0xa39d86, roughness: 0.8 });
  const line = (w: number, d: number, x: number, z: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), paint);
    mesh.position.set(x, 0.23, z);
    group.add(mesh);
  };
  const inset = 0.25;
  line(size.w - inset * 2, 0.12, 0, -size.d / 2 + inset);
  line(size.w - inset * 2, 0.12, 0, size.d / 2 - inset);
  line(0.12, size.d - inset * 2, -size.w / 2 + inset, 0);
  line(0.12, size.d - inset * 2, size.w / 2 - inset, 0);
  for (let row = 1; row < 4; row += 1) line(size.w - inset * 4, 0.05, 0, -size.d / 2 + inset + (row * (size.d - inset * 2)) / 4);
  const bollard = new THREE.MeshStandardMaterial({ color: 0x6b6a5e, roughness: 0.7 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.9, 10), bollard);
      post.position.set(sx * (size.w / 2 - 0.1), 0.45, sz * (size.d / 2 - 0.1));
      group.add(post);
    }
  }
  group.add(slab);
  return group;
};

/** The order the yard rows fill, from the belt (0) to the front (3). */
const YARD_ROW_ORDER = [1, 2, 0, 3];
/** The extra room a silo field needs behind a line, past the room every line has. */
const siloDepth = (repositories: number): number => {
  const layout = siloLayout(repositories);
  // The camera looks down from the front, so a silo also needs its height free behind it.
  return layout.field ? Math.max(0, -layout.z0 + (layout.rows - 1) * layout.gap + 2 + 4 * layout.scale - 13) : 0;
};
const BELT_OFFSET = 0;
const REPAIR_OFFSET = 1.6;
const MACHINE_OFFSET = -2.9;
const BIN_OFFSET = 3.5;
const MOVE_SPEED = 3.2;
/** How far along the belt a machine behind it appears, seen from CAMERA_OFFSET. */
const BELT_STOP_SHIFT = (-MACHINE_OFFSET * CAMERA_OFFSET.x) / CAMERA_OFFSET.z;
/** The footprint each machine model is scaled to, by station. */
const FOOTPRINT: Record<StationKey, { w: number; d: number; h: number }> = {
  intake: { w: 3.4, d: 3.2, h: 2.6 },
  refinery: { w: 3.8, d: 3.2, h: 3.4 },
  prep: { w: 3.2, d: 3, h: 2.6 },
  workshop: { w: 4.4, d: 3.4, h: 3.8 },
  test: { w: 3.8, d: 3, h: 2.4 },
  lab: { w: 3.8, d: 3.2, h: 3 },
  inspect: { w: 3.6, d: 3.2, h: 3 },
  dock: { w: 4, d: 3.4, h: 1.4 },
  yard: { w: 6.4, d: 7.4, h: 0.3 },
  gate: { w: 3.4, d: 3.6, h: 3.8 },
};

export type Pick =
  | { kind: "run"; id: string }
  | { kind: "station"; productId: string; station: StationKey }
  | { kind: "line"; productId: string }
  | { kind: "setup"; id: string }
  | { kind: "retro"; id: string };

export interface SceneLine {
  productId: string;
  name: string;
  teamKey: string;
  repositories: string[];
  mergedTotal: number;
}

interface Machine {
  glow: THREE.MeshBasicMaterial;
  x: number;
  z: number;
  top: number;
  label: HTMLDivElement;
  /** docs/specs/floor-active.md. The machine model, its own materials, and its moving parts. */
  model: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
  parts: ActiveParts | null;
}

/**
 * docs/specs/floor-active.md. The colour a station glows in while it works: its own colour, bright,
 * and never cyan, yellow, red or green, which name state.
 */
const ACTIVE_COLOR: Partial<Record<StationKey, number>> = {
  refinery: 0x9d7bff,
  prep: 0x3fb6c8,
  workshop: 0xff9b3d,
  test: 0x46d9b4,
  lab: 0x5d7dff,
  inspect: 0xff6fae,
  dock: 0x9fd46a,
};

/** The moving parts of one station: built once, animated each frame while the station works. */
interface ActiveParts {
  group: THREE.Group;
  animate: (now: number, on: boolean, dt: number) => void;
}

/**
 * docs/specs/floor-active.md. The Kenney models are single meshes with no animation, so each
 * working station gets parts drawn in code that move only while it works: a pipe ring at the
 * refinery, a piston at prep, a flywheel at the workshop, a scanner beam over the belt at the test
 * bench, a blinking lamp at the user lab, a turning beacon at inspection and a lamp at the dock.
 * `box` is the machine in world space and `beltZ` the belt in front of it.
 */
const activeParts = (station: StationKey, box: THREE.Box3, beltZ: number, crateX: number): ActiveParts | null => {
  const color = ACTIVE_COLOR[station];
  if (color === undefined) return null;
  const group = new THREE.Group();
  const idle = 0x2a3236;
  const glowing = (geometry: THREE.BufferGeometry) => new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: idle }));
  const centre = box.getCenter(new THREE.Vector3());
  const top = box.max.y;
  const light = (mesh: THREE.Mesh, on: boolean, level: number) => (mesh.material as THREE.MeshBasicMaterial).color.setHex(on ? color : idle).multiplyScalar(on ? level : 1);
  switch (station) {
    case "refinery": {
      const ring = glowing(new THREE.TorusGeometry(0.55, 0.09, 8, 24));
      ring.rotation.x = Math.PI / 2;
      ring.position.set(centre.x, top + 0.12, centre.z);
      group.add(ring);
      return { group, animate: (now, on) => light(ring, on, 1.2 + 0.6 * Math.sin(now / 260)) };
    }
    case "prep": {
      const piston = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.9, 10), new THREE.MeshStandardMaterial({ color: 0x6d777b, roughness: 0.5, metalness: 0.4 }));
      const cap = glowing(new THREE.CylinderGeometry(0.24, 0.24, 0.12, 12));
      group.add(piston, cap);
      const place = (lift: number) => {
        piston.position.set(centre.x + 0.5, top + 0.3 + lift, centre.z);
        cap.position.set(centre.x + 0.5, top + 0.78 + lift, centre.z);
      };
      place(0);
      return {
        group,
        animate: (now, on) => {
          place(on ? 0.25 + 0.25 * Math.sin(now / 180) : 0);
          light(cap, on, 1.3);
        },
      };
    }
    case "workshop": {
      const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.11, 8, 18), new THREE.MeshStandardMaterial({ color: 0x737d81, roughness: 0.5, metalness: 0.5 }));
      const hub = glowing(new THREE.CylinderGeometry(0.16, 0.16, 0.3, 10));
      wheel.position.set(box.max.x + 0.18, centre.y + 0.2, centre.z);
      wheel.rotation.y = Math.PI / 2;
      hub.rotation.z = Math.PI / 2;
      hub.position.copy(wheel.position);
      for (let spoke = 0; spoke < 3; spoke += 1) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.9, 0.06), wheel.material);
        bar.rotation.z = (spoke * Math.PI) / 3;
        wheel.add(bar);
      }
      group.add(wheel, hub);
      return {
        group,
        animate: (_now, on, dt) => {
          if (on) wheel.rotation.x += dt * 7;
          light(hub, on, 1.5);
        },
      };
    }
    case "test": {
      // The beam stands over the belt and sweeps across the crate under test.
      const beam = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 2.2, 1.5),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false }),
      );
      const head = glowing(new THREE.BoxGeometry(2.6, 0.18, 0.5));
      head.position.set(crateX, 3.1, beltZ);
      group.add(beam, head);
      return {
        group,
        animate: (now, on) => {
          beam.visible = on;
          beam.position.set(crateX + 1.1 * Math.sin(now / 320), 1.95, beltZ);
          light(head, on, 1.2);
        },
      };
    }
    case "lab": {
      const lamp = glowing(new THREE.SphereGeometry(0.26, 12, 10));
      lamp.position.set(centre.x + 0.6, top + 0.25, centre.z);
      group.add(lamp);
      return { group, animate: (now, on) => light(lamp, on && Math.floor(now / 380) % 2 === 0, 1.8) };
    }
    case "inspect": {
      const base = glowing(new THREE.CylinderGeometry(0.2, 0.2, 0.3, 12));
      base.position.set(centre.x, top + 0.15, centre.z);
      const sweep = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 0.22), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false }));
      sweep.position.set(centre.x, top + 0.34, centre.z);
      group.add(base, sweep);
      return {
        group,
        animate: (now, on) => {
          sweep.visible = on;
          sweep.rotation.y = now / 300;
          light(base, on, 1.4);
        },
      };
    }
    case "dock": {
      const lamp = glowing(new THREE.SphereGeometry(0.24, 12, 10));
      lamp.position.set(box.max.x - 0.3, top + 0.24, centre.z);
      group.add(lamp);
      return { group, animate: (now, on) => light(lamp, on && Math.floor(now / 500) % 2 === 0, 1.6) };
    }
    default:
      return null;
  }
};

interface CrateView {
  group: THREE.Group;
  body: THREE.MeshStandardMaterial;
  band: THREE.MeshBasicMaterial;
  /** The path the crate walks now, and when it started. */
  path: THREE.Vector3[];
  /** Where the crate is on its path now, without its lift and bounce. */
  at: THREE.Vector3;
  pathLength: number;
  startedAt: number;
  place: Place;
}

/** docs/specs/floor-growth.md. The crew member of one station. */
interface Crew {
  group: THREE.Group;
  head: THREE.MeshBasicMaterial;
  arm: THREE.Object3D;
  kind: "agent" | "bot";
  home: THREE.Vector3;
  phase: number;
}

interface Figure {
  group: THREE.Group;
  head: THREE.Mesh;
  pill: HTMLDivElement;
}

/** docs/specs/retro-agent.md. The consultant of one running retro, who walks the lines it reads. */
interface Consultant {
  group: THREE.Group;
  head: THREE.MeshBasicMaterial;
  pill: HTMLDivElement;
}

/** How long the consultant walks one line before the next, while no pulse names the product. */
const CONSULTANT_DWELL_MS = 20_000;
/** One walk from the intake to the deploy gate and back. */
const CONSULTANT_LAP_MS = 40_000;
/** How fast the consultant walks to its next point, in world units a second. */
const CONSULTANT_SPEED = 8;
/** The consultant walks the walkway in front of the line. */
const CONSULTANT_Z = 5.4;

const formatSilence = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  return minutes > 0 ? `silent ${minutes}m` : `silent ${Math.round(ms / 1000)}s`;
};

const disposeTree = (object: THREE.Object3D): void => {
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
    else material?.dispose();
  });
};

/** Loads every model of the scene once, so a line is built without waiting. */
export const loadModels = async (): Promise<Record<ModelName, THREE.Group>> => {
  const loader = new GLTFLoader();
  const entries = await Promise.all(
    (Object.keys(MODELS) as ModelName[]).map(async (name) => {
      const gltf: GLTF = await loader.loadAsync(`${MODEL_BASE}${MODELS[name]}`);
      return [name, gltf.scene] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<ModelName, THREE.Group>;
};

/**
 * The Night shift look of a Kenney model: its own colour map turned to the grey of the theme,
 * so the shapes, windows and panels keep their detail, and the warm accent parts of the map
 * (the orange bands) turned to a dim cyan. A machine stays matte; only state lights it.
 */
const themedMaterials = new Map<string, THREE.MeshStandardMaterial>();
const themedMaterial = (original: THREE.Material, tint: number, accent: number, own = false): THREE.MeshStandardMaterial => {
  const map = (original as THREE.MeshStandardMaterial).map ?? null;
  const key = `${map?.uuid ?? "none"}:${tint}:${accent}`;
  const known = own ? undefined : themedMaterials.get(key);
  if (known !== undefined) return known;
  const material = new THREE.MeshStandardMaterial({ map, color: tint, roughness: 0.82, metalness: 0.08 });
  const accentColor = new THREE.Color(accent);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.accentColor = { value: accentColor };
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "uniform vec3 accentColor;\nvoid main() {")
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
  vec4 texel = texture2D( map, vMapUv );
  float light = dot( texel.rgb, vec3( 0.299, 0.587, 0.114 ) );
  float warm = smoothstep( 0.12, 0.3, texel.r - texel.b );
  diffuseColor.rgb = mix( diffuseColor.rgb * ( 0.35 + 0.9 * light ), accentColor, warm );
#endif`,
      );
  };
  if (!own) themedMaterials.set(key, material);
  return material;
};

/** One copy of a model, scaled to a footprint and standing on the floor at the origin, in the theme. */
const placeModel = (source: THREE.Group, size: { w: number; d: number; h: number }, tint: number, accent: number, own = false): THREE.Group => {
  const model = source.clone(true);
  const box = new THREE.Box3().setFromObject(model);
  const dimensions = box.getSize(new THREE.Vector3());
  const scale = Math.min(size.w / Math.max(dimensions.x, 0.001), size.d / Math.max(dimensions.z, 0.001), size.h / Math.max(dimensions.y, 0.001));
  model.scale.setScalar(scale);
  const scaled = new THREE.Box3().setFromObject(model);
  const center = scaled.getCenter(new THREE.Vector3());
  model.position.set(-center.x, -scaled.min.y, -center.z);
  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const original = Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material;
    mesh.material = themedMaterial(original, tint, accent, own);
  });
  const group = new THREE.Group();
  group.add(model);
  return group;
};

export class FloorScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 600);
  private readonly key = new THREE.DirectionalLight(0xfff0d8, 1.7);
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly overlay: HTMLDivElement;
  private readonly world = new THREE.Group();
  private readonly target = new THREE.Vector3();
  private zoom = 1;
  private fitSize = 40;
  /** True once the viewer panned or zoomed, so a new stage size keeps their view. */
  private userMoved = false;
  private lines: SceneLine[] = [];
  /** The z of each line: a line with more silo rows stands further from the line above. */
  private lineOffsets: number[] = [];
  private machines = new Map<string, Machine>();
  private signs = new Map<string, HTMLDivElement>();
  private crates = new Map<string, CrateView>();
  private figures = new Map<string, Figure>();
  private crews = new Map<string, { group: THREE.Group; pill: HTMLDivElement }>();
  private consultants = new Map<string, Consultant>();
  private badges: HTMLDivElement[] = [];
  private stationCrew = new Map<string, Crew>();
  private silos = new Map<string, { cap: THREE.MeshBasicMaterial; label: HTMLDivElement; point: THREE.Vector3 }>();
  /** The silos of a field, for the hover that names one. */
  private siloHits: Array<{ object: THREE.Object3D; key: string }> = [];
  private hoveredSilo: string | null = null;
  private growthSigns = new Map<string, HTMLSpanElement>();
  private readonly props = propMaterials();
  private animated: Animated = emptyAnimated();
  private lastSmoke = 0;
  /** docs/specs/factory-floor.md. Steam over a machine while a session or a check runs in it. */
  private puffs: Array<{ mesh: THREE.Mesh; bornAt: number }> = [];
  private lastPuff = new Map<string, number>();
  /** docs/specs/floor-active.md. The repair belt and transfer plates of each line, lit while a crate rides them. */
  private repairBelts = new Map<string, THREE.MeshStandardMaterial[]>();
  private readonly puffGeometry = new THREE.SphereGeometry(0.28, 10, 8);
  private belts: THREE.Texture[] = [];
  private moment: FloorMoment | null = null;
  private selected: Pick | null = null;
  private frame = 0;
  private lastFrame = performance.now();
  private readonly raycaster = new THREE.Raycaster();
  private readonly resizeObserver: ResizeObserver;
  private readonly materials = {
    body: new THREE.MeshStandardMaterial({ color: 0x1c262a, roughness: 0.9, metalness: 0.05 }),
    top: new THREE.MeshStandardMaterial({ color: TOKENS.hairline, roughness: 0.85, metalness: 0.05 }),
    pad: new THREE.MeshStandardMaterial({ color: 0x22292c, roughness: 1 }),
    edge: new THREE.LineBasicMaterial({ color: 0x35525a }),
    padEdge: new THREE.LineBasicMaterial({ color: TOKENS.hairlineStrong }),
    figure: new THREE.MeshStandardMaterial({ color: 0x56656b, roughness: 0.7 }),
  };
  private down: { x: number; y: number; target: THREE.Vector3; moved: boolean } | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly models: Record<ModelName, THREE.Group>,
    private readonly options: {
      reducedMotion: boolean;
      onPick: (pick: Pick | null) => void;
      /** Called each frame with the screen position of the selected object, or null. */
      onAnchor: (point: { x: number; y: number } | null) => void;
    },
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // docs/specs/floor-growth.md. A warm key light with soft shadows, as the Lit factory concept.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = "floor-canvas";
    container.prepend(this.renderer.domElement);
    this.overlay = document.createElement("div");
    this.overlay.className = "floor-overlay";
    container.append(this.overlay);

    this.scene.background = new THREE.Color(TOKENS.canvas);
    this.scene.add(this.world);
    this.scene.add(new THREE.HemisphereLight(0xe8f4f6, 0x15191b, 1));
    this.key.position.set(-22, 40, 18);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0008;
    this.key.shadow.radius = 4;
    this.scene.add(this.key, this.key.target);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Only the state lights are bright enough to bloom.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.42, 0.55);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    // docs/specs/floor-full-screen.md. A new stage size fits the lines again, until the viewer
    // pans or zooms.
    this.resizeObserver = new ResizeObserver(() => (this.userMoved ? this.resize() : this.fit()));
    this.resizeObserver.observe(container);
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.resize();
    this.frame = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("wheel", this.onWheel);
    disposeTree(this.scene);
    Object.values(this.props).forEach((material) => material.dispose());
    this.belts.forEach((texture) => texture.dispose());
    this.composer.dispose();
    this.renderer.dispose();
    canvas.remove();
    this.overlay.remove();
  }

  /** Builds the lines. It runs again only when the products change. */
  setLines(lines: SceneLine[]): void {
    const shapeOf = (line: SceneLine): string => `${line.productId}|${line.name}|${line.repositories.join(",")}|${[...builtAt(line.mergedTotal)].join(",")}`;
    const same = lines.length === this.lines.length && lines.every((line, index) => this.lines[index] !== undefined && shapeOf(line) === shapeOf(this.lines[index]!));
    // The merged total changes the sign text without a rebuild.
    this.lines = same ? lines : this.lines;
    if (same) this.updateGrowthSigns();
    if (same) return;
    this.lines = lines;
    this.stationCrew.clear();
    this.silos.forEach((entry) => entry.label.remove());
    this.silos.clear();
    this.siloHits = [];
    this.hoveredSilo = null;
    this.growthSigns.clear();
    this.animated = emptyAnimated();
    disposeTree(this.world);
    this.world.clear();
    this.belts.forEach((texture) => texture.dispose());
    this.belts = [];
    this.machines.forEach((machine) => machine.label.remove());
    this.machines.clear();
    this.repairBelts.clear();
    this.signs.forEach((sign) => sign.remove());
    this.signs.clear();
    this.crates.forEach((crate) => disposeTree(crate.group));
    this.crates.clear();
    this.figures.forEach((figure) => figure.pill.remove());
    this.figures.clear();
    this.crews.forEach((crew) => crew.pill.remove());
    this.crews.clear();
    this.consultants.forEach((consultant) => consultant.pill.remove());
    this.consultants.clear();

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x171c1e, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    this.world.add(floor);
    const grid = new THREE.GridHelper(400, 200, 0x1c2427, 0x1c2427);
    grid.position.y = 0.01;
    this.world.add(grid);

    this.lineOffsets = [];
    lines.forEach((line, index) => {
      const previous = index === 0 ? 0 : this.lineOffsets[index - 1]! + LINE_GAP;
      this.lineOffsets.push(previous + (index === 0 ? 0 : siloDepth(line.repositories.length)));
    });
    lines.forEach((line, index) => this.buildLine(line, index));
    // Everything casts and takes a shadow, except the floor, which only takes one.
    this.world.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.receiveShadow = true;
      mesh.castShadow = mesh !== floor;
    });
    // The shadow camera covers every line and its surroundings.
    const last = this.lineOffsets.at(-1) ?? 0;
    const centre = new THREE.Vector3(this.x(4.5), 0, last / 2);
    this.key.target.position.copy(centre);
    this.key.position.copy(centre).add(new THREE.Vector3(-22, 40, 18));
    const reach = Math.max(this.x(9) + 20, last + 30) / 2 + 10;
    Object.assign(this.key.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: 200 });
    this.key.shadow.camera.updateProjectionMatrix();
    this.updateGrowthSigns();
    this.resize();
    this.fit();
  }

  /** Shows the floor at one moment. */
  setMoment(moment: FloorMoment): void {
    this.moment = moment;
  }

  select(pick: Pick | null): void {
    this.selected = pick;
  }

  /** Pans the camera to a run's crate. */
  focusRun(id: string): void {
    const crate = this.crates.get(id);
    if (crate === undefined) return;
    this.userMoved = true;
    this.target.set(crate.group.position.x, 0, crate.group.position.z);
  }

  zoomBy(factor: number): void {
    this.userMoved = true;
    this.zoom = Math.min(3.5, Math.max(0.35, this.zoom * factor));
    this.resize();
  }

  private x(station: number): number {
    return station * STEP;
  }

  private lineZ(productId: string): number {
    return this.lineOffsets[Math.max(0, this.lines.findIndex((line) => line.productId === productId))] ?? 0;
  }

  /**
   * Where the crate in one slot of a place stands. Crates at one machine stand side by side on the
   * belt, then stack one level up, so several runs in the same step stay apart and countable. The
   * yard, the intake and the bin hold a grid. `y` is the stack height.
   */
  private stationPoint(productId: string, place: Place, slot: number, count = 1): THREE.Vector3 {
    const z = this.lineZ(productId);
    const gap = 2;
    if (place === "gone") return new THREE.Vector3(this.x(stationIndex("gate")) + 7, 0, z);
    if (place === "bin") return new THREE.Vector3(this.x(stationIndex("inspect")) - gap + (slot % 3) * gap, Math.floor(slot / 3) * 1.55, z + BIN_OFFSET);
    const index = stationIndex(place);
    if (place === "intake") {
      return new THREE.Vector3(this.x(index) - gap + (slot % 3) * gap, Math.floor(slot / 6) * 1.55, z - 0.8 + (Math.floor(slot / 3) % 2) * gap);
    }
    if (place === "yard") {
      // docs/specs/floor-growth.md. The yard holds YARD_SHOWN crates: four rows of three in front
      // of the belt, stacked up to three high. The middle rows fill first, so a few crates stand in
      // the yard and not against the belt.
      const layer = slot % 12;
      const row = YARD_ROW_ORDER[Math.floor(layer / 3)]!;
      return new THREE.Vector3(this.x(index) - gap + (layer % 3) * gap, Math.floor(slot / 12) * 1.55, z + YARD_Z + (row - 1.5) * 1.85);
    }
    // On the belt, in line with the machine as the concept: one crate at its centre, two side by
    // side, then a second level. The machine stands behind the belt, so the crate stops
    // BELT_STOP_SHIFT further along, where the camera shows it in front of the machine.
    const perLevel = Math.min(2, count - Math.floor(slot / 2) * 2);
    const shift = place === "gate" ? 0 : BELT_STOP_SHIFT;
    return new THREE.Vector3(this.x(index) + shift + ((slot % 2) - (perLevel - 1) / 2) * gap, Math.floor(slot / 2) * 1.55, z + BELT_OFFSET);
  }

  /** How many crates a place shows. More wait there as a "+N" count. */
  private capacityOf(place: Place): number {
    if (place === "yard") return YARD_SHOWN;
    if (place === "intake") return 12;
    if (place === "bin") return 6;
    return 4;
  }

  private stripeTexture(): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 16;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#141b1e";
    context.fillRect(0, 0, 64, 16);
    context.fillStyle = "#1d2a2e";
    for (let x = 0; x < 64; x += 16) context.fillRect(x, 0, 6, 16);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    this.belts.push(texture);
    return texture;
  }

  private belt(x0: number, x1: number, z: number, width: number, tint: number = MODEL_TINT.belt): THREE.MeshStandardMaterial {
    // The conveyor model, repeated along the belt, carries a moving stripe so the belt runs.
    const length = x1 - x0;
    const source = this.models.conveyor;
    const size = new THREE.Box3().setFromObject(source).getSize(new THREE.Vector3());
    const pieces = Math.max(1, Math.round(length / Math.max(width, 0.5)));
    const piece = length / pieces;
    for (let index = 0; index < pieces; index += 1) {
      // A conveyor model runs along its longer side. One that runs along z is fitted turned, then
      // turned to run along x.
      const alongZ = size.z > size.x;
      const model = placeModel(source, alongZ ? { w: width, d: piece, h: 0.5 } : { w: piece, d: width, h: 0.5 }, tint, TOKENS.idleGlow);
      if (alongZ) model.rotation.y = Math.PI / 2;
      model.position.set(x0 + piece * (index + 0.5), 0, z);
      this.world.add(model);
    }
    const texture = this.stripeTexture();
    texture.repeat.set(length / 1.4, 1);
    const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9 });
    const surface = new THREE.Mesh(new THREE.PlaneGeometry(length, width * 0.8), material);
    surface.rotation.x = -Math.PI / 2;
    surface.position.set((x0 + x1) / 2, 0.52, z);
    this.world.add(surface);
    return material;
  }

  private label(text: string, className: string): HTMLDivElement {
    const element = document.createElement("div");
    element.className = className;
    element.textContent = text;
    this.overlay.append(element);
    return element;
  }

  private buildLine(line: SceneLine, index: number): void {
    const z = this.lineOffsets[index] ?? 0;
    const pad = new THREE.Mesh(new THREE.BoxGeometry(this.x(9) + 11, 0.08, 10.6), this.materials.pad);
    pad.position.set(this.x(4.5) + 1.5, 0.04, z - 0.4);
    this.world.add(pad);
    const padEdge = new THREE.LineSegments(new THREE.EdgesGeometry(pad.geometry), this.materials.padEdge);
    padEdge.position.copy(pad.position);
    this.world.add(padEdge);
    this.belt(this.x(0) - 1.5, this.x(9) + 7, z + BELT_OFFSET, 1.2);
    // The repair belt carries a crate back to the workshop. It stays dark until one rides it.
    // docs/specs/floor-active.md. A transfer plate joins it to the main belt at each check station,
    // where a failed check sends the crate off, and at the workshop, where it rejoins.
    const repairFrom = this.x(stationIndex("workshop")) + BELT_STOP_SHIFT;
    const repairTo = this.x(stationIndex("inspect")) + BELT_STOP_SHIFT;
    const repairSurfaces = [this.belt(repairFrom - 0.7, repairTo + 0.7, z + REPAIR_OFFSET, 0.8, 0x313c40)];
    for (const key of ["workshop", "test", "lab", "inspect"] as const) {
      const material = new THREE.MeshStandardMaterial({ color: 0x313c40, roughness: 0.8 });
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.46, REPAIR_OFFSET - 0.5), material);
      plate.position.set(this.x(stationIndex(key)) + BELT_STOP_SHIFT, 0.25, z + (REPAIR_OFFSET + 0.5) / 2);
      this.world.add(plate);
      repairSurfaces.push(material);
    }
    this.repairBelts.set(line.productId, repairSurfaces);

    const bin = placeModel(this.models.bin, { w: 2.4, d: 1.9, h: 1 }, MODEL_TINT.bin, 0x5a1c26);
    bin.position.set(this.x(stationIndex("inspect")), 0, z + BIN_OFFSET);
    this.world.add(bin);

    STATIONS.forEach((station, stationAt) => {
      const size = FOOTPRINT[station.key];
      const model = station.key === "yard" ? yardPad(size) : placeModel(this.models[station.key], size, MODEL_TINT.machine, STATION_COLOR[station.key], true);
      const mx = this.x(stationAt);
      const mz = station.key === "yard" ? z + YARD_Z : station.key === "gate" ? z : z + MACHINE_OFFSET;
      model.position.set(mx, 0, mz);
      model.userData.pick = { kind: "station", productId: line.productId, station: station.key } satisfies Pick;
      model.traverse((node) => (node.userData.pick = model.userData.pick));
      this.world.add(model);
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const height = box.max.y;
      // docs/specs/floor-active.md. The strip sits flush on the front face of the model as drawn,
      // not of its footprint, at the height of the face's middle.
      const glow = new THREE.MeshBasicMaterial({ color: TOKENS.idleGlow });
      const yard = station.key === "yard";
      const strip = new THREE.Mesh(new THREE.BoxGeometry((box.max.x - box.min.x) * (yard ? 0.8 : 0.84), yard ? 0.1 : 0.16, 0.06), glow);
      strip.position.set((box.min.x + box.max.x) / 2, yard ? 0.28 : Math.max(0.35, height * 0.5), box.max.z + 0.035);
      strip.userData.pick = model.userData.pick;
      this.world.add(strip);
      const materials: THREE.MeshStandardMaterial[] = [];
      model.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh && mesh.material instanceof THREE.MeshStandardMaterial && !materials.includes(mesh.material)) materials.push(mesh.material);
      });
      const parts = activeParts(station.key, box, z + BELT_OFFSET, this.x(stationAt) + BELT_STOP_SHIFT);
      if (parts !== null) {
        parts.group.traverse((node) => (node.userData.pick = model.userData.pick));
        this.world.add(parts.group);
      }
      this.machines.set(`${line.productId}:${station.key}`, {
        glow,
        x: mx,
        z: mz,
        top: height,
        label: this.label(station.name, "floor-label"),
        model,
        materials: yard ? [] : materials,
        parts,
      });
    });

    const sign = document.createElement("button");
    sign.type = "button";
    sign.className = "floor-sign";
    const name = document.createElement("span");
    name.className = "floor-sign-name";
    // A long product name is cut with an ellipsis; the tooltip and the line panel show it whole.
    const title = document.createElement("span");
    title.className = "floor-sign-title";
    title.textContent = line.name;
    name.append(title);
    sign.title = `${line.name} (${line.teamKey})\n${line.repositories.join("\n")}`;
    const team = document.createElement("span");
    team.className = "floor-team";
    team.textContent = line.teamKey;
    name.append(" ", team);
    const repositories = document.createElement("span");
    repositories.className = "floor-sign-meta";
    // docs/specs/floor-growth.md. The silos name the repositories; the sign counts them.
    repositories.textContent = line.repositories.length === 1 ? "1 repository" : `${String(line.repositories.length)} repositories`;
    const growth = document.createElement("span");
    growth.className = "floor-sign-growth";
    this.growthSigns.set(line.productId, growth);
    sign.append(name, repositories, growth);
    sign.addEventListener("click", () => this.options.onPick({ kind: "line", productId: line.productId }));
    this.overlay.append(sign);
    this.signs.set(line.productId, sign as unknown as HTMLDivElement);
    this.buildSurroundings(line, z);
  }

  /** docs/specs/floor-growth.md. The sign line that names the merged total and the next building. */
  private updateGrowthSigns(): void {
    for (const line of this.lines) {
      const growth = this.growthSigns.get(line.productId);
      if (growth === undefined) continue;
      const next = nextBuilding(line.mergedTotal);
      growth.textContent = `${String(line.mergedTotal)} merged` + (next === null ? " · fully built" : ` · ${next.name} at ${String(next.at)}`);
    }
  }

  /**
   * docs/specs/floor-growth.md. The crew of each station, the props around the line, a silo per
   * repository behind it and the buildings its merged pull requests unlocked.
   */
  private buildSurroundings(line: SceneLine, z: number): void {
    const m = this.props;
    const random = seeded(line.productId);
    const add = (object: THREE.Object3D, x: number, oz: number, turn = 0): THREE.Object3D => {
      object.position.set(x, 0, z + oz);
      object.rotation.y = turn;
      this.world.add(object);
      return object;
    };

    // Crew: one per station, beside its machine on the belt side.
    STATIONS.forEach((station, stationAt) => {
      const crew = STATION_CREW[station.key];
      if (crew === undefined) return;
      const figure = crewFigure(m, crew.kind);
      figure.group.scale.setScalar(1.45);
      const home = new THREE.Vector3(this.x(stationAt) + FOOTPRINT[station.key].w / 2 + 0.75, 0, z - 2.1);
      figure.group.position.copy(home);
      figure.group.rotation.y = -Math.PI / 2;
      this.world.add(figure.group);
      this.stationCrew.set(`${line.productId}:${station.key}`, { ...figure, kind: crew.kind, home, phase: random() * Math.PI * 2 });
    });

    // The yard in front: a walkway, a safety rail, lamps, pallets and barrels.
    const front = 6.2;
    const length = this.x(9) + 8;
    add(walkway(m, length, 1.6), this.x(4.5) + 1, front);
    add(rail(m, this.x(5) - 2), this.x(2.5), front + 1.1);
    for (let lamp = 0; lamp <= 3; lamp += 1) add(lampPost(m, this.animated), this.x(lamp * 3) - 1, front + 1.6, Math.PI / 2);
    // Stock in front of the line: pallets and barrels in small groups between the lamps.
    const built = builtAt(line.mergedTotal);
    for (let x = this.x(0) + 2; x < this.x(9) + 4; x += 2.6 + random() * 1.8) {
      if (random() < 0.3 || (built.has("trucks") && x > this.x(7) && x < this.x(9))) continue;
      add(random() < 0.65 ? pallet(m, random) : barrels(m, random), x, front + 2.4 + random() * 1.4, random() * 0.5 - 0.25);
    }

    // Behind the line: a walkway, then one silo per repository.
    add(walkway(m, length, 1.4), this.x(4.5) + 1, -6.6);
    // Low silos, so they never outweigh the stations. In one row behind the dock the labels
    // alternate below and above the silos, so neighbours never overlap. In a field only the silos
    // of busy repositories and the silo under the pointer show their name. A long name is cut with
    // an ellipsis and shown whole on hover; a click opens the line panel with every repository.
    const layout = siloLayout(line.repositories.length);
    const pick: Pick = { kind: "line", productId: line.productId };
    line.repositories.forEach((repository, index) => {
      const column = index % layout.columns;
      const row = Math.floor(index / layout.columns);
      const tank = silo(m, 2 + random() * 0.6);
      tank.group.scale.setScalar(layout.scale);
      const x = layout.x0 + column * layout.gap;
      const oz = layout.z0 - row * layout.gap;
      add(tank.group, x, oz);
      tank.group.traverse((node) => (node.userData.pick = pick));
      const above = !layout.field && index % 2 === 1;
      const className = layout.field ? "floor-label floor-silo floor-silo-field" : `floor-label floor-silo${above ? " floor-silo-above" : ""}`;
      const label = this.label(repository.split("/").at(-1) ?? repository, className);
      label.title = repository;
      label.addEventListener("click", () => this.options.onPick(pick));
      const top = tank.top * layout.scale;
      const point = above ? new THREE.Vector3(x, top + 0.2, z + oz) : new THREE.Vector3(x, 0.1, z + oz + 1.3 * layout.scale);
      const key = `${line.productId}:${repository}`;
      this.silos.set(key, { cap: tank.cap, label, point });
      if (layout.field) this.siloHits.push({ object: tank.group, key });
    });

    // docs/specs/floor-growth.md. The buildings the merged pull requests unlocked, behind the
    // line and in its front yard, inside the view the camera fits.
    if (built.has("tanks")) add(tankFarm(m, this.animated), this.x(3.2), -10.6);
    if (built.has("warehouse")) add(warehouse(m, this.animated, new THREE.Vector3(this.x(5.2), 0, z - 11)), this.x(5.2), -11);
    if (built.has("racks")) add(racks(m, random), this.x(9) + 5, -10.2);
    if (built.has("trucks")) add(truckBay(m, this.animated), this.x(8), 10.2, Math.PI / 2);
  }

  private crateView(crate: CrateState): CrateView {
    const existing = this.crates.get(crate.run.id);
    if (existing !== undefined) return existing;
    const body = new THREE.MeshStandardMaterial({ color: TOKENS.crate, roughness: 0.75 });
    const band = new THREE.MeshBasicMaterial({ color: TOKENS.accent });
    const group = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.55, 1.8), body);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.88, 0.3, 1.88), band);
    stripe.position.y = 0.2;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color: TOKENS.canvas, transparent: true, opacity: 0.5 }));
    box.castShadow = true;
    stripe.castShadow = true;
    group.add(box, stripe, edges);
    const pick: Pick = { kind: "run", id: crate.run.id };
    box.userData.pick = pick;
    stripe.userData.pick = pick;
    this.world.add(group);
    const start = this.stationPoint(crate.run.productId, crate.from ?? crate.place, 0);
    group.position.copy(start);
    const view: CrateView = { group, body, band, path: [start], at: start.clone(), pathLength: 0, startedAt: performance.now(), place: crate.from ?? crate.place };
    this.crates.set(crate.run.id, view);
    return view;
  }

  /** The path from one place to the next: along the belt, back on the repair belt, or into the bin. */
  private pathOf(productId: string, from: THREE.Vector3, to: THREE.Vector3, place: Place, repair: boolean): THREE.Vector3[] {
    const z = this.lineZ(productId);
    if (repair) return [from, new THREE.Vector3(from.x, 0, z + REPAIR_OFFSET), new THREE.Vector3(to.x, 0, z + REPAIR_OFFSET), to];
    if (place === "bin") return [from, new THREE.Vector3(from.x, 0, z + BELT_OFFSET), new THREE.Vector3(to.x, 0, z + BELT_OFFSET), to];
    return [from, new THREE.Vector3(from.x, 0, z + BELT_OFFSET), new THREE.Vector3(to.x, 0, z + BELT_OFFSET), to];
  }

  private figure(key: string, head: number): Figure {
    const existing = this.figures.get(key);
    if (existing !== undefined) return existing;
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.9, 10), this.materials.figure);
    body.position.y = 0.45;
    const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.26, 14, 10), new THREE.MeshBasicMaterial({ color: head }));
    headMesh.position.y = 1.15;
    group.add(body, headMesh);
    this.world.add(group);
    const figure = { group, head: headMesh, pill: this.label("", "floor-pill") };
    this.figures.set(key, figure);
    return figure;
  }

  private toScreen(point: THREE.Vector3): { x: number; y: number } {
    const projected = point.clone().project(this.camera);
    return { x: ((projected.x + 1) / 2) * this.container.clientWidth, y: ((1 - projected.y) / 2) * this.container.clientHeight };
  }

  private place(element: HTMLElement, point: THREE.Vector3): void {
    const screen = this.toScreen(point);
    element.style.transform = `translate(${screen.x.toFixed(1)}px, ${screen.y.toFixed(1)}px)`;
  }

  private badge(index: number, text: string, tone: "danger" | "warn" | "count"): HTMLDivElement {
    while (this.badges.length <= index) this.badges.push(this.label("", "floor-badge"));
    const badge = this.badges[index]!;
    badge.textContent = text;
    badge.dataset.tone = tone;
    badge.hidden = false;
    return badge;
  }

  private readonly tick = (now: number): void => {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const motion = !this.options.reducedMotion;
    if (motion) this.belts.forEach((texture) => (texture.offset.x -= dt * 0.6));
    const moment = this.moment;
    const active = new Map<string, Tone>();
    /** The lines whose repair belt carries a crate now. */
    const repairing = new Set<string>();
    /** The stations whose crew member works a session now, with its tool kind. */
    const crewSessions = new Map<string, string>();
    let badges = 0;

    if (moment !== null) {
      // Crates: one per run on the floor, each walking its path to its place.
      const seen = new Set<string>();
      const slots = new Map<string, number>();
      const counts = new Map<string, number>();
      for (const crate of moment.crates) {
        const countKey = `${crate.run.productId}:${crate.place}`;
        counts.set(countKey, (counts.get(countKey) ?? 0) + 1);
      }
      for (const crate of moment.crates) {
        seen.add(crate.run.id);
        const slotKey = `${crate.run.productId}:${crate.place}`;
        const slot = slots.get(slotKey) ?? 0;
        slots.set(slotKey, slot + 1);
        const overflow = crate.place !== "gone" && slot >= this.capacityOf(crate.place);
        const view = this.crateView(crate);
        const goal = this.stationPoint(crate.run.productId, crate.place, slot, Math.min(counts.get(slotKey) ?? 1, this.capacityOf(crate.place)));
        const end = view.path.at(-1)!;
        if (view.place !== crate.place || end.distanceTo(goal) > 0.01) {
          const from = view.at.clone();
          view.path = view.place !== crate.place ? this.pathOf(crate.run.productId, from, goal, crate.place, crate.repair) : [from, goal];
          view.pathLength = view.path.reduce((sum, point, index) => (index === 0 ? 0 : sum + point.distanceTo(view.path[index - 1]!)), 0);
          view.startedAt = now;
          view.place = crate.place;
        }
        // The crate walks its path at a fixed speed. With reduced motion it is at the end at once.
        let remaining = motion ? ((now - view.startedAt) / 1000) * MOVE_SPEED : view.pathLength;
        const position = view.path.at(-1)!.clone();
        let moving = false;
        for (let index = 1; index < view.path.length; index += 1) {
          const segment = view.path[index]!.distanceTo(view.path[index - 1]!);
          if (remaining < segment) {
            position.copy(view.path[index - 1]!).lerp(view.path[index]!, remaining / segment);
            moving = true;
            break;
          }
          remaining -= segment;
        }
        view.at.copy(position);
        if (moving && crate.repair) repairing.add(crate.run.productId);
        view.group.position.set(position.x, 1.3 + position.y + (moving ? Math.abs(Math.sin(now / 160)) * 0.05 : 0) + (crate.place === "bin" ? 0.5 : 0), position.z);
        view.group.visible = (crate.place !== "gone" || moving) && !overflow;
        const color = TONE_COLOR[crate.tone];
        view.band.color.setHex(color);
        // A full yard is many crates; their bands glow less, so the yard does not outshine the line.
        if (crate.place === "yard") view.band.color.multiplyScalar(0.55);
        if (crate.tone === "danger" && crate.place !== "bin" && motion) view.body.emissive.setHex(TOKENS.danger).multiplyScalar(0.25 + 0.2 * Math.sin(now / 120));
        else view.body.emissive.setHex(0x000000);
        if (crate.place !== "gone" && crate.place !== "bin") {
          const machineKey = `${crate.run.productId}:${crate.place}`;
          const tone = crate.place === "intake" ? "idle" : crate.tone;
          const known = active.get(machineKey);
          if (known === undefined || tone === "warning") active.set(machineKey, tone);
        }
        if (crate.status === "WAITING_FOR_INPUT" || crate.status === "BLOCKED_TARGET") {
          this.place(this.badge(badges++, "?", "warn"), view.group.position.clone().setY(3.4));
        }
      }
      for (const [productId, surfaces] of this.repairBelts) {
        const lit = repairing.has(productId);
        for (const surface of surfaces) {
          surface.emissive.setHex(lit ? TOKENS.danger : 0x000000);
          if (lit) surface.emissive.multiplyScalar(0.35 + (motion ? 0.15 * Math.sin(now / 200) : 0));
        }
      }
      // A place with more crates than it shows names the rest as a count.
      for (const [slotKey, count] of slots) {
        const [productId, place] = slotKey.split(":") as [string, Place];
        if (place === "gone" || count <= this.capacityOf(place)) continue;
        const point = this.stationPoint(productId, place, 0);
        this.place(this.badge(badges++, `+${String(count - this.capacityOf(place))}`, "count"), point.setX(point.x - 1.4).setY(3.2));
      }
      for (const [id, view] of this.crates) {
        if (seen.has(id)) continue;
        this.world.remove(view.group);
        disposeTree(view.group);
        this.crates.delete(id);
      }

      for (const alert of moment.alerts) {
        active.set(`${alert.productId}:${alert.station}`, "danger");
        const machine = this.machines.get(`${alert.productId}:${alert.station}`);
        if (machine !== undefined) this.place(this.badge(badges++, "!", "danger"), new THREE.Vector3(machine.x, machine.top + 1.2, machine.z));
      }

      // Operators: one figure per running session, at the machine of its role. The station crew
      // member is the first one; a second session at the same station adds a figure beside it.
      const figuresSeen = new Set<string>();
      const perMachine = new Map<string, number>();
      for (const operator of moment.operators) {
        const station = ROLE_STATION[operator.role];
        if (station === undefined || station === "setup") continue;
        const machine = this.machines.get(`${operator.productId}:${station}`);
        if (machine === undefined) continue;
        const key = `${operator.owner}:${operator.role}`;
        figuresSeen.add(key);
        const count = perMachine.get(`${operator.productId}:${station}`) ?? 0;
        perMachine.set(`${operator.productId}:${station}`, count + 1);
        const silent = moment.at - operator.lastOutputAt;
        const crewMember = this.stationCrew.get(`${operator.productId}:${station}`);
        if (count === 0 && crewMember !== undefined) {
          // The crew member works this session: its pill rides above it.
          const figure = this.figure(key, TOKENS.accent);
          figure.group.visible = false;
          crewSessions.set(`${operator.productId}:${station}`, silent > SILENT_MS ? "silent" : operator.toolKind);
          crewMember.head.color.setHex(silent > SILENT_MS ? TOKENS.warning : TOKENS.accent);
          figure.pill.textContent = `${operator.role} · ${silent > SILENT_MS ? formatSilence(silent) : operator.toolKind}`;
          figure.pill.dataset.tone = silent > SILENT_MS ? "warn" : "accent";
          figure.pill.hidden = false;
          this.place(figure.pill, crewMember.home.clone().setY(3.2));
          if ((active.get(`${operator.productId}:${station}`) ?? "idle") === "idle") active.set(`${operator.productId}:${station}`, "accent");
          continue;
        }
        const figure = this.figure(key, silent > SILENT_MS ? TOKENS.warning : TOKENS.accent);
        (figure.head.material as THREE.MeshBasicMaterial).color.setHex(silent > SILENT_MS ? TOKENS.warning : TOKENS.accent);
        figure.group.position.set(machine.x + 1.6 + count * 0.9, 0.1, this.lineZ(operator.productId) - 0.9);
        const speed = operator.toolKind === "edit" ? 9 : operator.toolKind === "shell" ? 5 : operator.toolKind === "browser" ? 3 : 1.6;
        figure.head.position.y = 1.15 + (motion ? Math.abs(Math.sin((now / 1000) * speed)) * 0.06 : 0);
        figure.group.rotation.y = motion && operator.toolKind === "browser" ? Math.sin(now / 800) * 0.6 : operator.toolKind === "read" ? -0.5 : 0;
        figure.pill.textContent = `${operator.role} · ${silent > SILENT_MS ? formatSilence(silent) : operator.toolKind}`;
        figure.pill.dataset.tone = silent > SILENT_MS ? "warn" : "accent";
        figure.pill.hidden = false;
        this.place(figure.pill, figure.group.position.clone().setY(2.2));
        if ((active.get(`${operator.productId}:${station}`) ?? "idle") === "idle") active.set(`${operator.productId}:${station}`, "accent");
      }
      for (const [key, figure] of this.figures) {
        if (figuresSeen.has(key)) continue;
        this.world.remove(figure.group);
        disposeTree(figure.group);
        figure.pill.remove();
        this.figures.delete(key);
      }

      // Setup crews: at the entrance of the line of their product.
      const crewsSeen = new Set<string>();
      const perLine = new Map<string, number>();
      for (const setup of moment.setups) {
        crewsSeen.add(setup.setup.id);
        let crew = this.crews.get(setup.setup.id);
        if (crew === undefined) {
          // The building being made: a slab, walls half up, corner posts, and a yellow work light.
          const group = new THREE.Group();
          const m = this.props;
          const slab = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.16, 4.4), m.light);
          slab.position.y = 0.08;
          group.add(slab);
          for (const [w, h, d, x, z] of [[3.4, 1.4, 0.3, 0, -1.55], [0.3, 0.9, 3.4, -1.55, 0], [0.3, 1.8, 1.6, 1.55, -0.9], [1.6, 0.6, 0.3, -0.8, 1.55]] as const) {
            const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m.body);
            wall.position.set(x, 0.16 + h / 2, z);
            group.add(wall);
          }
          for (const [x, z] of [[-1.7, -1.7], [1.7, -1.7], [-1.7, 1.7], [1.7, 1.7]] as const) {
            const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3, 0.16), m.steel);
            post.position.set(x, 1.66, z);
            group.add(post);
          }
          const beam = new THREE.Mesh(new THREE.BoxGeometry(3.56, 0.12, 0.16), m.steel);
          beam.position.set(0, 3.1, -1.7);
          const light = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.14, 0.14), new THREE.MeshBasicMaterial({ color: TOKENS.warning }));
          light.position.set(0, 2.96, -1.7);
          group.add(beam, light);
          group.traverse((node) => {
            const mesh = node as THREE.Mesh;
            if (mesh.isMesh) mesh.castShadow = mesh.receiveShadow = true;
          });
          const pick: Pick = { kind: "setup", id: setup.setup.id };
          group.traverse((node) => (node.userData.pick = pick));
          this.world.add(group);
          crew = { group, pill: this.label("", "floor-pill") };
          crew.pill.dataset.tone = "warn";
          this.crews.set(setup.setup.id, crew);
        }
        const count = perLine.get(setup.setup.productId) ?? 0;
        perLine.set(setup.setup.productId, count + 1);
        crew.group.position.set(this.x(0) - 6.5 - count * 5, 0, this.lineZ(setup.setup.productId) + 1.5);
        const pulse = moment.operators.find((operator) => operator.owner === `setup:${setup.setup.id}`);
        crew.pill.textContent = `Setup · ${setup.setup.repository.split("/").at(-1) ?? setup.setup.repository}${pulse === undefined ? ` · ${setup.status}` : ` · ${pulse.toolKind}`}`;
        this.place(crew.pill, crew.group.position.clone().setY(2.9));
      }
      for (const [id, crew] of this.crews) {
        if (crewsSeen.has(id)) continue;
        this.world.remove(crew.group);
        disposeTree(crew.group);
        crew.pill.remove();
        this.crews.delete(id);
      }

      // docs/specs/retro-agent.md. A running retro: one consultant who walks the lines it reads.
      const consultantsSeen = new Set<string>();
      for (const retro of moment.retros) {
        const known = new Set(this.lines.map((line) => line.productId));
        // An empty list names no scope: the retro reads every product on the floor.
        const order = retro.retro.productIds.length === 0 ? [...known] : retro.retro.productIds.filter((id) => known.has(id));
        if (order.length === 0) continue;
        consultantsSeen.add(retro.retro.id);
        const elapsed = Math.max(0, moment.at - Date.parse(retro.retro.startedAt));
        // The pulse names the product the session reads. Before the first pulse, the walk goes line by line.
        const productId =
          retro.productId !== null && known.has(retro.productId)
            ? retro.productId
            : order[Math.floor(elapsed / CONSULTANT_DWELL_MS) % order.length]!;
        const lap = (moment.at % CONSULTANT_LAP_MS) / CONSULTANT_LAP_MS;
        const along = motion ? 1 - Math.abs(1 - 2 * lap) : 0.5;
        const target = new THREE.Vector3(this.x(0) - 1 + along * (this.x(9) + 2), 0, this.lineZ(productId) + CONSULTANT_Z);
        let consultant = this.consultants.get(retro.retro.id);
        if (consultant === undefined) {
          const figure = crewFigure(this.props, "agent");
          // A consultant wears no helmet and carries a clipboard.
          figure.group.traverse((node) => {
            if ((node as THREE.Mesh).isMesh && (node as THREE.Mesh).material === this.props.hazard) node.visible = false;
          });
          const board = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.46, 0.05), this.props.light);
          board.position.set(-0.3, 0.95, 0.28);
          board.rotation.x = -0.5;
          const clip = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.07), this.props.steel);
          clip.position.set(-0.3, 1.18, 0.4);
          clip.rotation.x = -0.5;
          figure.group.add(board, clip);
          figure.group.scale.setScalar(1.45);
          figure.group.position.copy(target);
          const pick: Pick = { kind: "retro", id: retro.retro.id };
          figure.group.traverse((node) => (node.userData.pick = pick));
          this.world.add(figure.group);
          const pill = this.label("", "floor-pill");
          pill.style.pointerEvents = "auto";
          pill.style.cursor = "pointer";
          pill.addEventListener("click", () => this.options.onPick(pick));
          consultant = { group: figure.group, head: figure.head, pill };
          this.consultants.set(retro.retro.id, consultant);
        }
        const position = consultant.group.position;
        const step = target.clone().sub(position).setY(0);
        const distance = step.length();
        if (!motion || distance > 80) {
          position.copy(target);
        } else if (distance > 0.01) {
          position.add(step.multiplyScalar(Math.min(1, (CONSULTANT_SPEED * dt) / distance)));
          consultant.group.rotation.y = Math.atan2(target.x - position.x, target.z - position.z);
        }
        position.y = motion && distance > 0.05 ? Math.abs(Math.sin(now / 160)) * 0.06 : 0;
        const silent = retro.lastOutputAt !== null && moment.at - retro.lastOutputAt > SILENT_MS;
        consultant.head.color.setHex(silent ? TOKENS.warning : TOKENS.accent);
        const name = this.lines.find((line) => line.productId === productId)?.name ?? "";
        const doing = retro.toolKind === null ? "walking the line" : silent ? formatSilence(moment.at - retro.lastOutputAt!) : retro.toolKind;
        consultant.pill.textContent = `Retro · ${name} · ${doing}`;
        consultant.pill.dataset.tone = silent ? "warn" : "accent";
        this.place(consultant.pill, position.clone().setY(2.9));
      }
      for (const [id, consultant] of this.consultants) {
        if (consultantsSeen.has(id)) continue;
        this.world.remove(consultant.group);
        disposeTree(consultant.group);
        consultant.pill.remove();
        this.consultants.delete(id);
      }
    }
    for (let index = badges; index < this.badges.length; index += 1) this.badges[index]!.hidden = true;

    // Machines: light only from state. A working machine breathes and lets off steam.
    for (const [key, machine] of this.machines) {
      const tone = active.get(key);
      const station = key.split(":").at(-1) as StationKey;
      let color: number = TOKENS.idleGlow;
      if (tone === "danger") color = TOKENS.danger;
      else if (tone === "warning") color = TOKENS.warning;
      else if (tone === "success" || ((station === "dock" || station === "gate") && tone !== undefined)) color = TOKENS.success;
      else if (tone === "accent") color = TOKENS.accent;
      machine.glow.color.setHex(color);
      if (tone !== undefined && tone !== "idle") machine.glow.color.multiplyScalar(1.5 + (motion ? 0.35 * Math.sin(now / 420 + machine.x) : 0));
      // docs/specs/floor-active.md. A working station glows in its own colour, shakes a little and
      // runs its parts. An idle one stands still and dark.
      const on = tone === "accent" || tone === "warning" || ((station === "dock" || station === "gate") && tone === "success");
      const own = ACTIVE_COLOR[station];
      for (const material of machine.materials) {
        material.emissive.setHex(on && own !== undefined ? own : 0x000000);
        if (on) material.emissive.multiplyScalar(0.16 + (motion ? 0.07 * Math.sin(now / 300 + machine.x) : 0));
      }
      const shake = on && motion && station !== "dock" && station !== "gate" ? 0.025 : 0;
      machine.model.position.set(machine.x + shake * Math.sin(now / 31), shake * Math.abs(Math.sin(now / 47)), machine.z);
      machine.parts?.animate(motion ? now : 0, on, motion ? dt : 0);
      if (tone === "accent" && motion) {
        const working = station !== "intake" && station !== "dock" && station !== "yard" && station !== "gate";
        if (working && now - (this.lastPuff.get(key) ?? 0) > 700) {
          this.lastPuff.set(key, now);
          const mesh = new THREE.Mesh(this.puffGeometry, new THREE.MeshBasicMaterial({ color: 0x5ff0ff, transparent: true, opacity: 0.35, depthWrite: false }));
          mesh.position.set(machine.x + (Math.random() - 0.5) * 0.6, machine.top + 0.2, machine.z + (Math.random() - 0.5) * 0.6);
          this.world.add(mesh);
          this.puffs.push({ mesh, bornAt: now });
        }
      }
      this.place(machine.label, new THREE.Vector3(machine.x - 0.6, 0, this.lineZ(key.slice(0, key.lastIndexOf(":"))) + (station === "yard" ? YARD_Z + 3.3 : 3)));
      machine.label.dataset.on = tone !== undefined && tone !== "idle" ? "true" : "false";
    }
    // docs/specs/floor-growth.md. The crew works only while its station is lit by real state.
    for (const [key, crew] of this.stationCrew) {
      const tone = active.get(key);
      const working = tone !== undefined && tone !== "idle";
      const session = crewSessions.get(key);
      if (session === undefined) {
        crew.head.color.setHex(working ? (tone === "danger" ? TOKENS.danger : tone === "warning" ? TOKENS.warning : tone === "success" ? TOKENS.success : TOKENS.accent) : 0x3d4f55);
      }
      const t = now / 1000 + crew.phase;
      if (working && motion) {
        // Fast hands for an edit, slower for a shell, a look around in a browser, still for a read.
        const speed = session === "edit" ? 9 : session === "shell" ? 6 : session === "browser" ? 3 : session === "silent" ? 0 : 4;
        crew.arm.rotation.x = Math.sin(t * speed) * 0.7;
        crew.group.position.set(crew.home.x, Math.abs(Math.sin(t * speed)) * 0.05, crew.home.z + Math.sin(t * 0.6) * 0.35);
        crew.group.rotation.y = -Math.PI / 2 + (session === "browser" ? Math.sin(t * 0.8) * 0.6 : Math.sin(t * 0.5) * 0.15);
      } else {
        crew.arm.rotation.x = 0;
        crew.group.position.copy(crew.home);
        crew.group.rotation.y = -Math.PI / 2 + 0.5;
      }
    }
    // Silos light while a run of their repository is on the line, and not ended.
    const busyRepositories = new Set<string>();
    for (const crate of moment?.crates ?? []) {
      if (crate.place === "gone" || crate.place === "bin" || crate.place === "yard" || crate.place === "gate") continue;
      for (const repository of crate.run.repositories) busyRepositories.add(`${crate.run.productId}:${repository}`);
    }
    for (const [key, entry] of this.silos) {
      const busy = busyRepositories.has(key);
      entry.cap.color.setHex(busy ? TOKENS.accent : 0x232c30);
      if (busy && motion) entry.cap.color.multiplyScalar(0.7 + 0.3 * Math.sin(now / 500));
      entry.label.dataset.on = busy ? "true" : "false";
      entry.label.dataset.hover = this.hoveredSilo === key ? "true" : "false";
      this.place(entry.label, entry.point);
    }
    // Decoration moves only in place.
    if (motion) {
      const breathe = 0.82 + 0.18 * Math.sin(now / 1400);
      this.animated.lamps.forEach((lamp) => lamp.color.setHex(lamp.userData.base as number).multiplyScalar(breathe));
      this.animated.fans.forEach((fan) => (fan.rotation.y += dt * 2.4));
      if (now - this.lastSmoke > 900) {
        this.lastSmoke = now;
        for (const point of this.animated.stacks) {
          const mesh = new THREE.Mesh(this.puffGeometry, new THREE.MeshBasicMaterial({ color: 0x55666c, transparent: true, opacity: 0.35, depthWrite: false }));
          mesh.position.copy(point);
          this.world.add(mesh);
          this.puffs.push({ mesh, bornAt: now });
        }
      }
    }
    // Steam rises, grows and fades over two seconds.
    this.puffs = this.puffs.filter((puff) => {
      const age = (now - puff.bornAt) / 2000;
      const material = puff.mesh.material as THREE.MeshBasicMaterial;
      if (age >= 1) {
        this.world.remove(puff.mesh);
        material.dispose();
        return false;
      }
      puff.mesh.position.y += dt * 0.9;
      puff.mesh.scale.setScalar(0.6 + age * 1.4);
      material.opacity = 0.35 * (1 - age);
      return true;
    });
    // A sign stays inside the stage: on a narrow stage the lower lines sit left of the view.
    for (const [productId, sign] of this.signs) {
      const screen = this.toScreen(new THREE.Vector3(this.x(0) - 8, 0, this.lineZ(productId) + 11.5));
      const x = Math.max(8, Math.min(screen.x, this.container.clientWidth - sign.offsetWidth - 8));
      sign.style.transform = `translate(${x.toFixed(1)}px, ${screen.y.toFixed(1)}px)`;
    }

    this.options.onAnchor(this.anchorOf(this.selected));
    this.composer.render();
    this.frame = requestAnimationFrame(this.tick);
  };

  /** The screen point of the selected object, where the bubble points. */
  private anchorOf(pick: Pick | null): { x: number; y: number } | null {
    if (pick === null) return null;
    if (pick.kind === "run") {
      const crate = this.crates.get(pick.id);
      return crate === undefined || !crate.group.visible ? null : this.toScreen(crate.group.position.clone().setY(1.6));
    }
    if (pick.kind === "station") {
      const machine = this.machines.get(`${pick.productId}:${pick.station}`);
      return machine === undefined ? null : this.toScreen(new THREE.Vector3(machine.x, machine.top + 0.4, machine.z));
    }
    if (pick.kind === "setup") {
      const crew = this.crews.get(pick.id);
      return crew === undefined ? null : this.toScreen(crew.group.position.clone().setY(3.2));
    }
    if (pick.kind === "retro") {
      const consultant = this.consultants.get(pick.id);
      return consultant === undefined ? null : this.toScreen(consultant.group.position.clone().setY(3.2));
    }
    return this.toScreen(new THREE.Vector3(this.x(0) - 5, 0, this.lineZ(pick.productId) + 11.5));
  }

  private resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;
    const aspect = width / height;
    const view = this.fitSize / this.zoom;
    this.camera.left = (-view * aspect) / 2;
    this.camera.right = (view * aspect) / 2;
    this.camera.top = view / 2;
    this.camera.bottom = -view / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.bloom.resolution.set(width, height);
    this.placeCamera();
  }

  /**
   * Centres the camera on every line, from the setup crews before the intake to the exit after
   * the deploy gate, and sets the view so all of it fits the stage.
   */
  private fit(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0 || this.lines.length === 0) {
      this.resize();
      return;
    }
    const last = this.lineOffsets.at(-1) ?? 0;
    const back = -13 - siloDepth(this.lines[0]?.repositories.length ?? 0);
    // docs/specs/floor-growth.md. Every line with its silos, its buildings, its front yard and
    // its setup crews.
    const corners = [
      new THREE.Vector3(this.x(0) - 8, 0, back),
      new THREE.Vector3(this.x(9) + 7, 0, back),
      new THREE.Vector3(this.x(0) - 8, 0, last + 14),
      new THREE.Vector3(this.x(9) + 7, 0, last + 14),
      new THREE.Vector3(this.x(5), 6, back - 1),
      new THREE.Vector3(this.x(0) - 6, 4, -2),
    ];
    this.target.set(0, 0, 0);
    this.placeCamera();
    const inverse = this.camera.matrixWorldInverse;
    const local = corners.map((corner) => corner.clone().applyMatrix4(inverse));
    const minX = Math.min(...local.map((point) => point.x));
    const maxX = Math.max(...local.map((point) => point.x));
    const minY = Math.min(...local.map((point) => point.y));
    const maxY = Math.max(...local.map((point) => point.y));
    const aspect = width / height;
    this.fitSize = Math.max(maxY - minY, (maxX - minX) / aspect) * 1.04;
    const centre = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, local[0]!.z).applyMatrix4(this.camera.matrixWorld);
    // Move the target along the view direction to the floor, so the centre stays on screen.
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    const t = -centre.y / direction.y;
    this.target.copy(centre.addScaledVector(direction, t)).setY(0);
    // A narrow stage shows the front of the lines at a readable size, and the viewer pans along.
    if (aspect < 1) {
      this.fitSize = Math.max(40, (maxY - minY) * 0.9);
      this.target.x = this.x(0);
    }
    this.zoom = 1;
    this.resize();
  }

  private placeCamera(): void {
    this.camera.position.copy(this.target).add(CAMERA_OFFSET);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.down = { x: event.clientX, y: event.clientY, target: this.target.clone(), moved: false };
    this.renderer.domElement.setPointerCapture(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const down = this.down;
    if (down === null) {
      this.hoverSilo(event);
      return;
    }
    const dx = event.clientX - down.x;
    const dy = event.clientY - down.y;
    if (!down.moved && Math.hypot(dx, dy) > 5) {
      down.moved = true;
      this.userMoved = true;
      this.renderer.domElement.dataset.dragging = "true";
    }
    if (!down.moved) return;
    const perPixel = (this.camera.top - this.camera.bottom) / this.container.clientHeight;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).setY(0).normalize();
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    const forward = new THREE.Vector3(direction.x, 0, direction.z).normalize();
    const pitch = Math.max(0.3, -direction.y);
    this.target.copy(down.target).addScaledVector(right, -dx * perPixel).addScaledVector(forward, (dy * perPixel) / pitch);
    this.placeCamera();
  };

  /** Names the silo of a field under the pointer. */
  private hoverSilo(event: PointerEvent): void {
    if (this.siloHits.length === 0) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const point = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(point, this.camera);
    const hit = this.raycaster.intersectObjects(this.siloHits.map((entry) => entry.object), true)[0];
    if (hit === undefined) {
      this.hoveredSilo = null;
      return;
    }
    let node: THREE.Object3D | null = hit.object;
    while (node !== null && !this.siloHits.some((entry) => entry.object === node)) node = node.parent;
    this.hoveredSilo = this.siloHits.find((entry) => entry.object === node)?.key ?? null;
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const down = this.down;
    this.down = null;
    delete this.renderer.domElement.dataset.dragging;
    if (down === null || down.moved) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const point = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(point, this.camera);
    const hit = this.raycaster.intersectObjects(this.world.children, true).find((entry) => entry.object.userData.pick !== undefined && entry.object.visible);
    this.options.onPick(hit === undefined ? null : (hit.object.userData.pick as Pick));
  };
}
