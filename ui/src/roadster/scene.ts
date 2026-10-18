// The Roadster world as a race broadcast. Each camera is a photoreal plate
// (the concept art, emptied of cars) with live 3D cars composited into it
// through a camera solved to match the plate: rays cast from the plate's own
// pixels (the road, the ramp, the vanishing point) place the cars, and the
// plate itself lights and reflects them.
//
// - Home: the gantry over the wet straight by the bay. Working cars come past
//   the camera and race away into the bend; a car waiting on the person pulls
//   over by the left barrier, hazards on; finished cars park further up.
// - Launch: a new Claude Code car (the roadster) is cut to the truss arch: up
//   the ramp on its fans, off the top, a barrel roll on cold gas over the
//   lineup. Then back to home as it comes past the camera.
// - Chase: riding behind one car under the start lights (onboard).
//
// Hover a car and it's yours: ↑↓ speed, ←→ lane, space its trick (the roadster
// flips, the others boost), scroll to cut to the chase camera on it.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import type { ArenaKey, Engine } from '../lib/types';
import { type CarKind, type CarModel, KIND_OF, ROSSO, ROSSO_LAMPS, carModel } from './car';
import chaseDayUrl from './plates/chase-day.jpg';
import chaseUrl from './plates/chase.jpg';
import homeDayUrl from './plates/home-day.jpg';
import homeUrl from './plates/home.jpg';
import launchDayUrl from './plates/launch-day.jpg';
import pitDayUrl from './plates/pit-day.jpg';
import pitUrl from './plates/pit.jpg';
import brushedUrl from './plates/brushed.jpg';
import launchUrl from './plates/launch.jpg';
import { ARENA_PLATES } from './arenaPlates';

export type CarState = 'forming' | 'working' | 'needsYou' | 'landed' | 'failed' | 'stopped';
export interface CarSpec {
  id: string;
  state: CarState;
  stalled: boolean;
  engine: Engine;
  /** A car of another kind than the engine's: a terminal is a rosso GT. */
  kind?: CarKind;
}
export type Shot = { kind: 'wide' } | { kind: 'onboard'; id: string } | { kind: 'radio' } | { kind: 'paddock' } | { kind: 'pit' };
export type Mood = 'ready' | 'thinking' | 'hearing';
export type Key = 'up' | 'down' | 'left' | 'right' | 'action';
type Phase = 'grid' | 'launch' | 'race' | 'drive';
export type ViewName = 'home' | 'launch' | 'chase' | 'pit';
export type TimeOfDay = 'night' | 'day';

/** The launch: the path in plate pixels, timing and the roll. */
export interface LaunchTune {
  ramp: [number, number][];
  flight: [number, number][];
  depth: number;
  rampT: number;
  flightT: number;
  /** Full rolls in the air. */
  rolls: number;
  /** Where in the flight (0..1) the roll starts and ends. */
  rollFrom: number;
  rollTo: number;
}

/** What the tests (and the car card) can read about a car. */
export interface CarDebug {
  kind: CarKind;
  phase: Phase;
  state: CarState;
  pos: [number, number, number];
  up: [number, number, number];
  offTrack: number;
  launchT: number;
  lane: number;
  speed: number;
  hopping: boolean;
  view: ViewName;
  /** Yaw still unwinding from a spin-out. */
  spinOut: number;
}

const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const smoother = (u: number) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * x * (x * (x * 6 - 15) + 10);
};
const CYAN = new THREE.Color(0x58d8ff);
const AMBER = new THREE.Color(0xffa62b);
const LANES = [-1.7, 1.7];
const HOP_T = 1.5;
const BOOST_T = 1.6;

// ── The plates and their cameras ─────────────────────────────────────────
// Pixel positions are on the plate scaled to 2000 × 1116.

const PW = 2000;
const PH = 1116;
/** Every plate is treated as shot through a 45° lens. */
const VFOV = 45;

interface ViewDef {
  pos: THREE.Vector3;
  /** Degrees: + looks up. */
  pitch: number;
}

const VIEWS: Record<ViewName, ViewDef> = {
  home: { pos: v3(0, 4.6, 0), pitch: 0 },
  launch: { pos: v3(0, 1.5, 0), pitch: 0 },
  pit: { pos: v3(0, 1.5, 0), pitch: 0 },
  // Low behind the car, tilted up at the lights; the road runs off to the right of centre.
  chase: { pos: v3(0, 1.1, 0), pitch: 9.4 },
};

/** Each arena's plates: the Bay's, painted over into another place with the
 *  same cameras and the same track, so one set of traced pixels fits them all. */
type Plates = Record<ViewName, { night: string; day?: string }>;
const PLATES: Record<ArenaKey, Plates> = {
  bay: { home: { night: homeUrl, day: homeDayUrl }, launch: { night: launchUrl, day: launchDayUrl }, chase: { night: chaseUrl, day: chaseDayUrl }, pit: { night: pitUrl, day: pitDayUrl } },
  mesa: ARENA_PLATES.mesa,
  porto: ARENA_PLATES.porto,
  glace: ARENA_PLATES.glace,
};

/** Home: the line the cars race along, traced on the plate, then on round behind the camera. */
const HOME_RACE_PX: [number, number][] = [[800, 1080], [850, 950], [905, 840], [965, 745], [1035, 675], [1130, 632], [1260, 607], [1400, 598], [1520, 606]];
/** Home: the gantry's posts (bases), which cars pass behind. */
const HOME_POSTS_PX: [number, number][] = [[455, 632], [1345, 642]];
const SIGN_PX = { home: [565, 150, 1205, 272], chase: [440, 80, 1385, 340] } as const;
/** Launch: up the arch and off the top, then the flight over the lineup. */
export const DEFAULT_TUNE: LaunchTune = {
  ramp: [[1150, 800], [1300, 740], [1450, 620], [1560, 480], [1640, 340], [1680, 250], [1700, 190], [1706, 140]],
  flight: [[1679, 69], [1592, 12], [1470, 9], [442, 546], [320, 610]],
  depth: 21.5,
  rampT: 1.6,
  flightT: 1.4,
  rolls: 0.5,
  rollFrom: 0.07,
  rollTo: 1,
};
/** Chase: where the car sits (ground under its centre) and where the road vanishes. */
const CHASE_CAR_PX: [number, number] = [820, 850];
const CHASE_VANISH_PX: [number, number] = [1690, 782];

/** Seconds of cutscene (the thrusters fire, the car charges the ramp) before the live launch. */
export const CUT_T = 2.6;
/** Seconds it takes to drop onto the home straight after the cut. */
const DROP_T = 0.75;
/** Bays: angled parking along the left verge of the home straight. */
/** Home: the paddock's painted bay lines (left end, right end), nearest first. Cars park between them; the first two bays are the pit. */
const BAY_LINES_PX: [number, number, number, number][] = [[0, 848, 525, 966], [80, 776, 640, 862], [230, 740, 718, 800], [335, 715, 768, 755], [440, 690, 805, 726], [525, 672, 835, 700], [590, 657, 858, 682]];
const PIT_BAYS = 2;

interface Rig {
  id: string;
  kind: CarKind;
  model: CarModel;
  group: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Object3D[];
  mirror: THREE.Group;
  shadow: THREE.Mesh;
  streaks: THREE.Sprite[];
  /** Thruster flames at the nozzles, scaled by thrust. */
  jets: THREE.Mesh[];
  paint: THREE.MeshPhysicalMaterial;
  front: THREE.MeshBasicMaterial;
  rear: THREE.MeshBasicMaterial;
  accent: THREE.MeshBasicMaterial;
  state: CarState;
  phase: Phase;
  lt: number;
  s: number;
  lane: number;
  laneNow: number;
  base: number;
  mul: number;
  impact: number;
  hop: number;
  boost: number;
  spin: number;
  /** Yaw still to unwind after a spin-out (a terminal's command failed). */
  spinOut: number;
  pos: THREE.Vector3;
  fwd: THREE.Vector3;
  up: THREE.Vector3;
  thrust: number;
  last: THREE.Vector3;
  kmh: number;
  target: { pos: THREE.Vector3; fwd: THREE.Vector3 } | null;
  rejoin: boolean;
  /** A burst of vapour is due (touchdown). */
  burst: boolean;
  /** Seconds into its drop onto the home straight after a launch, or -1. */
  drop: number;
}

export class RoadsterScene {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private bgScene = new THREE.Scene();
  private bgCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private bgMat = new THREE.MeshBasicMaterial({ toneMapped: false, depthWrite: false });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(VFOV, PW / PH, 0.1, 2000);
  /** A camera at the plate's own aspect, for turning plate pixels into world points. */
  private solver = new THREE.PerspectiveCamera(VFOV, PW / PH, 0.1, 2000);
  private textures: Record<string, THREE.Texture> = {};
  private envs: Record<string, THREE.Texture> = {};
  /** The render targets the environments live in (freeing only their texture would leave these). */
  private envTargets: Record<string, THREE.WebGLRenderTarget> = {};
  private pmrem: THREE.PMREMGenerator;
  private tod: TimeOfDay = 'night';
  private arena: ArenaKey = 'bay';
  private stageKind: CarKind = 'roadster';
  private tune: LaunchTune = DEFAULT_TUNE;
  private view: ViewName = 'home';
  private cover = { offX: 0, offY: 0, repX: 1, repY: 1 };
  private race!: THREE.CatmullRomCurve3;
  private raceLen = 0;
  private pitBays: { pos: THREE.Vector3; fwd: THREE.Vector3 }[] = [];
  private parkBays: { pos: THREE.Vector3; fwd: THREE.Vector3 }[] = [];
  private brushed = loadTiled(brushedUrl);
  private launchPath!: THREE.CatmullRomCurve3;
  private rampLen = 0;
  private chase = { pos: v3(), fwd: v3() };
  private occluders = new THREE.Group();
  private cars = new Map<string, Rig>();
  private wheelParts = new Map<CarKind, THREE.BufferGeometry[]>();
  private carMat = {
    trim: new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.5, metalness: 0.6, flatShading: true }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.85 }),
    disc: new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.3, metalness: 0.9, flatShading: true }),
    fan: new THREE.MeshStandardMaterial({ color: 0x0d0e11, roughness: 0.6, metalness: 0.5 }),
  };
  private shadowTex = radial('rgba(0,0,0,0.85)', 'rgba(0,0,0,0)');
  private streakTex = streak();
  private vapour!: THREE.Points;
  private vapourAge = new Float32Array(360).fill(99);
  private vapourVel: THREE.Vector3[] = [];
  private vapourNext = 0;
  private clock = new THREE.Clock();
  private raf = 0;
  private dead = false;
  private lastDraw = 0;
  private shot: Shot = { kind: 'wide' };
  private known: Set<string> | null = null;
  private launching: string | null = null;
  /** Race mode is on: the broadcast stops drawing. */
  paused = false;
  /** True while the broadcast is cut to a launch. */
  launchCam = false;
  private driver: string | null = null;
  private keys = new Set<Key>();
  private zoomAmt = 0;
  private stage = new THREE.Scene();
  private stageCam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  private stageCar: THREE.Group | null = null;
  private stageFor: string | null = null;
  private stageRect: { x: number; y: number; w: number; h: number } | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.preload();
    this.bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bgMat));
    this.scene.environmentIntensity = 1.1;
    this.scene.add(new THREE.HemisphereLight(0x9fb0d8, 0x0a0a0e, 0.5));
    const key = new THREE.DirectionalLight(0xfff1e0, 2.4);
    key.position.set(-6, 10, 8);
    const fill = new THREE.DirectionalLight(0xffd9b0, 1.2);
    fill.position.set(-14, 3, -10);
    this.scene.add(fill);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb8ff, 1.8);
    rim.position.set(4, 6, -20);
    this.scene.add(rim);
    this.solve();
    this.buildVapour();
    this.buildStage();
    this.scene.add(this.occluders);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.bgScene, this.bgCam));
    const main = new RenderPass(this.scene, this.camera);
    main.clear = false;
    this.composer.addPass(main);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.45, 0.4, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.setView('home', true);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ── Solving the plates ──────────────────────────────────────────────────

  private aim(cam: THREE.PerspectiveCamera, name: ViewName) {
    const d = VIEWS[name];
    cam.position.copy(d.pos);
    cam.rotation.set(THREE.MathUtils.degToRad(d.pitch), 0, 0, 'YXZ');
    cam.updateMatrixWorld();
  }

  /** The ray through a plate pixel, for a view. */
  private ray(name: ViewName, u: number, v: number): THREE.Ray {
    this.aim(this.solver, name);
    this.solver.updateProjectionMatrix();
    const r = new THREE.Raycaster();
    r.setFromCamera(new THREE.Vector2((u / PW) * 2 - 1, -((v / PH) * 2 - 1)), this.solver);
    return r.ray;
  }

  private onGround(name: ViewName, u: number, v: number): THREE.Vector3 {
    const out = v3();
    this.ray(name, u, v).intersectPlane(new THREE.Plane(v3(0, 1, 0), 0), out);
    return out;
  }

  private onDepth(name: ViewName, u: number, v: number, depth: number): THREE.Vector3 {
    const out = v3();
    this.ray(name, u, v).intersectPlane(new THREE.Plane(v3(0, 0, 1), depth), out);
    return out;
  }

  private solve() {
    // Home: the racing line, then a loop out of shot to the right and round behind the camera.
    const seen = HOME_RACE_PX.map(([u, v]) => this.onGround('home', u, v));
    // Past the bottom-right of the shot it loops round behind the camera to the start.
    const a = seen[seen.length - 1];
    const b = seen[0];
    const pts = [...seen, a.clone().add(v3(18, 0, 0)), v3(a.x + 26, 0, b.z + 30), v3(b.x, 0, b.z + 30), b.clone().add(v3(0, 0, 12))];
    this.race = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    this.race.arcLengthDivisions = 4000;
    this.raceLen = this.race.getLength();
    // Bays along the left barrier: the pit nearest the camera, the paddock beyond.
    const bays = this.bays(BAY_LINES_PX.map(([u0, v0, u1, v1]) => [this.onGround('home', u0, v0), this.onGround('home', u1, v1)] as [THREE.Vector3, THREE.Vector3]));
    this.pitBays = bays.slice(0, PIT_BAYS);
    this.parkBays = bays.slice(PIT_BAYS);
    // The gantry's posts hide cars that pass behind them.
    const hide = new THREE.MeshBasicMaterial({ colorWrite: false });
    for (const [u, v] of HOME_POSTS_PX) {
      const p = this.onGround('home', u, v);
      const post = new THREE.Mesh(new THREE.BoxGeometry(1.4, 30, 1.4), hide);
      post.position.set(p.x, 15, p.z);
      post.renderOrder = -1;
      post.userData.view = 'home';
      this.occluders.add(post);
    }
    // Launch: the ramp and the flight, on a plane at the ramp's depth.
    this.solveLaunch();
    // Chase: the car's spot, and the road's direction from its vanishing point.
    this.chase.pos = this.onGround('chase', ...CHASE_CAR_PX);
    const far = this.ray('chase', ...CHASE_VANISH_PX).direction.clone();
    far.y = 0;
    this.chase.fwd = far.normalize();
  }

  private solveLaunch() {
    const t = this.tune;
    const ramp = t.ramp.map(([u, v]) => this.onDepth('launch', u, v, t.depth));
    const flight = t.flight.map(([u, v]) => this.onDepth('launch', u, v, t.depth));
    this.launchPath = new THREE.CatmullRomCurve3([...ramp, ...flight], false, 'centripetal');
    this.launchPath.arcLengthDivisions = 2000;
    this.rampLen = new THREE.CatmullRomCurve3(ramp, false, 'centripetal').getLength() / this.launchPath.getLength();
  }

  private plateKey(name = this.view) {
    const day = this.tod === 'day' && !!PLATES[this.arena][name].day;
    return `${this.arena}/${name}/${day ? 'day' : 'night'}`;
  }

  /** A plate's texture, loading it (and its environment) on first use. */
  private plate(key: string): THREE.Texture {
    const have = this.textures[key];
    if (have) return have;
    const [arena, view, tod] = key.split('/') as [ArenaKey, ViewName, 'day' | 'night'];
    const url = PLATES[arena][view][tod] ?? PLATES[arena][view].night;
    const tex = new THREE.TextureLoader().load(url, () => {
      // Only the plate on screen gets its reflections now; the others when they're cut to.
      if (this.textures[key] && key === this.plateKey()) this.environment(key);
    });
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.textures[key] = tex;
    return tex;
  }

  /** The plate lights and reflects the cars: wrap it round them as an environment.
   *  Built on first need (it costs a frame or two), kept for the arena's stay. */
  private environment(key: string) {
    const tex = this.textures[key];
    if (!this.envs[key] && tex?.image) {
      const eq = tex.clone();
      eq.mapping = THREE.EquirectangularReflectionMapping;
      eq.repeat.set(1, 1);
      eq.offset.set(0, 0);
      eq.needsUpdate = true;
      const target = this.pmrem.fromEquirectangular(eq);
      this.envTargets[key] = target;
      this.envs[key] = target.texture;
      eq.dispose();
    }
    if (this.envs[key]) this.scene.environment = this.envs[key];
  }

  /** The arena's plates for this time of day, decoded before they're needed (no wait on a cut). */
  private preload() {
    for (const v of Object.keys(VIEWS) as ViewName[]) this.plate(this.plateKey(v));
  }

  /** Another workspace's arena: its plates (the cameras and the track stay). */
  setArena(arena: ArenaKey) {
    if (arena === this.arena || !PLATES[arena]) return;
    this.arena = arena;
    // Only one arena's plates stay on the graphics card.
    for (const key of Object.keys(this.textures)) {
      if (key.startsWith(`${arena}/`)) continue;
      this.textures[key].dispose();
      this.envTargets[key]?.dispose();
      delete this.textures[key];
      delete this.envs[key];
      delete this.envTargets[key];
    }
    this.preload();
    this.setView(this.view, true);
  }

  /** Whether this arena has golden-hour plates (else it is always night). */
  get hasDay(): boolean {
    return (Object.keys(VIEWS) as ViewName[]).every((v) => !!PLATES[this.arena][v].day);
  }

  /** Night or day: every plate swaps for its golden-hour twin. */
  setTimeOfDay(tod: TimeOfDay) {
    if (tod === this.tod) return;
    this.tod = tod;
    this.preload();
    this.setView(this.view, true);
  }

  private setView(name: ViewName, force = false) {
    if (this.view === name && !force) return;
    this.view = name;
    this.bgMat.map = this.plate(this.plateKey());
    this.bgMat.needsUpdate = true;
    this.environment(this.plateKey());
    for (const o of this.occluders.children) o.visible = o.userData.view === name;
    this.fitCover();
  }

  /** Cover the canvas with the plate (crop, never stretch) and match the camera to the crop. */
  private fitCover() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const A = w / h;
    const P = PW / PH;
    const repX = A < P ? A / P : 1;
    const repY = A < P ? 1 : P / A;
    this.cover = { repX, repY, offX: (1 - repX) / 2, offY: (1 - repY) / 2 };
    const tex = this.plate(this.plateKey());
    tex.repeat.set(repX, repY);
    tex.offset.set(this.cover.offX, this.cover.offY);
    this.camera.aspect = A;
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(VFOV / 2)) * repY));
    this.camera.updateProjectionMatrix();
    this.aim(this.camera, this.view);
  }

  /** A plate pixel on screen (CSS px). */
  plateToScreen(u: number, v: number): { x: number; y: number } {
    const { offX, offY, repX, repY } = this.cover;
    return { x: ((u / PW - offX) / repX) * this.canvas.clientWidth, y: ((v / PH - offY) / repY) * this.canvas.clientHeight };
  }

  // ── Building ────────────────────────────────────────────────────────────

  private buildVapour() {
    const n = this.vapourAge.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('size', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('alpha', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
    for (let i = 0; i < n; i++) this.vapourVel.push(v3());
    this.vapour = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { scale: { value: 900 } },
        vertexShader: 'attribute float size; attribute float alpha; varying float va; uniform float scale; void main(){ va = alpha; vec4 mv = modelViewMatrix * vec4(position,1.); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }',
        fragmentShader: 'varying float va; void main(){ float d = length(gl_PointCoord - 0.5) * 2.; float a = smoothstep(1., 0.15, d); gl_FragColor = vec4(vec3(0.92,0.94,1.0), a * va); }',
      }),
    );
    this.vapour.frustumCulled = false;
    this.scene.add(this.vapour);
  }

  private puff(at: THREE.Vector3, dir: THREE.Vector3, speed = 8) {
    const i = this.vapourNext;
    this.vapourNext = (i + 1) % this.vapourAge.length;
    this.vapourAge[i] = 0;
    (this.vapour.geometry.getAttribute('position') as THREE.BufferAttribute).setXYZ(i, at.x, at.y, at.z);
    this.vapourVel[i].copy(dir).multiplyScalar(speed * (0.7 + Math.random() * 0.6)).add(v3((Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2));
  }

  private buildStage() {
    this.stage.add(new THREE.HemisphereLight(0x8fa8ff, 0x10121a, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(4, 6, 5);
    this.stage.add(key);
    const rim = new THREE.DirectionalLight(0x58d8ff, 1.4);
    rim.position.set(-5, 3, -4);
    this.stage.add(rim);
    this.stage.add(new THREE.Mesh(new THREE.CircleGeometry(3.4, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0e1220, roughness: 0.3, metalness: 0.6 })));
    this.stage.add(new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.03, 6, 96).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: CYAN.clone().multiplyScalar(1.4), toneMapped: false })));
    this.stageCam.position.set(5.4, 2.3, 6.6);
    this.stageCam.lookAt(0, 0.55, 0);
  }

  /** An aero wheel: tyre, a dark disc with five blades, a lit ring. */
  private wheelGeos(kind: CarKind, m: CarModel): THREE.BufferGeometry[] {
    let parts = this.wheelParts.get(kind);
    if (!parts) {
      const r = m.wheelR;
      parts = [new THREE.CylinderGeometry(r, r, m.wheelW, 32).rotateX(Math.PI / 2), new THREE.CylinderGeometry(r * 0.74, r * 0.74, m.wheelW + 0.02, 5).rotateX(Math.PI / 2)];
      for (let k = 0; k < 5; k++) parts.push(new THREE.BoxGeometry(r * 1.3, 0.05, m.wheelW + 0.04).rotateZ((k * Math.PI * 2) / 5));
      parts.push(new THREE.TorusGeometry(r * 0.86, 0.006, 4, 40));
      this.wheelParts.set(kind, parts);
    }
    return parts;
  }

  /** A car's meshes (body, trim, lights, fans, wheels), given its materials. */
  private buildCar(kind: CarKind, paint: THREE.Material, accent: THREE.Material, front: THREE.Material, rear: THREE.Material) {
    const m = carModel(kind);
    const body = new THREE.Group();
    body.add(new THREE.Mesh(m.body, paint));
    for (const t of m.trim) body.add(new THREE.Mesh(t, this.carMat.trim));
    if (m.front) {
      const [x, y, w, h] = m.front;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.04, h, w), front);
      bar.position.set(x, y, 0);
      body.add(bar);
    }
    const [rx, ry, rw, rh] = m.rear;
    const rbar = new THREE.Mesh(new THREE.BoxGeometry(0.04, rh, rw), rear);
    rbar.position.set(rx, ry, 0);
    body.add(rbar);
    for (const [y, z] of m.fans) {
      const fan = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.02, 20).rotateZ(Math.PI / 2), this.carMat.fan);
      fan.position.set(m.fanX + 0.04, y, z);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.01, 6, 24).rotateY(Math.PI / 2), this.carMat.disc);
      ring.position.set(m.fanX + 0.03, y, z);
      body.add(fan, ring);
    }
    if (kind === 'rosso') {
      // Twin round tail lamps each side, lit like any car's tail.
      for (const [y, z] of ROSSO_LAMPS) {
        const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.03, 20).rotateZ(Math.PI / 2), rear);
        lamp.position.set(-2.335, y, z);
        body.add(lamp);
      }
      // The amber dot-matrix strip in each side intake: lit by the car's state, like the rims.
      for (const side of [1, -1]) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.05, 0.012), accent);
        strip.position.set(-1.05, 0.36, side * 1.0);
        body.add(strip);
      }
    }
    for (const [x, y, z] of m.nozzles) {
      const n = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.14, 12), this.carMat.disc);
      n.position.set(x, y - 0.06, z);
      body.add(n);
    }
    const wheels: THREE.Object3D[] = [];
    const [tyre, disc, ...rest] = this.wheelGeos(kind, m);
    const ringGeo = rest[rest.length - 1];
    const blades = rest.slice(0, -1);
    for (const [x, z] of m.wheels) {
      const w = new THREE.Group();
      w.add(new THREE.Mesh(tyre, this.carMat.tyre), new THREE.Mesh(disc, this.carMat.disc));
      for (const b of blades) w.add(new THREE.Mesh(b, this.carMat.disc));
      const ring = new THREE.Mesh(ringGeo, accent);
      ring.position.z = Math.sign(z) * (m.wheelW / 2 + 0.02);
      w.add(ring);
      w.position.set(x, m.wheelR, z);
      wheels.push(w);
    }
    return { m, body, wheels };
  }

  private makeCar(id: string, kind: CarKind): Rig {
    // Silver brushed metal for the agents; deep glossy red for the terminals' GT.
    const paint =
      kind === 'rosso'
        ? new THREE.MeshPhysicalMaterial({ color: ROSSO, vertexColors: true, metalness: 0.35, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08, flatShading: true, envMapIntensity: 1.5 })
        : new THREE.MeshPhysicalMaterial({ color: 0xd8dce3, map: this.brushed, roughnessMap: this.brushed, vertexColors: true, metalness: 0.85, roughness: 0.55, clearcoat: 0.6, clearcoatRoughness: 0.2, flatShading: true, envMapIntensity: 1.7 });
    const accent = new THREE.MeshBasicMaterial({ color: kind === 'rosso' ? AMBER : CYAN, toneMapped: false });
    const front = new THREE.MeshBasicMaterial({ color: 0xf2f6ff, toneMapped: false });
    const rear = new THREE.MeshBasicMaterial({ color: 0xff2a3c, toneMapped: false });
    const { m, body, wheels } = this.buildCar(kind, paint, accent, front, rear);
    // Thruster flames: a hot core and a softer plume at each nozzle, pointing down out of the car.
    const jets: THREE.Mesh[] = [];
    const nozzles: [number, number, number][] = m.nozzles.length ? m.nozzles : [[m.rear[0] + 0.1, 0.3, 0.6], [m.rear[0] + 0.1, 0.3, -0.6]];
    for (const [x, y, z] of nozzles) {
      const jet = new THREE.Group() as unknown as THREE.Mesh;
      for (const [r, len, colour, op] of [[0.11, 1.8, 0xffffff, 1], [0.28, 2.8, 0x9fd0ff, 0.5]] as const) {
        const g = new THREE.ConeGeometry(r, len, 12, 1, true).rotateX(Math.PI).translate(0, -len / 2, 0);
        jet.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide })));
      }
      jet.position.set(x, y - 0.1, z);
      jet.scale.setScalar(0.001);
      body.add(jet);
      jets.push(jet);
    }
    const group = new THREE.Group();
    group.add(body, ...wheels);
    // Its reflection in the wet road: the same car mirrored under the surface, faint.
    const ghost = (mat: THREE.Material) => {
      const c = mat.clone();
      c.transparent = true;
      c.opacity = 0.13;
      c.side = THREE.DoubleSide;
      c.depthWrite = false;
      return c;
    };
    const copy = this.buildCar(kind, ghost(paint), ghost(accent), ghost(front), ghost(rear));
    const mirror = new THREE.Group();
    mirror.add(copy.body, ...copy.wheels);
    mirror.matrixAutoUpdate = false;
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(m.length * 1.15, 2.6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: this.shadowTex, transparent: true, depthWrite: false }));
    // Its lights, streaking down the wet tarmac.
    const streaks: THREE.Sprite[] = [];
    for (let i = 0; i < 4; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.streakTex, color: i < 2 ? 0xff2a3c : 0xf2f6ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      sp.center.set(0.5, 1);
      streaks.push(sp);
    }
    this.scene.add(shadow, mirror, group, ...streaks);
    group.traverse((o) => (o.userData.carId = id));
    const lane = LANES[hash(id) > 0.5 ? 1 : 0];
    const pace = kind === 'formula' ? 1.1 : kind === 'gt' ? 0.94 : kind === 'rosso' ? 1.04 : 1.0;
    return {
      id, kind, model: m, group, body, wheels, mirror, shadow, streaks, jets, paint, front, rear, accent,
      state: 'working', phase: 'race', lt: 0, s: hash(`${id}s`) * this.raceLen, lane, laneNow: lane,
      base: 15 * pace * (0.92 + hash(`${id}v`) * 0.16), mul: 1, impact: -1, hop: -1, boost: -1, spin: 0, spinOut: 0,
      pos: v3(), fwd: v3(1, 0, 0), up: v3(0, 1, 0), thrust: 0, last: v3(), kmh: 0, target: null, rejoin: false, burst: false, drop: -1,
    };
  }

  // ── Cars and their states ───────────────────────────────────────────────

  /** Frees what a car built for itself (light bars, lamps, jets, its shadow and,
   *  with `materials`, its own paint and lights); shared shapes and finishes stay. */
  private free(root: THREE.Object3D, kind: CarKind, materials: boolean) {
    const m = carModel(kind);
    const shared = new Set<THREE.BufferGeometry>([m.body, ...m.trim, ...this.wheelGeos(kind, m)]);
    const sharedMats = new Set<THREE.Material>(Object.values(this.carMat));
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const sprite = (o as THREE.Sprite).isSprite;
      if (!mesh.isMesh && !sprite) return;
      // A sprite's quad is three's own, shared by every sprite.
      if (mesh.isMesh && !shared.has(mesh.geometry)) mesh.geometry.dispose();
      if (materials) for (const mat of [mesh.material].flat()) if (!sharedMats.has(mat)) mat.dispose();
    });
  }

  /** A car leaves the scene for good: out of it and off the graphics card. */
  private retire(rig: Rig) {
    if (this.stageFor === rig.id) this.setStage(this.stageRect, null);
    this.scene.remove(rig.group, rig.mirror, rig.shadow, ...rig.streaks);
    for (const o of [rig.group, rig.mirror, rig.shadow, ...rig.streaks]) this.free(o, rig.kind, true);
  }

  /** Another arena: its cars appear where they are (no launches), as on first sight. */
  resetCars() {
    for (const rig of this.cars.values()) this.retire(rig);
    this.cars.clear();
    this.known = null;
    this.launching = null;
  }

  setCars(list: CarSpec[]) {
    if (this.known === null && list.length === 0) return;
    const first = this.known === null;
    const ids = new Set(list.map((c) => c.id));
    for (const c of list) {
      let rig = this.cars.get(c.id);
      if (!rig) {
        rig = this.makeCar(c.id, c.kind ?? KIND_OF[c.engine] ?? 'roadster');
        this.cars.set(c.id, rig);
        rig.state = c.state;
        if (first || (c.state !== 'working' && c.state !== 'forming')) {
          rig.phase = c.state === 'working' ? 'race' : 'drive';
        } else if (rig.kind === 'roadster') {
          // A new Claude Code thread: the launch.
          rig.phase = c.state === 'forming' ? 'grid' : 'launch';
          rig.lt = -CUT_T;
          if (rig.phase === 'launch') this.launching = rig.id;
        } else {
          // The others roll into the race past the camera.
          rig.phase = c.state === 'forming' ? 'grid' : 'race';
          rig.s = 0;
        }
      } else if (rig.state !== c.state) this.restate(rig, c.state);
    }
    for (const [id, rig] of this.cars)
      if (!ids.has(id)) {
        this.retire(rig);
        this.cars.delete(id);
      }
    this.known = ids;
    this.assignSpots(first);
  }

  private restate(rig: Rig, state: CarState) {
    // A terminal whose command failed spins off before it limps to its bay.
    if (rig.kind === 'rosso' && state === 'failed' && rig.state === 'working' && rig.phase === 'race') rig.spinOut = Math.PI * 2.6;
    rig.state = state;
    if (rig.phase === 'launch') return;
    if (state === 'working') {
      if (rig.phase === 'grid' && rig.kind === 'roadster') {
        rig.phase = 'launch';
        rig.lt = -CUT_T;
        this.launching = rig.id;
      } else if (rig.phase !== 'race') {
        // Out of the pit: back onto the racing line just ahead.
        const s = (this.nearestS(rig.pos) + 6) % this.raceLen;
        rig.rejoin = true;
        rig.phase = 'drive';
        rig.target = { pos: this.race.getPointAt(s / this.raceLen), fwd: this.race.getTangentAt(s / this.raceLen).setY(0).normalize() };
        rig.s = s;
      }
    } else if (state !== 'forming') {
      rig.phase = 'drive';
      rig.rejoin = false;
    }
  }

  private assignSpots(snap = false) {
    let pit = 0;
    let park = 0;
    // Past the last bay, more cars go on in the same row.
    const bay = (list: { pos: THREE.Vector3; fwd: THREE.Vector3 }[], i: number) => {
      const last = list[list.length - 1];
      if (i < list.length) return list[i];
      const along = list[list.length - 1].pos.clone().sub(list[list.length - 2].pos);
      return { pos: last.pos.clone().add(along.multiplyScalar(i - list.length + 1)), fwd: last.fwd.clone() };
    };
    for (const rig of this.cars.values()) {
      if (rig.rejoin) continue;
      let at: { pos: THREE.Vector3; fwd: THREE.Vector3 } | null = null;
      if (rig.state === 'needsYou' || rig.state === 'forming') at = bay(this.pitBays, pit++);
      else if (rig.state === 'landed' || rig.state === 'failed' || rig.state === 'stopped') at = bay(this.parkBays, park++);
      if (at) {
        rig.target = { pos: at.pos.clone(), fwd: at.fwd.clone() };
        if (snap || rig.phase === 'grid') {
          rig.pos.copy(at.pos);
          rig.fwd.copy(at.fwd);
        }
      } else if (rig.phase !== 'drive') rig.target = null;
    }
  }

  private nearestS(p: THREE.Vector3): number {
    let best = 0;
    let d = Infinity;
    for (let i = 0; i < 400; i++) {
      const e = this.race.getPointAt(i / 400).distanceToSquared(p);
      if (e < d) {
        d = e;
        best = i;
      }
    }
    return (best / 400) * this.raceLen;
  }

  /** Bays between consecutive painted lines (each a [left, right] pair on the ground): nose toward the track. */
  private bays(lines: [THREE.Vector3, THREE.Vector3][]) {
    const out: { pos: THREE.Vector3; fwd: THREE.Vector3 }[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const [a0, a1] = lines[i];
      const [b0, b1] = lines[i + 1];
      // Centre of the bay, a car's length in from the kerb end.
      const kerb = a1.clone().add(b1).multiplyScalar(0.5);
      const back = a0.clone().add(b0).multiplyScalar(0.5);
      const fwd = kerb.clone().sub(back).setY(0).normalize();
      out.push({ pos: kerb.clone().sub(fwd.clone().multiplyScalar(3.4)).setY(0), fwd });
    }
    return out;
  }

  /** Out of the home shot: cars hurry through there. */
  private offstage(p: THREE.Vector3): boolean {
    this.aim(this.solver, 'home');
    this.solver.updateProjectionMatrix();
    const q = p.clone().project(this.solver);
    // Also hidden once it's round the bend behind the gantry's right post.
    const u = ((q.x + 1) / 2) * PW;
    const v = ((1 - q.y) / 2) * PH;
    return q.z > 1 || Math.abs(q.x) > 1.08 || q.y < -1.15 || q.y > 1.08 || (u > 1290 && v < 660);
  }

  private step(rig: Rig, dt: number) {
    rig.thrust = 0;
    if (rig.phase === 'launch') {
      // Out of the cutscene the car is already on its way up the ramp: pick up there.
      const pickUp = this.tune.rampT * 0.55;
      if (rig.lt < 0 && rig.lt + dt >= 0) rig.lt = pickUp;
      else rig.lt += dt;
      if (rig.lt >= this.tune.rampT + this.tune.flightT) {
        // Down and racing: it comes past the camera on the home straight.
        rig.phase = rig.state === 'working' ? 'race' : 'drive';
        // It comes down onto the straight, mid-shot.
        rig.s = this.nearestS(this.race.getPointAt(0.04));
        rig.drop = 0;
        if (rig.phase === 'drive') rig.pos.copy(this.race.getPointAt(0.04));
        if (this.launching === rig.id) this.launching = null;
        this.assignSpots();
      }
      return;
    }
    if (rig.phase === 'race') {
      const driving = this.driver === rig.id;
      const want = driving ? (this.keys.has('up') ? 1.9 : this.keys.has('down') ? 0.2 : 0.5) : 1;
      rig.mul += (want - rig.mul) * Math.min(1, dt * (driving ? 2.2 : 0.8));
      const boost = rig.boost >= 0 ? 1 + 1.4 * Math.sin(Math.PI * Math.min(1, rig.boost / BOOST_T)) : 1;
      const warp = this.offstage(rig.pos) ? 3.5 : 1;
      // Keep a car's length behind whoever is ahead in the same lane.
      let gap = 1;
      for (const o of this.cars.values()) {
        if (o === rig || o.phase !== 'race' || Math.sign(o.lane) !== Math.sign(rig.lane)) continue;
        const ahead = (((o.s - rig.s) % this.raceLen) + this.raceLen) % this.raceLen;
        if (ahead > 0 && ahead < 9) gap = Math.min(gap, Math.max(0, (ahead - 6) / 3));
      }
      rig.s = (rig.s + rig.base * rig.mul * boost * warp * dt * Math.max(gap, driving ? 1 : 0.3)) % this.raceLen;
      rig.laneNow += (rig.lane - rig.laneNow) * Math.min(1, dt * 3.5);
      const u = rig.s / this.raceLen;
      const fwd = this.race.getTangentAt(u).setY(0).normalize();
      const right = fwd.clone().cross(v3(0, 1, 0)).normalize();
      const pos = this.race.getPointAt(u).add(right.multiplyScalar(rig.laneNow));
      const up = v3(0, 1, 0);
      fwd.applyAxisAngle(up, -(rig.lane - rig.laneNow) * 0.1);
      if (rig.hop >= 0) {
        // The roadster's trick: up on the thrusters, a full roll, back down.
        rig.hop += dt;
        const k = rig.hop / HOP_T;
        pos.y += 4 * 2.8 * k * (1 - k);
        up.applyAxisAngle(fwd, Math.PI * 2 * smoother((k - 0.08) / 0.8));
        const s = (k - 0.08) / 0.8;
        rig.thrust = s > 0 && s < 1 ? Math.min(1, (30 * s * s * (1 - s) * (1 - s)) / 1.2) : 0;
        if (rig.hop >= HOP_T) {
          rig.hop = -1;
          rig.impact = 0;
        }
      }
      if (rig.drop >= 0) {
        // Arriving from the launch: it falls the last few metres, level, and lands.
        rig.drop += dt;
        const k = Math.min(1, rig.drop / DROP_T);
        pos.y += 9 * (1 - k) * (1 - k);
        if (rig.drop >= DROP_T) {
          rig.drop = -1;
          rig.impact = 0;
          rig.burst = true;
        }
      }
      if (rig.boost >= 0) {
        rig.boost += dt;
        rig.thrust = Math.max(rig.thrust, 0.7 * Math.sin(Math.PI * Math.min(1, rig.boost / BOOST_T)));
        if (rig.boost >= BOOST_T) rig.boost = -1;
      }
      rig.pos.copy(pos);
      rig.fwd.copy(fwd);
      rig.up.copy(up);
      return;
    }
    if (rig.phase === 'grid') return;
    const target = rig.target;
    if (!target) return;
    const to = target.pos.clone().sub(rig.pos);
    const dist = to.length();
    if (this.offstage(rig.pos) || dist > 60) {
      rig.pos.copy(target.pos);
      rig.fwd.copy(target.fwd);
    } else {
      const v = Math.min(14, 1.5 + dist * 1.6);
      if (dist > 0.01) rig.pos.add(to.clone().normalize().multiplyScalar(Math.min(dist, v * dt)));
      const heading = dist > 2.5 ? to.clone().setY(0).normalize() : target.fwd;
      rig.fwd.lerp(heading, Math.min(1, dt * (dist > 2.5 ? 4 : 2.5))).normalize();
    }
    rig.up.lerp(v3(0, 1, 0), Math.min(1, dt * 4)).normalize();
    if (rig.rejoin && dist < 0.5) {
      rig.rejoin = false;
      rig.target = null;
      rig.phase = 'race';
      rig.laneNow = rig.lane;
      this.assignSpots();
    }
  }

  /** The launching car's pose, on the launch plate. */
  private launchPose(rig: Rig) {
    const T = rig.lt;
    const { rampT: ramp, flightT: flight, rolls, rollFrom, rollTo } = this.tune;
    // Along the ramp with growing speed, then the flight at an even pace, then landed.
    const k = T < ramp ? this.rampLen * (T / ramp) ** 1.6 : this.rampLen + (1 - this.rampLen) * Math.min(1, (T - ramp) / flight);
    const at = Math.min(0.999, Math.max(0, k));
    const pos = this.launchPath.getPointAt(at);
    let fwd = this.launchPath.getTangentAt(at).normalize();
    // Wheels on the ramp: up points into the curve's hollow (up and to the left).
    let up = v3(-fwd.y, fwd.x, 0).normalize();
    if (T >= ramp) {
      const f = Math.min(1, (T - ramp) / flight);
      // One full roll on the thrusters, then level for the drop.
      const span = Math.max(0.05, rollTo - rollFrom);
      up = up.applyAxisAngle(fwd, Math.PI * 2 * rolls * smoother((f - rollFrom) / span));
      const s = (f - rollFrom) / span;
      rig.thrust = s > 0 && s < 1 ? Math.min(1, (30 * s * s * (1 - s) * (1 - s)) / 1.2) : 0;
      // Coming in to land: the thrusters level it and turn it along the ground.
      const settle = smoother((f - Math.min(0.95, rollTo + 0.02)) / Math.max(0.05, 1 - rollTo - 0.02));
      up = up.lerp(v3(0, 1, 0), settle).normalize();
    }
    return { pos, fwd, up, fans: T < ramp };
  }

  // ── The UI's handles ────────────────────────────────────────────────────

  setMood(_m: Mood) {}

  setStatus(_text: string) {}

  setShot(s: Shot) {
    this.shot = s;
  }

  setPointer(_nx: number, _ny: number) {}

  setInsets(_r: number, _t: number, _b: number) {}

  control(id: string | null) {
    if (id === this.driver) return;
    this.driver = id;
    this.keys.clear();
  }

  get driving(): string | null {
    return this.driver;
  }

  get currentView(): ViewName {
    return this.view;
  }

  press(key: Key, down: boolean): boolean {
    const rig = this.driver ? this.cars.get(this.driver) : undefined;
    if (!rig || rig.phase !== 'race') return false;
    if (!down) {
      this.keys.delete(key);
      return true;
    }
    if (this.keys.has(key)) return true;
    this.keys.add(key);
    if (key === 'left') rig.lane = LANES[0];
    if (key === 'right') rig.lane = LANES[1];
    if (key === 'action') {
      if (rig.kind === 'roadster') {
        if (rig.hop < 0) rig.hop = 0;
      } else if (rig.boost < 0) rig.boost = 0;
    }
    return true;
  }

  /** Scroll over the car in your hands: far enough and the broadcast cuts to the chase camera on it. */
  zoom(deltaY: number) {
    if (!this.driver) return;
    this.zoomAmt = THREE.MathUtils.clamp(this.zoomAmt - deltaY * 0.004, 0, 1);
  }

  setStage(rect: { x: number; y: number; w: number; h: number } | null, id: string | null) {
    this.stageRect = rect;
    if (id === this.stageFor) return;
    this.stageFor = id;
    if (this.stageCar) {
      this.stage.remove(this.stageCar);
      // Its meshes are its own; its paint and lights are the car's.
      this.free(this.stageCar, this.stageKind, false);
    }
    this.stageCar = null;
    const rig = id ? this.cars.get(id) : undefined;
    if (!rig) return;
    const { body, wheels } = this.buildCar(rig.kind, rig.paint, rig.accent, rig.front, rig.rear);
    const g = new THREE.Group();
    g.add(body, ...wheels);
    this.stageCar = g;
    this.stageKind = rig.kind;
    this.stage.add(g);
  }

  private toScreen(p: THREE.Vector3): { x: number; y: number } | null {
    const q = p.clone().project(this.camera);
    if (q.z > 1 || q.z < -1 || Math.abs(q.x) > 1.2 || Math.abs(q.y) > 1.2) return null;
    return { x: (q.x * 0.5 + 0.5) * this.canvas.clientWidth, y: (-q.y * 0.5 + 0.5) * this.canvas.clientHeight };
  }

  /** A car on screen (CSS px), `lift` metres above the road; null when it isn't in this shot. */
  project(id: string, lift = 1.6): { x: number; y: number } | null {
    const rig = this.cars.get(id);
    if (!rig || !rig.group.visible) return null;
    return this.toScreen(rig.group.position.clone().add(v3(0, lift, 0)));
  }

  /** Launch Control's sign on screen, in the shots that have it. */
  projectSign(): { x: number; y: number; w: number; h: number } | null {
    const r = this.view === 'home' ? SIGN_PX.home : this.view === 'chase' ? SIGN_PX.chase : null;
    if (!r) return null;
    const a = this.plateToScreen(r[0], r[1]);
    const b = this.plateToScreen(r[2], r[3]);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, w: b.x - a.x, h: b.y - a.y };
  }

  pick(clientX: number, clientY: number, reach = 40): string | null {
    const r = this.canvas.getBoundingClientRect();
    let best: string | null = null;
    let bestD = reach;
    for (const id of this.cars.keys()) {
      const p = this.project(id, 0.6);
      if (!p) continue;
      const d = Math.hypot(p.x + r.left - clientX, p.y + r.top - clientY);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  /** The car whose launch cutscene is playing (the live launch waits for it), or null. */
  get cutscene(): string | null {
    const rig = this.launching ? this.cars.get(this.launching) : undefined;
    return rig && rig.phase === 'launch' && rig.lt < 0 ? rig.id : null;
  }

  /** End the cutscene now: the live launch starts. */
  skipCut() {
    const rig = this.launching ? this.cars.get(this.launching) : undefined;
    if (rig && rig.lt < 0) rig.lt = this.tune.rampT * 0.55;
  }

  ids(): string[] {
    return [...this.cars.keys()];
  }

  debug(id: string): CarDebug | null {
    const rig = this.cars.get(id);
    if (!rig) return null;
    const near = this.race.getPointAt(this.nearestS(rig.pos) / this.raceLen);
    return {
      kind: rig.kind,
      phase: rig.phase,
      state: rig.state,
      pos: [rig.pos.x, rig.pos.y, rig.pos.z],
      up: [rig.up.x, rig.up.y, rig.up.z],
      offTrack: Math.max(0, near.distanceTo(v3(rig.pos.x, 0, rig.pos.z)) - Math.abs(rig.laneNow)),
      launchT: rig.lt,
      lane: rig.laneNow,
      speed: rig.kmh,
      hopping: rig.hop >= 0,
      view: this.view,
      spinOut: rig.spinOut,
    };
  }

  /** For tests: where the scene is and what it holds on the graphics card. */
  inspect() {
    const key = this.plateKey();
    const tex = this.textures[key];
    return {
      arena: this.arena,
      view: this.view,
      plate: key,
      plateLoaded: !!tex?.image && (tex.image as HTMLImageElement).complete !== false,
      plates: Object.keys(this.textures).length,
      gpuTextures: this.renderer.info.memory.textures,
      gpuGeometries: this.renderer.info.memory.geometries,
    };
  }

  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.fitCover();
  }

  // ── Every frame ─────────────────────────────────────────────────────────

  private frame = () => {
    if (this.dead) return;
    this.raf = requestAnimationFrame(this.frame);
    if (this.paused) return;
    const nowMs = performance.now();
    if (document.documentElement.classList.contains('still') && nowMs - this.lastDraw < 250) return;
    this.lastDraw = nowMs;
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.getElapsedTime();

    for (const rig of this.cars.values()) this.step(rig, dt);

    // Which camera the broadcast is on.
    if (!this.driver) this.zoomAmt = Math.max(0, this.zoomAmt - dt * 0.6);
    const onboard = this.shot.kind === 'onboard' ? this.cars.get(this.shot.id) : undefined;
    const held = this.driver && this.zoomAmt > 0.5 ? this.cars.get(this.driver) : undefined;
    const launching = this.launching ? this.cars.get(this.launching) : undefined;
    let view: ViewName = 'home';
    let focus: Rig | undefined;
    if (launching && launching.phase === 'launch' && launching.lt >= 0 && (this.shot.kind !== 'onboard' || onboard === launching)) {
      view = 'launch';
      focus = launching;
    } else if (this.shot.kind === 'pit') {
      view = 'pit';
    } else if (this.shot.kind === 'paddock') {
      // The paddock: the lineup under the arch, as a backdrop for the list.
      view = 'launch';
    } else if (onboard && onboard.phase === 'race') {
      view = 'chase';
      focus = onboard;
    } else if (held && held.phase === 'race') {
      view = 'chase';
      focus = held;
    }
    this.launchCam = view === 'launch';
    this.setView(view);

    const basis = new THREE.Matrix4();
    const flip = new THREE.Matrix4().makeScale(1, -1, 1);
    for (const rig of this.cars.values()) {
      // Each shot shows the cars that are in it.
      let pos = rig.pos;
      let fwd = rig.fwd;
      let up = rig.up;
      let shown = view === 'home' ? rig.phase !== 'launch' : rig === focus;
      let ground = view !== 'launch';
      let fans = false;
      if (view === 'launch' && rig === focus) {
        const p = this.launchPose(rig);
        pos = p.pos;
        fwd = p.fwd;
        up = p.up;
        fans = p.fans;
        ground = false;
      } else if (view === 'chase' && rig === focus) {
        // Riding with it: the car holds its spot under the lights.
        pos = this.chase.pos.clone();
        fwd = this.chase.fwd.clone();
        up = v3(0, 1, 0);
        if (rig.hop >= 0) {
          const k = rig.hop / HOP_T;
          pos.y += 4 * 1.2 * k * (1 - k);
          up.applyAxisAngle(fwd, Math.PI * 2 * smoother((k - 0.08) / 0.8));
        }
        pos.y += Math.sin(t * 23) * 0.006;
      } else if (view === 'home' && rig.phase === 'race' && this.offstage(pos)) shown = false;
      rig.group.visible = shown;
      rig.mirror.visible = shown && ground && pos.y < 1.5 && rig.phase === 'race';
      rig.shadow.visible = shown && ground;
      for (const sp of rig.streaks) sp.visible = shown && ground;
      if (!shown) {
        rig.last.copy(pos);
        continue;
      }
      // A spin-out turns the body about its up axis while it slides on.
      const face = rig.spinOut > 0.01 ? fwd.clone().applyAxisAngle(up, rig.spinOut) : fwd;
      if (rig.spinOut > 0.01) rig.spinOut *= Math.exp(-dt * 2.2);
      const right = face.clone().cross(up).normalize();
      const upO = right.clone().cross(face).normalize();
      basis.makeBasis(face, upO, right);
      rig.group.quaternion.setFromRotationMatrix(basis);
      rig.group.position.copy(pos);
      rig.group.updateMatrixWorld();
      rig.mirror.matrix.copy(flip).multiply(rig.group.matrixWorld);
      rig.mirror.matrixWorldNeedsUpdate = true;
      rig.shadow.position.set(pos.x, 0.02, pos.z);
      rig.shadow.rotation.y = Math.atan2(-fwd.z, fwd.x);
      (rig.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - pos.y / 3);
      // Speed, wheels turning with it, the suspension taking a landing.
      const moved = view === 'chase' && rig === focus ? rig.base * rig.mul * dt : pos.distanceTo(rig.last);
      rig.last.copy(pos);
      rig.kmh += ((dt > 0 ? (moved / dt) * 3.6 : 0) - rig.kmh) * Math.min(1, dt * 6);
      rig.spin += moved / rig.model.wheelR;
      for (const w of rig.wheels) w.rotation.z = -rig.spin;
      if (rig.impact >= 0) {
        rig.impact += dt;
        rig.body.position.y = -0.18 * Math.exp(-rig.impact * 7) * Math.cos(rig.impact * 19);
        if (rig.impact > 1.2) {
          rig.impact = -1;
          rig.body.position.y = 0;
        }
      }
      // Livery by state.
      const parked = rig.state === 'landed' || rig.state === 'stopped' || rig.state === 'failed';
      const pit = rig.state === 'needsYou';
      const hazard = pit && Math.sin(t * 7) > 0;
      const yours = this.driver === rig.id;
      const red = rig.kind === 'rosso';
      rig.paint.color.set(red ? (parked ? 0x8c1118 : ROSSO) : parked ? 0x6a6f78 : 0xd8dce3);
      rig.accent.color.copy(pit ? AMBER : parked ? new THREE.Color(rig.state === 'failed' ? 0xff4a3a : 0x30343c) : red ? AMBER : CYAN).multiplyScalar(pit ? (hazard ? 1.6 : 0.2) : parked ? 0.4 : yours || fans ? 1.6 : 0.55);
      rig.front.color.set(hazard ? 0xffa62b : parked ? 0x2c303a : 0xdfe6f2).multiplyScalar(parked ? 1 : 0.9);
      rig.rear.color.set(hazard ? 0xffa62b : parked ? 0x3a1018 : 0xff2a3c).multiplyScalar(parked ? 1 : 2);
      // Light streaks on the wet road under the tail and nose lights.
      const m = rig.model;
      const fx = m.front ? m.front[0] : 0;
      const lights = [v3(m.rear[0], 0, m.rear[2] * 0.42), v3(m.rear[0], 0, -m.rear[2] * 0.42), v3(fx, 0, 0.6), v3(fx, 0, -0.6)];
      rig.streaks.forEach((sp, i) => {
        const at = lights[i].clone().applyQuaternion(rig.group.quaternion).add(pos);
        sp.position.set(at.x, 0.03, at.z);
        const dist = this.camera.position.distanceTo(at);
        sp.scale.set(0.5 + dist * 0.01, 1.6 + dist * 0.05, 1);
        const mat = sp.material as THREE.SpriteMaterial;
        mat.opacity = parked || (i >= 2 && !m.front) ? 0 : i < 2 ? (hazard ? 0.2 : 0.55) : 0.35;
        mat.color.set(hazard ? 0xffa62b : i < 2 ? 0xff2a3c : 0xf2f6ff);
      });
      // Thruster flames, flickering with the thrust.
      for (const j of rig.jets) {
        const k = rig.thrust > 0.05 ? rig.thrust * (0.85 + Math.random() * 0.3) : 0.001;
        j.scale.set(k, k * (1.2 + Math.random() * 0.4), k);
      }
      // Cold gas: vapour from the corner nozzles while the thrusters fire.
      if (rig.thrust > 0.05) {
        const jets: [number, number, number][] = m.nozzles.length ? m.nozzles : [[m.rear[0], 0.3, 0.7], [m.rear[0], 0.3, -0.7]];
        for (const [x, y, z] of jets)
          if (Math.random() < rig.thrust * 0.7) this.puff(v3(x, y, z).applyQuaternion(rig.group.quaternion).add(pos), upO.clone().negate(), 10);
      }
      if (rig.burst) {
        rig.burst = false;
        for (let q = 0; q < 40; q++) {
          const a = Math.random() * Math.PI * 2;
          this.puff(pos.clone().add(v3(Math.cos(a) * 1.4, -0.4, Math.sin(a) * 1.0)), v3(Math.cos(a), 0.15 + Math.random() * 0.3, Math.sin(a)), 7);
        }
      }
      if (fans && Math.random() < 0.4) this.puff(pos.clone().sub(upO.clone().multiplyScalar(0.5)), upO.clone().negate(), 3);
    }

    // Vapour drifts, grows and fades.
    const pa = this.vapour.geometry.getAttribute('position') as THREE.BufferAttribute;
    const sa = this.vapour.geometry.getAttribute('size') as THREE.BufferAttribute;
    const aa = this.vapour.geometry.getAttribute('alpha') as THREE.BufferAttribute;
    for (let i = 0; i < this.vapourAge.length; i++) {
      const age = (this.vapourAge[i] += dt);
      if (age > 1.4) {
        aa.setX(i, 0);
        continue;
      }
      const v = this.vapourVel[i].multiplyScalar(1 - dt * 2.6);
      pa.setXYZ(i, pa.getX(i) + v.x * dt, pa.getY(i) + v.y * dt + dt * 0.4, pa.getZ(i) + v.z * dt);
      sa.setX(i, 0.35 + age * 2.4);
      aa.setX(i, (1 - age / 1.4) * 0.24);
    }
    pa.needsUpdate = sa.needsUpdate = aa.needsUpdate = true;

    this.composer.render(dt);

    // The card's stage: the car in your hands, turning, drawn into the card's spot.
    if (this.stageRect && this.stageCar) {
      const { x, y, w, h } = this.stageRect;
      const H = this.canvas.clientHeight;
      this.stageCar.rotation.y = t * 0.6;
      this.stageCam.aspect = w / h;
      this.stageCam.updateProjectionMatrix();
      const r = this.renderer;
      r.autoClear = false;
      r.setScissorTest(true);
      r.setViewport(x, H - y - h, w, h);
      r.setScissor(x, H - y - h, w, h);
      r.setClearColor(0x090c16, 1);
      r.clear(true, true, false);
      r.render(this.stage, this.stageCam);
      r.setScissorTest(false);
      r.setViewport(0, 0, this.canvas.clientWidth, H);
      r.autoClear = true;
    }
  };

  dispose() {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    for (const t of Object.values(this.textures)) t.dispose();
    for (const t of Object.values(this.envTargets)) t.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
  }
}

function radial(inner: string, outer: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, inner);
  r.addColorStop(1, outer);
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** A soft vertical streak: a light's reflection running down wet tarmac. */
function streak(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 256;
  const g = c.getContext('2d')!;
  const v = g.createLinearGradient(0, 0, 0, 256);
  v.addColorStop(0, 'rgba(255,255,255,0.9)');
  v.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  v.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = v;
  g.fillRect(0, 0, 32, 256);
  g.globalCompositeOperation = 'destination-in';
  const h = g.createLinearGradient(0, 0, 32, 0);
  h.addColorStop(0, 'rgba(0,0,0,0)');
  h.addColorStop(0.5, 'rgba(0,0,0,1)');
  h.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = h;
  g.fillRect(0, 0, 32, 256);
  return new THREE.CanvasTexture(c);
}

function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function loadTiled(url: string): THREE.Texture {
  const t = new THREE.TextureLoader().load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
