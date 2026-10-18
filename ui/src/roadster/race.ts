// Race mode's world: a real 3D circuit on piers in San Francisco Bay that you
// drive. The broadcast home view is photographs; this one you can move through.
//
// You drive one agent's car (arcade handling: throttle, brake, steer, a little
// drift, thrusters for a hop and a burst of speed). The other agents' cars lap
// on their own. Laps, sector splits and your best lap are timed. Driving never
// touches the work: the agent behind your car keeps going in its own session.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import { type CarKind, carModel } from './car';
import brushedUrl from './plates/brushed.jpg';
import panoDayUrl from './plates/pano-day.jpg';
import panoUrl from './plates/pano.jpg';

const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const CYAN = new THREE.Color(0x58d8ff);

/** Road half-width, metres. */
const HALF = 7;
const SAMPLES = 1600;
const MAX_SPEED = 72;
const BOOST_SPEED = 96;
const CELLS = 4;
const CELL_REFILL = 6;
const COUNTDOWN = 4;
const BEST_KEY = 'roadster-best-lap';
/** Where your car stops when its agent needs you: the main straight, before the line, right side. */
const PIT_IDX = SAMPLES - 70;
const PIT_LANE = HALF - 2.4;
const GRAVITY = 22;

export interface Rival {
  id: string;
  kind: CarKind;
  label: string;
}

export interface RaceKeys {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

/** What the HUD reads every frame. */
export interface RaceStatus {
  phase: 'countdown' | 'race';
  lights: number;
  lap: number;
  lapTime: number;
  best: number | null;
  /** Gap to your best at the last sector line, seconds (+ slower). */
  split: number | null;
  speed: number;
  cells: number;
  cellCharge: number;
  /** Track positions 0..1 of every car (yours first) and race order. */
  you: { s: number; x: number; z: number };
  rivals: { id: string; s: number; x: number; z: number; progress: number }[];
  progress: number;
  /** Laps done, newest last. */
  laps: number[];
  pitting: boolean;
  pitStopped: boolean;
  airborne: boolean;
}

interface CarRig {
  group: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Object3D[];
  jets: THREE.Object3D[];
  spin: number;
}

interface AI {
  id: string;
  rig: CarRig;
  s: number;
  lap: number;
  /** Cruising speed and speed right now, m/s. */
  speed: number;
  spd: number;
  lane: number;
  /** Where it is across the road, and how fast that's changing (knocks, lane changes). */
  lat: number;
  latVel: number;
}

/** The circuit's centre line at t ∈ [0,1), flat: a long rounded loop with a chicane. Heights come after, by distance. */
function centre(t: number): THREE.Vector3 {
  const th = t * Math.PI * 2;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const n = 3.6;
  const x = 230 * Math.sign(c) * Math.abs(c) ** (2 / n) + 26 * Math.sin(th * 3);
  const z = 120 * Math.sign(s) * Math.abs(s) ** (2 / n) + 18 * Math.sin(th * 2 + 0.6);
  return v3(x, 0, z);
}

export class RaceScene {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(62, 1, 0.1, 4000);
  /** Seconds since the race opened; our own clock, so reading it never disturbs the frame step. */
  private start = performance.now();
  private lastFrame = performance.now();
  private secs() {
    return (performance.now() - this.start) / 1000;
  }
  private raf = 0;
  private dead = false;
  // The track, sampled evenly.
  private pts: THREE.Vector3[] = [];
  private tan: THREE.Vector3[] = [];
  /** Right across the road, level (for steering and lanes) and tilted by the banking (for building it). */
  private rgt: THREE.Vector3[] = [];
  private rgt3: THREE.Vector3[] = [];
  /** Rise per metre along the road. */
  private slope: number[] = [];
  private length = 0;
  private paint = new THREE.TextureLoader().load(brushedUrl, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
  });
  // You.
  private you!: CarRig;
  private pos = v3();
  private vel = v3();
  /** Speed along the car's nose, m/s (the velocity slides toward it: that's the drift). */
  private spd = 0;
  private heading = 0;
  private y = 0;
  private vy = 0;
  private air = false;
  private pitch = 0;
  /** Pitting: your car's agent needs you, so the car drives itself into the box and waits. */
  private pitting = false;
  private pitStopped = false;
  private roll = 0;
  private boost = 0;
  private sIdx = 0;
  private lastS = 0;
  private lap = 0;
  private lapStart = 0;
  private sector = 0;
  private sectorTimes: number[] = [];
  private bestSectors: number[] | null = null;
  private best: number | null = null;
  private split: number | null = null;
  private laps: number[] = [];
  private cells = CELLS;
  private charge = 0;
  private phase: 'countdown' | 'race' = 'countdown';
  private t0 = 0;
  private keys: RaceKeys = { up: false, down: false, left: false, right: false };
  private rivals: AI[] = [];
  private camPos = v3();
  private camLook = v3();
  private sparks: THREE.Points;
  private sparkAge = new Float32Array(200).fill(9);
  private sparkVel: THREE.Vector3[] = [];
  private sparkNext = 0;

  constructor(private canvas: HTMLCanvasElement, kind: CarKind, rivals: Rival[], day: boolean) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = day ? 1.0 : 1.15;
    try {
      const b = JSON.parse(localStorage.getItem(BEST_KEY) ?? 'null');
      if (b && typeof b.lap === 'number') {
        this.best = b.lap;
        this.bestSectors = b.sectors;
      }
    } catch {
      /* no best yet */
    }
    this.buildWorld(day);
    this.buildTrack();
    this.you = this.makeCar(kind, 0xd8dce3);
    this.scene.add(this.you.group);
    rivals.forEach((r, i) => {
      const rig = this.makeCar(r.kind, 0xa9aeb8);
      this.scene.add(rig.group);
      const lane = i % 2 ? 3.2 : -3.2;
      this.rivals.push({ id: r.id, rig, s: (0.06 + i * 0.09) % 1, lap: 0, speed: 46 + (i % 3) * 5, spd: 46 + (i % 3) * 5, lane, lat: lane, latVel: 0 });
    });
    // On the grid: just behind the line, in the left lane.
    this.sIdx = SAMPLES - 14;
    const g = this.pts[this.sIdx];
    this.pos.set(g.x, 0, g.z).add(this.rgt[this.sIdx].clone().multiplyScalar(-3.2));
    this.heading = Math.atan2(this.tan[this.sIdx].x, this.tan[this.sIdx].z);
    this.lastS = this.sIdx / SAMPLES;
    this.camPos.copy(this.pos).add(v3(-Math.sin(this.heading) * 12, 5, -Math.cos(this.heading) * 12));
    this.camLook.copy(this.pos);
    this.sparks = this.buildSparks();
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.7, 0.5, 0.75);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.resize();
    this.t0 = this.secs();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ── The world ───────────────────────────────────────────────────────────

  private buildWorld(day: boolean) {
    const s = this.scene;
    s.background = new THREE.Color(day ? 0x8a9bb5 : 0x05070c);
    s.fog = new THREE.FogExp2(day ? 0xc9b49a : 0x0b0f1c, day ? 0.0012 : 0.0016);
    // The bay and city all round: a far cylinder wearing a skyline panorama.
    const pano = new THREE.TextureLoader().load(day ? panoDayUrl : panoUrl, (t) => {
      // It lights and reflects everything too.
      const eq = t.clone();
      eq.mapping = THREE.EquirectangularReflectionMapping;
      eq.needsUpdate = true;
      s.environment = new THREE.PMREMGenerator(this.renderer).fromEquirectangular(eq).texture;
    });
    pano.colorSpace = THREE.SRGBColorSpace;
    pano.wrapS = THREE.RepeatWrapping;
    // Inside a cylinder the picture reads mirrored: flip it, twice round.
    pano.repeat.set(-2, 1);
    const sky = new THREE.Mesh(new THREE.CylinderGeometry(1500, 1500, 900, 64, 1, true), new THREE.MeshBasicMaterial({ map: pano, side: THREE.BackSide, fog: false, toneMapped: false }));
    // The photo's waterline (about three quarters down) sits on the bay's horizon.
    sky.position.y = 900 * (0.75 - 0.5) - 3;
    s.add(sky);
    s.environmentIntensity = 0.8;
    s.add(new THREE.HemisphereLight(day ? 0xffe6c8 : 0x6a7aa8, day ? 0x3a3020 : 0x080a10, day ? 1.4 : 0.5));
    const sun = new THREE.DirectionalLight(day ? 0xffc890 : 0x9fb4ff, day ? 2.2 : 0.6);
    sun.position.set(-300, day ? 160 : 300, 200);
    s.add(sun);
    // Water, and the pier deck under the circuit.
    const water = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: day ? 0x2a4a66 : 0x04070e, roughness: 0.12, metalness: 0.9 }));
    water.position.y = -3;
    s.add(water);
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(620, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: day ? 0x3a3c40 : 0x0d0f14, roughness: 0.6, metalness: 0.2 }));
    deck.position.y = -0.4;
    s.add(deck);
  }

  private buildTrack() {
    // Even samples by distance.
    const dense: THREE.Vector3[] = [];
    for (let i = 0; i < 3000; i++) dense.push(centre(i / 3000));
    const curve = new THREE.CatmullRomCurve3(dense, true, 'centripetal');
    curve.arcLengthDivisions = 12000;
    this.length = curve.getLength();
    // Heights by distance round the lap: a crest on the top straight that rises
    // gently and drops away sharply (it throws you at speed), and a long hill.
    const L = this.length;
    const lump = (u: number, at: number, up: number, down: number) => {
      let d = (u - at) * L;
      if (d > L / 2) d -= L;
      if (d < -L / 2) d += L;
      return Math.exp(-((d / (d < 0 ? up : down)) ** 2));
    };
    const height = (u: number) => 6.5 * lump(u, 0.27, 45, 16) + 5 * lump(u, 0.7, 90, 90);
    for (let i = 0; i < SAMPLES; i++) {
      const p = curve.getPointAt(i / SAMPLES);
      p.y = height(i / SAMPLES);
      const t = curve.getTangentAt(i / SAMPLES);
      const flat = v3(t.x, 0, t.z).normalize();
      this.pts.push(p);
      this.tan.push(flat);
      this.rgt.push(v3(-flat.z, 0, flat.x));
    }
    // Bank into the turns, outside edge up, smoothed; slope from the heights.
    const ds = this.length / SAMPLES;
    const head = this.tan.map((t) => Math.atan2(t.x, t.z));
    const raw = head.map((_, i) => {
      let d = head[(i + 3) % SAMPLES] - head[(i - 3 + SAMPLES) % SAMPLES];
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      return Math.max(-0.22, Math.min(0.22, (d / (6 * ds)) * 9));
    });
    for (let i = 0; i < SAMPLES; i++) {
      let b = 0;
      for (let k = -12; k <= 12; k++) b += raw[(i + k + SAMPLES) % SAMPLES];
      b /= 25;
      this.rgt3.push(this.rgt[i].clone().multiplyScalar(Math.cos(b)).add(v3(0, Math.sin(b), 0)));
      this.slope.push((this.pts[(i + 1) % SAMPLES].y - this.pts[(i - 1 + SAMPLES) % SAMPLES].y) / (2 * ds));
    }
    const s = this.scene;
    // The road: wet asphalt.
    const road: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    let run = 0;
    for (let i = 0; i <= SAMPLES; i++) {
      const k = i % SAMPLES;
      const p = this.pts[k];
      const r = this.rgt3[k];
      const l = p.clone().add(r.clone().multiplyScalar(-HALF));
      const rr = p.clone().add(r.clone().multiplyScalar(HALF));
      road.push(l.x, l.y, l.z, rr.x, rr.y, rr.z);
      if (i > 0) run += p.distanceTo(this.pts[(k - 1 + SAMPLES) % SAMPLES]);
      uv.push(0, run / 14, 1, run / 14);
      if (i < SAMPLES) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(road, 3));
    rg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    rg.setIndex(idx);
    rg.computeVertexNormals();
    s.add(new THREE.Mesh(rg, new THREE.MeshStandardMaterial({ color: 0x16181e, roughness: 0.22, metalness: 0.35, envMapIntensity: 1.2 })));
    // Neon edges with light running round, kerbs on the corners, a centre dash.
    const edge = new THREE.ShaderMaterial({
      toneMapped: false,
      side: THREE.DoubleSide,
      uniforms: { time: { value: 0 }, tint: { value: CYAN.clone().multiplyScalar(1.5) } },
      vertexShader: 'attribute float along; varying float va; void main(){ va = along; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
      fragmentShader: 'varying float va; uniform float time; uniform vec3 tint; void main(){ float p = fract(va / 40. - time * 1.2); float pulse = smoothstep(0.0, 0.02, p) * smoothstep(0.08, 0.02, p); gl_FragColor = vec4(tint * (0.6 + 1.2 * pulse), 1.); }',
    });
    this.edge = edge;
    for (const side of [-1, 1]) {
      const pos: number[] = [];
      const al: number[] = [];
      const ix: number[] = [];
      let d = 0;
      for (let i = 0; i <= SAMPLES; i++) {
        const k = i % SAMPLES;
        const c = this.pts[k].clone().add(this.rgt3[k].clone().multiplyScalar(side * (HALF - 0.25))).add(v3(0, 0.03, 0));
        const a = c.clone().add(this.rgt3[k].clone().multiplyScalar(-0.15));
        const b = c.clone().add(this.rgt3[k].clone().multiplyScalar(0.15));
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
        if (i > 0) d += this.pts[k].distanceTo(this.pts[(k - 1 + SAMPLES) % SAMPLES]);
        al.push(d, d);
        if (i < SAMPLES) ix.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('along', new THREE.Float32BufferAttribute(al, 1));
      g.setIndex(ix);
      s.add(new THREE.Mesh(g, edge));
      // Barriers: low walls just outside the edge.
      const wall: number[] = [];
      const wi: number[] = [];
      for (let i = 0; i <= SAMPLES; i++) {
        const k = i % SAMPLES;
        const c = this.pts[k].clone().add(this.rgt3[k].clone().multiplyScalar(side * (HALF + 1.2)));
        wall.push(c.x, c.y - 0.2, c.z, c.x, c.y + 1.1, c.z);
        if (i < SAMPLES) wi.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
      }
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.Float32BufferAttribute(wall, 3));
      wg.setIndex(wi);
      wg.computeVertexNormals();
      s.add(new THREE.Mesh(wg, new THREE.MeshStandardMaterial({ color: 0x2a2e38, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide })));
    }
    const dash = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.18, 3).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x8a90a0 }), Math.floor(SAMPLES / 8));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let i = 0, n = 0; i < SAMPLES; i += 8, n++) {
      q.setFromUnitVectors(v3(0, 0, 1), this.tan[i]);
      m.compose(this.pts[i].clone().add(v3(0, 0.02, 0)), q, v3(1, 1, 1));
      dash.setMatrixAt(n, m);
    }
    s.add(dash);
    // Lamps every 40 m on both sides: bright heads the bloom picks up.
    const lampCount = Math.floor(this.length / 40) * 2;
    const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe2b8).multiplyScalar(3), toneMapped: false }), lampCount);
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.08, 0.1, 7, 6), new THREE.MeshStandardMaterial({ color: 0x2a2e38, metalness: 0.7, roughness: 0.4 }), lampCount);
    for (let n = 0; n < lampCount; n++) {
      const i = Math.floor((n >> 1) * (40 / this.length) * SAMPLES) % SAMPLES;
      const side = n % 2 ? 1 : -1;
      const base = this.pts[i].clone().add(this.rgt3[i].clone().multiplyScalar(side * (HALF + 2)));
      m.makeTranslation(base.x, base.y + 3.5, base.z);
      poles.setMatrixAt(n, m);
      m.makeTranslation(base.x, base.y + 7.1, base.z);
      heads.setMatrixAt(n, m);
    }
    s.add(heads, poles);
    // Pylons under the raised road.
    const pylonMat = new THREE.MeshStandardMaterial({ color: 0x252a35, roughness: 0.55, metalness: 0.6 });
    for (let i = 0; i < SAMPLES; i += 10) {
      const p = this.pts[i];
      if (p.y < 1.5) continue;
      for (const side of [-1, 1]) {
        const at = p.clone().add(this.rgt3[i].clone().multiplyScalar(side * (HALF - 1.5)));
        const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.8, at.y + 0.4, 0.8), pylonMat);
        pylon.position.set(at.x, at.y / 2 - 0.4, at.z);
        s.add(pylon);
      }
    }
    // The pit box: an amber frame on the right of the main straight, before the line.
    {
      const i = PIT_IDX;
      const at = this.pts[i].clone().add(this.rgt3[i].clone().multiplyScalar(PIT_LANE)).add(v3(0, 0.04, 0));
      const amber = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa62b).multiplyScalar(1.4), toneMapped: false });
      const q = new THREE.Quaternion().setFromUnitVectors(v3(0, 0, 1), this.tan[i]);
      for (const [w, d, ox, oz] of [[3.2, 0.15, 0, 3], [3.2, 0.15, 0, -3], [0.15, 6, 1.6, 0], [0.15, 6, -1.6, 0]] as const) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.03, d), amber);
        bar.position.copy(at).add(v3(ox, 0, oz).applyQuaternion(q));
        bar.quaternion.copy(q);
        s.add(bar);
      }
    }
    // The start gantry and its sign.
    const g0 = this.pts[0];
    const steel = new THREE.MeshStandardMaterial({ color: 0x22262f, metalness: 0.7, roughness: 0.45 });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.9, 11, 0.9), steel);
      post.position.copy(g0).add(this.rgt3[0].clone().multiplyScalar(side * (HALF + 2))).add(v3(0, 5.5, 0));
      s.add(post);
    }
    const beamGeo = new THREE.BoxGeometry(2 * HALF + 5, 2.6, 0.8);
    const beam = new THREE.Mesh(beamGeo, steel);
    beam.position.copy(g0).add(v3(0, 10.4, 0));
    beam.quaternion.setFromUnitVectors(v3(1, 0, 0), this.rgt3[0]);
    s.add(beam);
    const sign = document.createElement('canvas');
    sign.width = 1024;
    sign.height = 128;
    const c = sign.getContext('2d')!;
    c.fillStyle = '#0b0d14';
    c.fillRect(0, 0, 1024, 128);
    c.fillStyle = '#ffb347';
    c.font = '800 92px "Big Shoulders", "Arial Narrow", sans-serif';
    c.textAlign = 'center';
    c.fillText('LAUNCH CONTROL', 512, 100);
    const st = new THREE.CanvasTexture(sign);
    st.colorSpace = THREE.SRGBColorSpace;
    // A box whose two big faces carry the sign: each reads right way round from its side.
    const signMat = new THREE.MeshBasicMaterial({ map: st, toneMapped: false });
    const box = new THREE.Mesh(new THREE.BoxGeometry(2 * HALF + 3, 2.2, 1), [steel, steel, steel, steel, signMat, signMat]);
    box.position.copy(beam.position);
    const back = this.tan[0].clone().negate();
    box.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(v3(0, 1, 0).cross(back).normalize(), v3(0, 1, 0), back));
    s.add(box);
    // The start/finish line.
    const chk = document.createElement('canvas');
    chk.width = 256;
    chk.height = 32;
    const cc = chk.getContext('2d')!;
    for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) {
      cc.fillStyle = (x + y) % 2 ? '#1a1b20' : '#9a9ca4';
      cc.fillRect(x * 16, y * 16, 16, 16);
    }
    const ct = new THREE.CanvasTexture(chk);
    ct.colorSpace = THREE.SRGBColorSpace;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(2 * HALF, 1.4).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: ct, roughness: 0.4 }));
    line.position.copy(g0).add(v3(0, 0.03, 0));
    line.quaternion.multiply(new THREE.Quaternion().setFromUnitVectors(v3(1, 0, 0), this.rgt3[0]));
    s.add(line);
  }

  private edge!: THREE.ShaderMaterial;

  private buildSparks(): THREE.Points {
    const n = this.sparkAge.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('alpha', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
    for (let i = 0; i < n; i++) this.sparkVel.push(v3());
    const p = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: 'attribute float alpha; varying float va; void main(){ va = alpha; vec4 mv = modelViewMatrix * vec4(position,1.); gl_PointSize = 120. / -mv.z; gl_Position = projectionMatrix * mv; }',
        fragmentShader: 'varying float va; void main(){ float d = length(gl_PointCoord - 0.5) * 2.; gl_FragColor = vec4(vec3(0.9,0.95,1.), smoothstep(1., 0., d) * va); }',
      }),
    );
    p.frustumCulled = false;
    this.scene.add(p);
    return p;
  }

  private spark(at: THREE.Vector3, dir: THREE.Vector3) {
    const i = this.sparkNext;
    this.sparkNext = (i + 1) % this.sparkAge.length;
    this.sparkAge[i] = 0;
    (this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute).setXYZ(i, at.x, at.y, at.z);
    this.sparkVel[i].copy(dir).add(v3((Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2));
  }

  private makeCar(kind: CarKind, colour: number): CarRig {
    const m = carModel(kind);
    const paint = new THREE.MeshPhysicalMaterial({ color: colour, map: this.paint, vertexColors: true, metalness: 0.85, roughness: 0.5, clearcoat: 0.7, clearcoatRoughness: 0.15, flatShading: true, envMapIntensity: 1.6 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.5, metalness: 0.6, flatShading: true });
    const body = new THREE.Group();
    body.add(new THREE.Mesh(m.body, paint));
    for (const t of m.trim) body.add(new THREE.Mesh(t, trim));
    const lamp = (x: number, y: number, w: number, h: number, c: number) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.04, h, w), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(2), toneMapped: false }));
      b.position.set(x, y, 0);
      body.add(b);
    };
    if (m.front) lamp(m.front[0], m.front[1], m.front[2], m.front[3], 0xf4f8ff);
    lamp(m.rear[0], m.rear[1], m.rear[2], m.rear[3], 0xff2a3c);
    const jets: THREE.Object3D[] = [];
    const nozzles: [number, number, number][] = m.nozzles.length ? m.nozzles : [[m.rear[0] + 0.1, 0.3, 0.6], [m.rear[0] + 0.1, 0.3, -0.6]];
    for (const [x, y, z] of nozzles) {
      const j = new THREE.Group();
      for (const [r, len, col, op] of [[0.11, 1.8, 0xffffff, 1], [0.28, 2.8, 0x9fd0ff, 0.5]] as const) {
        const g = new THREE.ConeGeometry(r, len, 12, 1, true).rotateX(Math.PI).translate(0, -len / 2, 0);
        j.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide })));
      }
      j.position.set(x, y - 0.1, z);
      j.scale.setScalar(0.001);
      body.add(j);
      jets.push(j);
    }
    const wheels: THREE.Object3D[] = [];
    const tyre = new THREE.CylinderGeometry(m.wheelR, m.wheelR, m.wheelW, 28).rotateX(Math.PI / 2);
    const disc = new THREE.CylinderGeometry(m.wheelR * 0.74, m.wheelR * 0.74, m.wheelW + 0.02, 5).rotateX(Math.PI / 2);
    for (const [x, z] of m.wheels) {
      const w = new THREE.Group();
      w.add(new THREE.Mesh(tyre, new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.85 })), new THREE.Mesh(disc, new THREE.MeshStandardMaterial({ color: 0x2a2d33, metalness: 0.9, roughness: 0.3, flatShading: true })));
      w.position.set(x, m.wheelR, z);
      wheels.push(w);
    }
    const group = new THREE.Group();
    // Models face +x; the race faces +z: turn them once inside the group.
    const inner = new THREE.Group();
    inner.rotation.y = -Math.PI / 2;
    inner.add(body, ...wheels);
    group.add(inner);
    return { group, body, wheels, jets, spin: 0 };
  }

  // ── Input ───────────────────────────────────────────────────────────────

  setKeys(k: Partial<RaceKeys>) {
    Object.assign(this.keys, k);
  }

  /** Space: spend a thruster cell on a hop and a burst of speed. */
  thrust(): boolean {
    if (this.phase !== 'race' || this.pitting || this.cells < 1) return false;
    this.cells -= 1;
    this.boost = 1.6;
    if (!this.air) {
      this.air = true;
      this.vy = Math.max(this.vy, 0) + 7.5;
    }
    return true;
  }

  // ── Each frame ──────────────────────────────────────────────────────────

  private nearest(p: THREE.Vector3): number {
    let best = this.sIdx;
    let d = Infinity;
    for (let k = -40; k <= 40; k++) {
      const i = (this.sIdx + k + SAMPLES) % SAMPLES;
      const e = (this.pts[i].x - p.x) ** 2 + (this.pts[i].z - p.z) ** 2;
      if (e < d) {
        d = e;
        best = i;
      }
    }
    return best;
  }

  private place(rig: CarRig, x: number, y: number, z: number, heading: number, roll: number, thrust: number, moved: number, pitch = 0) {
    rig.group.position.set(x, y, z);
    rig.group.rotation.set(-pitch, heading, roll, 'YXZ');
    rig.spin += moved / 0.37;
    for (const w of rig.wheels) w.rotation.z = -rig.spin;
    for (const j of rig.jets) {
      const k = thrust > 0.05 ? thrust * (0.85 + Math.random() * 0.3) : 0.001;
      j.scale.set(k, k * (1.2 + Math.random() * 0.4), k);
    }
  }

  private simulate(dt: number, now: number) {
    if (this.phase === 'countdown' && now - this.t0 >= COUNTDOWN) {
      this.phase = 'race';
      this.lapStart = now;
    }
    const racing = this.phase === 'race';

    // Pitting: the car takes itself to the box and stops there.
    let keys = this.keys;
    if (this.pitting && racing) {
      const ahead = (PIT_IDX - this.sIdx + SAMPLES) % SAMPLES;
      const toward = ahead > SAMPLES / 2 ? 30 : Math.min(30, ahead);
      const ti = (this.sIdx + toward) % SAMPLES;
      const target = this.pts[ti].clone().add(this.rgt[ti].clone().multiplyScalar(ahead < 120 ? PIT_LANE : 0));
      let d = Math.atan2(target.x - this.pos.x, target.z - this.pos.z) - this.heading;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      const want = ahead > SAMPLES / 2 ? 34 : Math.min(34, ahead * 0.35);
      keys = { up: this.spd < want - 1, down: this.spd > want + 1 || (ahead < 3 && ahead >= 0), left: d > 0.03, right: d < -0.03 };
      this.pitStopped = ahead <= 3 && Math.abs(this.spd) < 1.5;
      if (this.pitStopped) {
        this.spd = 0;
        this.vel.set(0, 0, 0);
      }
    }

    // Your car: arcade handling.
    let speed = this.spd;
    const top = this.boost > 0 ? BOOST_SPEED : MAX_SPEED;
    if (racing) {
      if (keys.up) speed += (this.boost > 0 ? 40 : 24) * dt * (1 - Math.max(0, speed) / (top * 1.05));
      else if (keys.down) speed -= (speed > 0 ? 38 : 10) * dt;
      else speed -= Math.sign(speed) * Math.min(Math.abs(speed), 5 * dt);
      if (this.boost > 0) speed += 26 * dt;
      speed = Math.max(-12, Math.min(top, speed));
      this.spd = speed;
      const steer = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
      const grip = Math.min(1, Math.abs(speed) / 14);
      this.heading += steer * 1.9 * grip * (1 - 0.4 * Math.min(1, Math.abs(speed) / MAX_SPEED)) * dt * Math.sign(speed || 1);
      this.roll += (steer * 0.06 * grip - this.roll) * Math.min(1, dt * 6);
    }
    const nf = v3(Math.sin(this.heading), 0, Math.cos(this.heading));
    // The tyres pull the velocity round to where the car points; a little slide at speed.
    const want = nf.clone().multiplyScalar(speed);
    this.vel.lerp(want, Math.min(1, dt * (this.air ? 0.6 : 7)));
    const before = this.pos.clone();
    this.pos.addScaledVector(this.vel, dt);
    this.sIdx = this.nearest(this.pos);
    const c = this.pts[this.sIdx];
    const r = this.rgt[this.sIdx];
    const off = (this.pos.x - c.x) * r.x + (this.pos.z - c.z) * r.z;
    const lim = HALF - 1.1;
    if (Math.abs(off) > lim) {
      // The barrier: back onto the road, scrubbing speed, sparks.
      this.pos.addScaledVector(r, (Math.sign(off) * lim - off));
      const into = r.clone().multiplyScalar(Math.sign(off));
      const vn = this.vel.dot(into);
      if (vn > 0) this.vel.addScaledVector(into, -vn * 1.4);
      this.vel.multiplyScalar(1 - Math.min(0.5, dt * 2.5));
      this.spd *= 1 - Math.min(0.5, dt * 2.5);
      if (Math.random() < 0.8) this.spark(this.pos.clone().addScaledVector(into, 1).add(v3(0, 0.5, 0)), this.vel.clone().multiplyScalar(0.3));
    }
    // Contact with rivals: equal-mass bumps, both cars knocked, metal on metal.
    for (const a of this.rivals) {
      const ap = a.rig.group.position;
      if (Math.abs(ap.y - this.y) > 1.6) continue;
      const n = v3(this.pos.x - ap.x, 0, this.pos.z - ap.z);
      const dist = n.length();
      if (dist < 0.01 || dist > 4.3) continue;
      n.multiplyScalar(1 / dist);
      const ai = Math.floor(a.s * SAMPLES) % SAMPLES;
      const av = this.tan[ai].clone().multiplyScalar(a.spd).addScaledVector(this.rgt[ai], a.latVel);
      const rel = this.vel.clone().sub(av).dot(n);
      // Pull apart, half each.
      const overlap = 4.3 - dist;
      this.pos.addScaledVector(n, overlap / 2);
      a.lat -= n.dot(this.rgt[ai]) * (overlap / 2);
      if (rel < 0) {
        const j = (-(1 + 0.35) * rel) / 2;
        this.vel.addScaledVector(n, j);
        const nf0 = v3(Math.sin(this.heading), 0, Math.cos(this.heading));
        this.spd = this.vel.dot(nf0);
        // A glancing blow twists you a little.
        this.heading += n.dot(v3(nf0.z, 0, -nf0.x)) * Math.min(0.25, j * 0.02);
        a.spd -= n.dot(this.tan[ai]) * j;
        a.spd = Math.max(20, a.spd);
        a.latVel -= n.dot(this.rgt[ai]) * j;
        for (let k = 0; k < Math.min(12, j * 2); k++) this.spark(v3(ap.x, 0, ap.z).addScaledVector(n, dist / 2).add(v3(0, this.y + 0.6, 0)), n.clone().multiplyScalar(4));
      }
    }
    // Height: the banked road under you, or the air. Over a crest at speed the
    // road falls away faster than you do, and you fly.
    const c2 = this.pts[this.sIdx];
    const r3 = this.rgt3[this.sIdx];
    const off2 = (this.pos.x - c2.x) * this.rgt[this.sIdx].x + (this.pos.z - c2.z) * this.rgt[this.sIdx].z;
    const ground = c2.y + off2 * (r3.y / Math.max(0.5, Math.hypot(r3.x, r3.z)));
    const roadVy = this.slope[this.sIdx] * this.vel.dot(this.tan[this.sIdx]);
    if (!this.air) {
      // The road drops away faster than gravity can pull you down: you're flying.
      if (roadVy < this.vy - GRAVITY * dt * 1.1 && Math.abs(this.spd) > 20) this.air = true;
      else {
        this.y = ground;
        this.vy = roadVy;
      }
    }
    if (this.air) {
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y <= ground) {
        // Touchdown: a jolt, a little speed lost, sparks if it was hard.
        const hit = roadVy - this.vy;
        this.y = ground;
        this.vy = roadVy;
        this.air = false;
        this.spd *= hit > 8 ? 0.9 : 0.98;
        if (hit > 6) for (let k = 0; k < 10; k++) this.spark(v3(this.pos.x, this.y + 0.2, this.pos.z), v3(0, 2, 0));
      }
    }
    const wantPitch = this.air ? Math.atan2(this.vy, Math.max(8, Math.abs(this.spd))) * 0.6 : Math.atan(this.slope[this.sIdx]);
    this.pitch += (wantPitch - this.pitch) * Math.min(1, dt * 8);
    this.boost = Math.max(0, this.boost - dt);
    // Cells refill on the move.
    if (this.cells < CELLS && racing) {
      this.charge += (dt / CELL_REFILL) * Math.min(1, Math.abs(speed) / 30);
      if (this.charge >= 1) {
        this.charge = 0;
        this.cells += 1;
      }
    }
    const thrustNow = this.boost > 0 ? Math.min(1, this.boost / 0.6) : 0;
    const bank = Math.asin(Math.max(-1, Math.min(1, this.rgt3[this.sIdx].y)));
    this.place(this.you, this.pos.x, this.y, this.pos.z, this.heading, this.roll - (this.air ? 0 : bank), thrustNow, before.distanceTo(this.pos), this.pitch);

    // Laps and sectors.
    const sNow = this.sIdx / SAMPLES;
    if (racing) {
      for (const [line, sec] of [[1 / 3, 1], [2 / 3, 2]] as const)
        if (this.lastS < line && sNow >= line && this.sector === sec - 1) {
          const t = now - this.lapStart;
          this.sectorTimes[sec - 1] = t;
          this.sector = sec;
          if (this.bestSectors) this.split = t - this.bestSectors[sec - 1];
        }
      if (this.lastS > 0.85 && sNow < 0.15) {
        const t = now - this.lapStart;
        if (this.lap > 0 || this.sector === 2) {
          this.laps.push(t);
          if (this.best === null || t < this.best) {
            this.best = t;
            this.bestSectors = [this.sectorTimes[0], this.sectorTimes[1]];
            try {
              localStorage.setItem(BEST_KEY, JSON.stringify({ lap: t, sectors: this.bestSectors }));
            } catch {
              /* kept for this run */
            }
          }
          this.split = this.best !== null && this.laps.length > 1 ? t - Math.min(...this.laps.slice(0, -1)) : null;
        }
        this.lap += 1;
        this.lapStart = now;
        this.sector = 0;
      }
    }
    this.lastS = sNow;

    // Rivals lap at their own pace; knocks push them across the road and they
    // settle back; they change lanes to get round you.
    for (const a of this.rivals) {
      const before2 = a.rig.group.position.clone();
      const youAhead = ((sNow - a.s + 1) % 1) * this.length;
      const i0 = Math.floor(a.s * SAMPLES) % SAMPLES;
      const youLat = (this.pos.x - this.pts[i0].x) * this.rgt[i0].x + (this.pos.z - this.pts[i0].z) * this.rgt[i0].z;
      if (youAhead > 0 && youAhead < 18 && Math.abs(youLat - a.lane) < 3) a.lane = -a.lane;
      a.spd += (a.speed - a.spd) * Math.min(1, dt * 0.6);
      a.latVel += ((a.lane - a.lat) * 3 - a.latVel * 2.4) * dt;
      a.lat = Math.max(-(HALF - 1.2), Math.min(HALF - 1.2, a.lat + a.latVel * dt));
      a.s += (a.spd * dt) / this.length;
      if (a.s >= 1) {
        a.s -= 1;
        a.lap += 1;
      }
      const i = Math.floor(a.s * SAMPLES) % SAMPLES;
      const p = this.pts[i].clone().add(this.rgt3[i].clone().multiplyScalar(a.lat));
      const bank = Math.asin(Math.max(-1, Math.min(1, this.rgt3[i].y)));
      this.place(a.rig, p.x, p.y, p.z, Math.atan2(this.tan[i].x, this.tan[i].z) + a.latVel * 0.03, -bank, 0, before2.distanceTo(p), Math.atan(this.slope[i]));
    }
  }

  private frame = () => {
    if (this.dead) return;
    this.raf = requestAnimationFrame(this.frame);
    const t = performance.now();
    const real = Math.min(0.1, (t - this.lastFrame) / 1000);
    this.lastFrame = t;
    const now = this.secs();
    this.edge.uniforms.time.value = now;
    // Physics in small steps, so the car handles the same at any frame rate.
    const n = Math.max(1, Math.ceil(real / 0.02));
    for (let i = 0; i < n; i++) this.simulate(real / n, now);
    const dt = real;
    const nf = v3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const speed = this.spd;

    // Chase camera: behind and above, wider with speed.
    const sp = Math.abs(speed);
    const back = nf.clone().multiplyScalar(-(9 + sp * 0.03));
    const wantPos = v3(this.pos.x, this.y, this.pos.z).add(back).add(v3(0, 3.4 + sp * 0.01, 0));
    const wantLook = v3(this.pos.x, this.y + 1.1, this.pos.z).addScaledVector(nf, 7);
    this.camPos.lerp(wantPos, Math.min(1, dt * 6));
    this.camLook.lerp(wantLook, Math.min(1, dt * 10));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    const fov = 60 + sp * 0.14 + (this.boost > 0 ? 6 : 0);
    if (Math.abs(this.camera.fov - fov) > 0.1) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 4);
      this.camera.updateProjectionMatrix();
    }

    // Sparks fly and fade.
    const pa = this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
    const aa = this.sparks.geometry.getAttribute('alpha') as THREE.BufferAttribute;
    for (let i = 0; i < this.sparkAge.length; i++) {
      const age = (this.sparkAge[i] += dt);
      if (age > 0.6) {
        aa.setX(i, 0);
        continue;
      }
      this.sparkVel[i].y -= 9 * dt;
      pa.setXYZ(i, pa.getX(i) + this.sparkVel[i].x * dt, pa.getY(i) + this.sparkVel[i].y * dt, pa.getZ(i) + this.sparkVel[i].z * dt);
      aa.setX(i, 1 - age / 0.6);
    }
    pa.needsUpdate = aa.needsUpdate = true;

    this.composer.render(dt);
  };

  status(): RaceStatus {
    const now = this.secs();
    const sNow = this.sIdx / SAMPLES;
    return {
      phase: this.phase,
      lights: this.phase === 'countdown' ? Math.min(5, Math.floor(((now - this.t0) / (COUNTDOWN - 0.5)) * 5) + 1) : 0,
      lap: Math.max(1, this.lap),
      lapTime: this.phase === 'race' ? now - this.lapStart : 0,
      best: this.best,
      split: this.split,
      speed: Math.abs(this.spd) * 3.6,
      cells: this.cells,
      cellCharge: this.charge,
      you: { s: sNow, x: this.pos.x, z: this.pos.z },
      rivals: this.rivals.map((a) => ({ id: a.id, s: a.s, x: a.rig.group.position.x, z: a.rig.group.position.z, progress: a.lap + a.s })),
      progress: Math.max(0, this.lap - 1) + sNow,
      laps: [...this.laps],
      pitting: this.pitting,
      pitStopped: this.pitStopped,
      airborne: this.air,
    };
  }

  /** Your car's agent needs you (true): the car pits itself. Answered (false): back out. */
  pit(on: boolean) {
    if (on === this.pitting) return;
    this.pitting = on;
    this.pitStopped = false;
    // A stop in the box refills the thrusters.
    if (!on) {
      this.cells = CELLS;
      this.charge = 0;
    }
  }

  /** The circuit as 2D points, for the HUD's map. */
  outline(n = 160): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const p = this.pts[Math.floor((i / n) * SAMPLES)];
      out.push([p.x, p.z]);
    }
    return out;
  }

  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
  }
}
