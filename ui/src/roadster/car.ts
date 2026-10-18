// The cars: three original faceted designs, one per engine, built from flat
// panels and hard creases (the launch's look, none of its branding).
//
// - Roadster (Claude Code): a low wedge, a long flat hood, a dark canopy that
//   sweeps to a Kammback, full-width light bars, angular wheel arches, a big
//   wing on struts, four suction fans in the diffuser and cold-gas thrusters
//   at the corners. It launches off the arch and flips.
// - GT (Codex): longer and taller, a fastback roof running to a ducktail.
// - Formula (OpenCode): a single-seater, open wheels, front and rear wings.
// - Rosso (a terminal): a front-engined grand tourer in deep red, a long
//   bonnet, the cabin set far back, wide rear haunches with a sculpted intake
//   ahead of each rear wheel, a short tail with a ducktail lip. No badge.
//
// A body is a run of cross-sections ("stations", tail to nose). Each station
// is a half-profile from the centre of the floor round the side to the centre
// of the roof; neighbours are joined by flat quads, mirrored for the left.
// Facets are coloured by what they are (paint, glass, dark sill, wheel arch),
// and the paint colour multiplies them. Facing +x, wheels on y = 0.

import * as THREE from 'three';

import type { Engine } from '../lib/types';

export type CarKind = 'roadster' | 'gt' | 'formula' | 'rosso';

/** The terminal cars' paint: rosso, as the season's red GT. */
export const ROSSO = 0xb3121b;

export const KIND_OF: Record<Engine, CarKind> = { claude: 'roadster', codex: 'gt', opencode: 'formula' };

export interface CarModel {
  body: THREE.BufferGeometry;
  /** Pieces in the dark trim colour (wings, splitter, diffuser). */
  trim: THREE.BufferGeometry[];
  wheels: [number, number][];
  wheelR: number;
  wheelW: number;
  length: number;
  /** Light bars: x, y, width (z), height. */
  front: [number, number, number, number] | null;
  rear: [number, number, number, number];
  /** Suction fans in the rear face (centres [y, z]) and thruster nozzles. */
  fans: [number, number][];
  fanX: number;
  nozzles: [number, number, number][];
}

const C = {
  paint: [1, 1, 1],
  shade: [0.8, 0.81, 0.83],
  glass: [0.035, 0.04, 0.05],
  dark: [0.09, 0.095, 0.11],
  arch: [0.025, 0.025, 0.03],
};

/** A half-profile point and the colour of the facet that runs from it to the next point. */
type Pt = [z: number, y: number, facet: keyof typeof C];

interface Spec {
  /** Stations: x and its half-profile (floor centre → roof centre). Every station has the same number of points. */
  stations: [number, Pt[]][];
  /** Wheel centres along x, radius: side facets inside an arch go dark. */
  arches: { x: number[]; r: number; top: number };
}

function loft({ stations, arches }: Spec): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], colour: number[]) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let i = 0; i < 6; i++) col.push(...colour);
  };
  const inArch = (x: number, y: number) => arches.x.some((ax) => Math.abs(x - ax) < arches.r * 1.18 && y < arches.top);
  for (let i = 0; i < stations.length - 1; i++) {
    const [xa, pa] = stations[i];
    const [xb, pb] = stations[i + 1];
    for (let j = 0; j < pa.length - 1; j++) {
      const midX = (xa + xb) / 2;
      const midY = (pa[j][1] + pa[j + 1][1] + pb[j][1] + pb[j + 1][1]) / 4;
      const side = Math.abs(pa[j][0] - pa[j + 1][0]) < Math.abs(pa[j][1] - pa[j + 1][1]);
      const facet = side && inArch(midX, midY) ? 'arch' : pa[j][2];
      for (const s of [1, -1]) {
        const A = [xa, pa[j][1], s * pa[j][0]];
        const B = [xb, pb[j][1], s * pb[j][0]];
        const Cc = [xb, pb[j + 1][1], s * pb[j + 1][0]];
        const D = [xa, pa[j + 1][1], s * pa[j + 1][0]];
        if (s === 1) quad(A, B, Cc, D, C[facet]);
        else quad(A, D, Cc, B, C[facet]);
      }
    }
  }
  // End caps: the tail (dark below the light bar) and the nose.
  for (const [k, flip] of [[0, true], [stations.length - 1, false]] as const) {
    const [x, p] = stations[k];
    const cy = (p[0][1] + p[p.length - 1][1]) / 2;
    for (let j = 0; j < p.length - 1; j++)
      for (const s of [1, -1]) {
        const a = [x, p[j][1], s * p[j][0]];
        const b = [x, p[j + 1][1], s * p[j + 1][0]];
        const c = [x, cy, 0];
        const colour = flip ? (p[j][1] < cy + 0.15 ? C.dark : C.paint) : p[j][2] === 'glass' ? C.glass : C.paint;
        const front = (s === 1) !== flip;
        pos.push(...c, ...(front ? a : b), ...(front ? b : a));
        for (let n = 0; n < 3; n++) col.push(...colour);
      }
  }
  // Texture coordinates: the brushing runs along the car on every panel.
  const uv: number[] = [];
  for (let i = 0; i < pos.length; i += 3) uv.push(pos[i] * 0.45, (pos[i + 1] + Math.abs(pos[i + 2])) * 0.45);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** A trim piece; `rz` tilts it about z. */
const box = (w: number, h: number, d: number, x: number, y: number, z: number, rz = 0) => {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rz) g.rotateZ(rz);
  return g.translate(x, y, z);
};

/**
 * A half-profile at one station, from a handful of numbers: floor height,
 * body half-width, shoulder (crease) height, beltline, roof half-width and
 * roof height, and whether the cabin is glass here.
 */
function prof(floor: number, w: number, shoulder: number, belt: number, roofW: number, roof: number, glass: boolean, sill = 0.94, intake = false): Pt[] {
  return [
    [0, floor, 'dark'],
    [w * sill, floor, 'dark'],
    [w, floor + 0.12, intake ? 'arch' : 'paint'],
    [w, shoulder - 0.06, 'shade'],
    [w * 0.985, shoulder, 'paint'],
    [w * 0.9, belt, glass ? 'glass' : 'paint'],
    [roofW, roof, glass ? 'glass' : 'paint'],
    [0, roof + 0.015, 'paint'],
  ];
}

function roadster(): CarModel {
  // x from the tail (-2.36) to the nose (2.4); the glass runs from ahead of the doors to the end of the canopy.
  const S: [number, Pt[]][] = [
    [-2.36, prof(0.3, 0.9, 0.78, 0.86, 0.6, 0.9, false)],
    [-2.2, prof(0.2, 0.97, 0.8, 0.88, 0.62, 0.92, false)],
    [-1.75, prof(0.16, 1.0, 0.8, 0.9, 0.6, 0.98, false)],
    [-1.2, prof(0.15, 1.0, 0.78, 0.9, 0.54, 1.08, true, 0.94, true)],
    [-0.55, prof(0.15, 0.99, 0.76, 0.88, 0.5, 1.17, true)],
    [0.1, prof(0.15, 0.98, 0.74, 0.86, 0.5, 1.19, true)],
    [0.55, prof(0.15, 0.97, 0.72, 0.84, 0.56, 1.0, true)],
    [0.95, prof(0.15, 0.96, 0.7, 0.8, 0.66, 0.84, false)],
    [1.5, prof(0.15, 0.95, 0.66, 0.74, 0.7, 0.76, false)],
    [2.0, prof(0.16, 0.93, 0.58, 0.64, 0.7, 0.66, false)],
    [2.4, prof(0.22, 0.86, 0.42, 0.47, 0.62, 0.5, false, 0.9)],
  ];
  return {
    body: loft({ stations: S, arches: { x: [1.45, -1.45], r: 0.39, top: 0.82 } }),
    trim: [
      box(0.48, 0.035, 1.96, -2.1, 1.2, 0, -0.07), // the wing
      box(0.05, 0.28, 0.04, -2.0, 1.04, 0.48),
      box(0.05, 0.28, 0.04, -2.0, 1.04, -0.48),
      box(0.42, 0.16, 0.025, -2.1, 1.14, 0.97), // endplates
      box(0.42, 0.16, 0.025, -2.1, 1.14, -0.97),
      box(0.32, 0.025, 1.7, 2.3, 0.15, 0), // splitter
      box(0.04, 0.22, 1.6, -2.37, 0.38, 0), // diffuser face
    ],
    wheels: [[1.45, 0.88], [1.45, -0.88], [-1.45, 0.88], [-1.45, -0.88]],
    wheelR: 0.37,
    wheelW: 0.3,
    length: 4.76,
    front: [2.41, 0.4, 1.66, 0.022],
    rear: [-2.37, 0.76, 1.76, 0.04],
    fans: [[0.42, -0.6], [0.42, -0.2], [0.42, 0.2], [0.42, 0.6]],
    fanX: -2.41,
    nozzles: [[-2.12, 0.18, 0.8], [-2.12, 0.18, -0.8], [2.05, 0.18, 0.8], [2.05, 0.18, -0.8]],
  };
}

function gt(): CarModel {
  const S: [number, Pt[]][] = [
    [-2.5, prof(0.32, 0.92, 0.84, 0.94, 0.62, 0.99, false)],
    [-2.3, prof(0.2, 1.0, 0.86, 0.96, 0.64, 1.04, false)],
    [-1.7, prof(0.18, 1.03, 0.85, 0.98, 0.6, 1.14, true)],
    [-0.9, prof(0.18, 1.03, 0.83, 0.96, 0.56, 1.28, true)],
    [-0.1, prof(0.18, 1.02, 0.82, 0.95, 0.54, 1.32, true)],
    [0.5, prof(0.18, 1.01, 0.8, 0.92, 0.6, 1.14, true)],
    [1.0, prof(0.18, 1.0, 0.78, 0.88, 0.7, 0.92, false)],
    [1.7, prof(0.18, 0.98, 0.72, 0.8, 0.72, 0.82, false)],
    [2.2, prof(0.2, 0.95, 0.62, 0.68, 0.7, 0.7, false)],
    [2.55, prof(0.26, 0.88, 0.46, 0.5, 0.6, 0.54, false, 0.9)],
  ];
  return {
    body: loft({ stations: S, arches: { x: [1.6, -1.55], r: 0.4, top: 0.86 } }),
    trim: [box(0.36, 0.04, 1.86, -2.46, 1.02, 0, 0.2), box(0.5, 0.03, 1.9, 2.45, 0.16, 0)],
    wheels: [[1.6, 0.92], [1.6, -0.92], [-1.55, 0.92], [-1.55, -0.92]],
    wheelR: 0.38,
    wheelW: 0.32,
    length: 5.05,
    front: [2.56, 0.44, 1.72, 0.022],
    rear: [-2.51, 0.84, 1.84, 0.045],
    fans: [],
    fanX: -2.5,
    nozzles: [],
  };
}

function formula(): CarModel {
  const tub = (floor: number, w: number, top: number, cockpit: boolean): Pt[] => [
    [0, floor, 'dark'],
    [w * 0.9, floor, 'dark'],
    [w, floor + 0.08, 'paint'],
    [w, top - 0.12, 'shade'],
    [w * 0.92, top - 0.05, 'paint'],
    [w * 0.7, top, cockpit ? 'glass' : 'paint'],
    [w * 0.35, top + 0.04, cockpit ? 'glass' : 'paint'],
    [0, top + 0.05, 'paint'],
  ];
  const S: [number, Pt[]][] = [
    [-2.2, tub(0.16, 0.3, 0.58, false)],
    [-1.6, tub(0.13, 0.42, 0.66, false)],
    [-0.9, tub(0.12, 0.62, 0.6, false)],
    [-0.3, tub(0.12, 0.64, 0.56, false)],
    [0.1, tub(0.12, 0.42, 0.72, true)],
    [0.55, tub(0.12, 0.34, 0.6, false)],
    [1.3, tub(0.13, 0.24, 0.46, false)],
    [2.0, tub(0.15, 0.16, 0.36, false)],
    [2.55, tub(0.17, 0.08, 0.26, false)],
  ];
  return {
    body: loft({ stations: S, arches: { x: [], r: 0, top: 0 } }),
    trim: [
      box(0.5, 0.035, 2.0, 2.4, 0.13, 0),
      box(0.42, 0.05, 1.4, -2.1, 0.98, 0, -0.08),
      box(0.4, 0.46, 0.03, -2.1, 0.78, 0.7),
      box(0.4, 0.46, 0.03, -2.1, 0.78, -0.7),
      box(0.05, 0.36, 0.05, -2.0, 0.76, 0),
      box(1.6, 0.03, 0.05, -0.4, 0.3, 0.6), // suspension arms
      box(1.6, 0.03, 0.05, -0.4, 0.3, -0.6),
    ],
    wheels: [[1.75, 0.82], [1.75, -0.82], [-1.35, 0.82], [-1.35, -0.82]],
    wheelR: 0.35,
    wheelW: 0.38,
    length: 5.0,
    front: null,
    rear: [-2.22, 0.45, 0.3, 0.05],
    fans: [],
    fanX: -2.2,
    nozzles: [],
  };
}

function rosso(): CarModel {
  // x from the tail (-2.32) to the nose (2.6): bonnet from 0.2 forward, glass from -1.3 to -0.2.
  // The shoulder rises over each wheel (the fenders) and dips between: the long-bonnet stance.
  const S: [number, Pt[]][] = [
    [-2.32, prof(0.3, 0.86, 0.8, 0.86, 0.62, 0.92, false)],
    [-2.14, prof(0.2, 0.97, 0.84, 0.91, 0.62, 0.96, false)],
    [-1.62, prof(0.16, 1.05, 0.88, 0.95, 0.56, 1.0, false)],
    [-1.3, prof(0.15, 1.02, 0.84, 0.92, 0.5, 1.1, true, 0.94, true)],
    [-0.95, prof(0.15, 0.98, 0.78, 0.89, 0.47, 1.18, true, 0.94, true)],
    [-0.55, prof(0.15, 0.96, 0.75, 0.87, 0.47, 1.2, true)],
    [-0.2, prof(0.15, 0.95, 0.73, 0.84, 0.54, 1.08, true)],
    [0.2, prof(0.15, 0.95, 0.71, 0.79, 0.66, 0.86, false)],
    [0.8, prof(0.15, 0.95, 0.69, 0.75, 0.7, 0.8, false)],
    [1.3, prof(0.15, 0.98, 0.74, 0.79, 0.68, 0.79, false)],
    [1.7, prof(0.15, 0.99, 0.75, 0.8, 0.66, 0.78, false)],
    [2.12, prof(0.16, 0.95, 0.66, 0.7, 0.62, 0.7, false)],
    [2.42, prof(0.19, 0.9, 0.52, 0.56, 0.6, 0.58, false)],
    [2.6, prof(0.23, 0.82, 0.4, 0.44, 0.56, 0.48, false, 0.9)],
  ];
  return {
    body: loft({ stations: S, arches: { x: [1.62, -1.5], r: 0.39, top: 0.84 } }),
    trim: [
      box(0.3, 0.03, 1.64, -2.3, 0.97, 0, 0.32), // ducktail lip
      box(0.3, 0.025, 1.6, 2.47, 0.2, 0), // splitter, tucked under the nose
      box(0.04, 0.2, 1.5, -2.33, 0.36, 0), // diffuser face
    ],
    wheels: [[1.62, 0.9], [1.62, -0.9], [-1.5, 0.92], [-1.5, -0.92]],
    wheelR: 0.37,
    wheelW: 0.31,
    length: 4.92,
    front: [2.61, 0.4, 1.4, 0.02],
    // No bar: the twin round lamps each side are added where the car is built.
    rear: [-2.33, 0.78, 0.001, 0.001],
    fans: [],
    fanX: -2.32,
    nozzles: [],
  };
}

/** The rosso's twin round tail lamps: [y, z] of each, on the tail face. */
export const ROSSO_LAMPS: [number, number][] = [[0.76, 0.66], [0.76, 0.4], [0.76, -0.4], [0.76, -0.66]];

const models = new Map<CarKind, CarModel>();
export function carModel(kind: CarKind): CarModel {
  let m = models.get(kind);
  if (!m) {
    m = kind === 'gt' ? gt() : kind === 'formula' ? formula() : kind === 'rosso' ? rosso() : roadster();
    models.set(kind, m);
  }
  return m;
}
