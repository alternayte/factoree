import * as THREE from "three";

/**
 * docs/specs/floor-growth.md. The crew, the props and the buildings around a line, drawn in code
 * in the theme greys. Decoration moves only in place: lamps breathe, fans turn, stacks smoke.
 */

/** A random sequence from a text seed, so a line looks the same on every load. */
export const seeded = (seed: string): (() => number) => {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) state = Math.imul(state ^ seed.charCodeAt(index), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const standard = (color: number, roughness = 0.85, metalness = 0.08): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });

/** The shared materials of the props. One set per scene, disposed with it. */
export const propMaterials = () => ({
  dark: standard(0x1f282c),
  body: standard(0x334247),
  light: standard(0x5b6d73),
  steel: standard(0x7d9096, 0.55, 0.35),
  wood: standard(0x4a3f36, 0.95, 0),
  box: standard(0x6c7a7e),
  hazard: standard(0x4a4a42, 0.8, 0.05),
  marking: new THREE.MeshBasicMaterial({ color: 0x272e30 }),
  walkway: standard(0x151c1f, 1, 0),
  rubber: standard(0x0e1214, 0.9, 0),
  // Warm lit windows: cyan on the floor means work.
  window: new THREE.MeshBasicMaterial({ color: 0x6e5a36 }),
});
export type PropMaterials = ReturnType<typeof propMaterials>;

const box = (w: number, h: number, d: number, material: THREE.Material, x = 0, y = h / 2, z = 0): THREE.Mesh => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  return mesh;
};

const cylinder = (top: number, bottom: number, h: number, material: THREE.Material, segments = 16): THREE.Mesh =>
  new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, h, segments), material);

/** What a prop exposes to the frame loop. */
export interface Animated {
  /** Lights that breathe slowly. */
  lamps: THREE.MeshBasicMaterial[];
  /** Parts that turn about y. */
  fans: THREE.Object3D[];
  /** World points where smoke rises. */
  stacks: THREE.Vector3[];
}

export const emptyAnimated = (): Animated => ({ lamps: [], fans: [], stacks: [] });

/** A lamp post with a light that breathes. */
export const lampPost = (m: PropMaterials, animated: Animated): THREE.Group => {
  const group = new THREE.Group();
  const pole = cylinder(0.07, 0.09, 3.2, m.steel, 8);
  pole.position.y = 1.6;
  const arm = box(0.9, 0.08, 0.08, m.steel, 0.4, 3.2, 0);
  const head = box(0.7, 0.2, 0.4, m.body, 0.82, 3.14, 0);
  // A neutral, dim light: cyan on the floor means work.
  const light = new THREE.MeshBasicMaterial({ color: 0x7d8f94 });
  light.userData.base = 0x7d8f94;
  const bulb = box(0.6, 0.05, 0.32, light, 0.82, 3.02, 0);
  const foot = box(0.36, 0.12, 0.36, m.dark, 0, 0.06, 0);
  group.add(pole, arm, head, bulb, foot);
  animated.lamps.push(light);
  return group;
};

/** A pallet, with a stack of boxes on it. */
export const pallet = (m: PropMaterials, random: () => number): THREE.Group => {
  const group = new THREE.Group();
  group.add(box(1.3, 0.14, 1.1, m.wood, 0, 0.07, 0));
  const layers = 1 + Math.floor(random() * 3);
  for (let layer = 0; layer < layers; layer += 1) {
    const count = layer === layers - 1 ? 1 + Math.floor(random() * 4) : 4;
    for (let slot = 0; slot < count; slot += 1) {
      group.add(box(0.58, 0.46, 0.5, m.box, -0.31 + (slot % 2) * 0.62, 0.14 + 0.23 + layer * 0.47, -0.26 + Math.floor(slot / 2) * 0.52));
    }
  }
  return group;
};

/** A group of barrels, one of them with a hazard band. */
export const barrels = (m: PropMaterials, random: () => number): THREE.Group => {
  const group = new THREE.Group();
  const count = 2 + Math.floor(random() * 3);
  for (let index = 0; index < count; index += 1) {
    const barrel = cylinder(0.3, 0.3, 0.86, index === 0 ? m.hazard : m.body, 14);
    barrel.position.set((index % 2) * 0.66 - 0.33, 0.43, Math.floor(index / 2) * 0.66 - 0.33);
    const rim = cylinder(0.31, 0.31, 0.06, m.dark, 14);
    rim.position.set(barrel.position.x, 0.62, barrel.position.z);
    group.add(barrel, rim);
  }
  return group;
};

/** A low safety rail along x. */
export const rail = (m: PropMaterials, length: number): THREE.Group => {
  const group = new THREE.Group();
  const posts = Math.max(2, Math.round(length / 1.6) + 1);
  for (let index = 0; index < posts; index += 1) group.add(box(0.08, 0.9, 0.08, m.hazard, -length / 2 + (index * length) / (posts - 1), 0.45, 0));
  group.add(box(length, 0.07, 0.07, m.hazard, 0, 0.86, 0), box(length, 0.05, 0.05, m.hazard, 0, 0.5, 0));
  return group;
};

/** A walkway along x: a dark strip with dashed markings on both edges. */
export const walkway = (m: PropMaterials, length: number, width: number): THREE.Group => {
  const group = new THREE.Group();
  group.add(box(length, 0.03, width, m.walkway, 0, 0.015, 0));
  for (let x = -length / 2 + 0.6; x < length / 2 - 0.4; x += 1.4) {
    group.add(box(0.7, 0.012, 0.1, m.marking, x, 0.035, -width / 2 + 0.1), box(0.7, 0.012, 0.1, m.marking, x, 0.035, width / 2 - 0.1));
  }
  return group;
};

/** A silo for one repository. Its cap ring lights while a run of the repository is on the line. */
export const silo = (m: PropMaterials, height: number): { group: THREE.Group; cap: THREE.MeshBasicMaterial; top: number } => {
  const group = new THREE.Group();
  const shell = cylinder(1.15, 1.15, height, m.body, 20);
  shell.position.y = height / 2 + 0.6;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1.15, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), m.light);
  dome.position.y = height + 0.6;
  const cap = new THREE.MeshBasicMaterial({ color: 0x232c30 });
  const ring = cylinder(1.19, 1.19, 0.14, cap, 20);
  ring.position.y = height + 0.45;
  for (const angle of [0.6, 2.2, 3.8, 5.4]) {
    const leg = box(0.16, 0.8, 0.16, m.steel, Math.cos(angle) * 0.95, 0.4, Math.sin(angle) * 0.95);
    group.add(leg);
  }
  const ladder = box(0.3, height, 0.06, m.steel, 0, height / 2 + 0.6, 1.17);
  group.add(shell, dome, ring, ladder);
  return { group, cap, top: height + 1.75 };
};

/** Storage racks: two shelving units with boxes, behind the PR yard. */
export const racks = (m: PropMaterials, random: () => number): THREE.Group => {
  const group = new THREE.Group();
  for (let unit = 0; unit < 2; unit += 1) {
    const x = unit * 3.4 - 1.7;
    for (const px of [-1.4, 1.4]) for (const pz of [-0.5, 0.5]) group.add(box(0.1, 3, 0.1, m.hazard, x + px, 1.5, pz));
    for (let shelf = 0; shelf < 3; shelf += 1) {
      const y = 0.2 + shelf * 1.1;
      group.add(box(2.9, 0.08, 1.1, m.steel, x, y, 0));
      for (let slot = 0; slot < 4; slot += 1) {
        if (random() < 0.25) continue;
        group.add(box(0.6, 0.5 + random() * 0.3, 0.8, m.box, x - 1.05 + slot * 0.7, y + 0.34, 0));
      }
    }
  }
  return group;
};

/** A tank farm: two tanks joined by pipes, with a pump. */
export const tankFarm = (m: PropMaterials, animated: Animated): THREE.Group => {
  const group = new THREE.Group();
  for (const [x, radius, height] of [[-1.8, 1.5, 3.6], [1.9, 1.2, 2.8]] as const) {
    const tank = cylinder(radius, radius, height, m.light, 22);
    tank.position.set(x, height / 2 + 0.2, 0);
    const lid = cylinder(radius * 0.7, radius, 0.5, m.body, 22);
    lid.position.set(x, height + 0.45, 0);
    const band = cylinder(radius + 0.02, radius + 0.02, 0.18, m.hazard, 22);
    band.position.set(x, height * 0.7, 0);
    group.add(tank, lid, band);
  }
  group.add(box(0.3, 3.4, 0.3, m.steel, 0, 1.7, 0.9), box(4.2, 0.3, 0.3, m.steel, 0, 3.2, 0.9), box(4.2, 0.24, 0.24, m.steel, 0, 0.6, 1.3));
  const pump = box(1, 0.8, 0.8, m.dark, 0, 0.4, 2);
  const valve = new THREE.Group();
  valve.add(box(0.7, 0.06, 0.1, m.hazard), box(0.1, 0.06, 0.7, m.hazard));
  valve.position.set(0, 0.86, 2);
  group.add(pump, valve);
  animated.fans.push(valve);
  return group;
};

/** A warehouse with a saw-tooth roof, a roll-up door, lit windows, a roof fan and a stack. */
export const warehouse = (m: PropMaterials, animated: Animated, origin: THREE.Vector3): THREE.Group => {
  const group = new THREE.Group();
  const w = 9;
  const d = 6;
  const h = 4;
  group.add(box(w, h, d, m.body, 0, h / 2, 0));
  for (let tooth = 0; tooth < 3; tooth += 1) {
    const x = -w / 2 + 1.5 + tooth * 3;
    const roof = box(3, 0.9, d, m.dark, x, h + 0.45, 0);
    roof.rotation.z = 0.18;
    group.add(roof, box(0.1, 0.7, d - 0.4, m.window, x + 1.45, h + 0.45, 0));
  }
  group.add(box(2.6, 2.6, 0.08, m.light, -1.8, 1.3, d / 2 + 0.04));
  for (let slat = 0; slat < 6; slat += 1) group.add(box(2.6, 0.04, 0.1, m.dark, -1.8, 0.25 + slat * 0.42, d / 2 + 0.06));
  group.add(box(3.2, 0.5, 0.08, m.window, 2.4, 2.6, d / 2 + 0.04));
  const fan = new THREE.Group();
  fan.add(box(1.3, 0.06, 0.22, m.steel), box(0.22, 0.06, 1.3, m.steel));
  fan.position.set(2.8, h + 1.05, -1.2);
  group.add(cylinder(0.75, 0.75, 0.3, m.dark, 18).translateX(2.8).translateY(h + 0.9).translateZ(-1.2), fan);
  animated.fans.push(fan);
  const stack = cylinder(0.4, 0.5, 4, m.light, 14);
  stack.position.set(-w / 2 + 0.8, h + 2, -d / 2 + 0.8);
  group.add(stack);
  animated.stacks.push(origin.clone().add(new THREE.Vector3(-w / 2 + 0.8, h + 4.1, -d / 2 + 0.8)));
  return group;
};

/** A truck bay: a loading slab and a parked truck. */
export const truckBay = (m: PropMaterials, animated: Animated): THREE.Group => {
  const group = new THREE.Group();
  group.add(box(4.4, 0.1, 7.2, m.walkway, 0, 0.05, 0));
  for (let index = 0; index < 4; index += 1) group.add(box(0.12, 0.02, 1.2, m.marking, -2.1, 0.11, -3 + index * 2));
  const truck = new THREE.Group();
  truck.add(box(2.2, 2.2, 4.4, m.light, 0, 1.55, -0.8));
  truck.add(box(2.1, 1.6, 1.6, m.body, 0, 1.25, 2.3));
  truck.add(box(1.9, 0.5, 0.06, m.window, 0, 1.7, 3.11));
  const light = new THREE.MeshBasicMaterial({ color: 0x8a6a3a });
  light.userData.base = 0x8a6a3a;
  truck.add(box(0.3, 0.16, 0.06, light, -0.8, 0.8, 3.11), box(0.3, 0.16, 0.06, light, 0.8, 0.8, 3.11));
  animated.lamps.push(light);
  for (const z of [-2.2, -0.8, 2.3]) {
    for (const x of [-1.05, 1.05]) {
      const wheel = cylinder(0.42, 0.42, 0.3, m.rubber, 14);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.42, z);
      truck.add(wheel);
    }
  }
  group.add(truck);
  return group;
};

/** One crew member. An agent wears a helmet; a bot is a box on a wheel. */
export const crewFigure = (m: PropMaterials, kind: "agent" | "bot"): { group: THREE.Group; head: THREE.MeshBasicMaterial; arm: THREE.Object3D } => {
  const group = new THREE.Group();
  const head = new THREE.MeshBasicMaterial({ color: 0x3d4f55 });
  const arm = new THREE.Group();
  if (kind === "agent") {
    const legs = cylinder(0.26, 0.3, 0.55, m.dark, 10);
    legs.position.y = 0.3;
    const body = cylinder(0.3, 0.27, 0.62, m.light, 10);
    body.position.y = 0.86;
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 10), head);
    face.position.y = 1.4;
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.27, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), m.hazard);
    helmet.position.y = 1.44;
    arm.add(box(0.12, 0.5, 0.12, m.light, 0, -0.22, 0));
    arm.position.set(0.36, 1.08, 0);
    group.add(legs, body, face, helmet, arm);
  } else {
    const wheel = cylinder(0.32, 0.32, 0.22, m.rubber, 14);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.y = 0.32;
    const body = box(0.7, 0.62, 0.6, m.light, 0, 0.88, 0);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.04), head);
    visor.position.set(0, 0.98, 0.31);
    const antenna = box(0.04, 0.4, 0.04, m.steel, 0.2, 1.39, 0);
    arm.add(box(0.5, 0.1, 0.1, m.steel, 0.25, 0, 0));
    arm.position.set(0.35, 0.86, 0.1);
    group.add(wheel, body, visor, antenna, arm);
  }
  return { group, head, arm };
};
