// The Nebula: where old stars go. Two days after a star finishes it leaves the
// sky and drifts in here, and it dies the way real stars do. A finished one
// blows off its shells as a planetary nebula, then shrinks to a white dwarf,
// then cools to an ember deep in the cloud. A failed one is a supernova
// remnant, torn filaments around a blinking pulsar. A stopped one is a brown
// dwarf that never fully lit. The older a star, the deeper and hazier it sits.
//
// The gas is painted once per size into offscreen layers; stars are drawn on
// a canvas every frame, with a button laid over each for the pointer, the
// keyboard and its label.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { FATE, type Fate, fateOf } from '../lib/stars';
import { ENGINE_NAME, type Star } from '../lib/types';
import { ago } from '../lib/useHalo';
import type { Point } from './Galaxy';
import { plain } from './Md';

/** The life line, in order; the two other endings after it. */
const LIFE: Fate[] = ['giant', 'planetary', 'dwarf', 'ember'];
const OTHER: Fate[] = ['supernova', 'brown'];

const TAG: Record<Fate, string> = {
  giant: 'var(--giant)',
  planetary: '#7fd8d8',
  dwarf: '#cfe0ff',
  ember: '#c4705a',
  supernova: '#ff7a59',
  brown: '#b0607a',
};

/** A seeded random stream, from a star's id. */
function rng(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Filament {
  angle: number;
  len: number;
  bends: [number, number][];
  color: string;
}

interface Body {
  star: Star;
  fate: Fate;
  k: number;
  days: number;
  /** 0 front … 1 deep in the cloud. */
  z: number;
  /** Place, as fractions of the scene. */
  u: number;
  v: number;
  seed: number;
  tilt: number;
  squash: number;
  bipolar: boolean;
  filaments: Filament[];
}

/** Smooth value noise, a few octaves deep: the texture of the gas. */
function noise(seed: number) {
  const hash = (x: number, y: number) => {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const value = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const u = smooth(x - xi);
    const v = smooth(y - yi);
    const a = hash(xi, yi);
    const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1);
    const d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return (x: number, y: number, octaves = 5) => {
    let sum = 0;
    let amp = 0.5;
    let f = 1;
    for (let i = 0; i < octaves; i++) {
      sum += amp * value(x * f, y * f);
      f *= 2.03;
      amp *= 0.5;
    }
    return sum / (1 - Math.pow(0.5, octaves));
  };
}

const ramp = (a: number, b: number, t: number) => Math.max(0, Math.min(1, (t - a) / (b - a)));
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

/**
 * The cloud, painted once per size: a far layer of broad glowing gas and a
 * near layer of brighter wisps, both following a spine across the scene, with
 * dark dust lanes eaten out of them and pillars rising from the bottom.
 */
function paintGas(w: number, h: number): { far: HTMLCanvasElement; near: HTMLCanvasElement; dust: { x: number; y: number; r: number; a: number }[] } {
  const GW = 340;
  const GH = Math.max(1, Math.round((GW * h) / Math.max(1, w)));
  const aspect = w / Math.max(1, h);
  // The spine: where the gas gathers, a slow S across the scene.
  const spineY = (x: number) => 0.62 - x * 0.3 + Math.sin(x * Math.PI * 1.7 + 0.4) * 0.12;
  const MAGENTA = [214, 64, 132];
  const VIOLET = [104, 70, 190];
  const TEAL = [56, 178, 196];
  const AMBER = [255, 176, 112];

  const layer = (seed: number, scale: number, lo: number, hi: number, width: number, strength: number) => {
    const n = noise(seed);
    const hue = noise(seed + 17);
    const dust = noise(seed + 31);
    const c = document.createElement('canvas');
    c.width = GW;
    c.height = GH;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(GW, GH);
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const x = i / GW;
        const y = j / GH;
        // Warp the lookup by the noise itself: turns blobs into wisps.
        const wx = x * aspect * scale;
        const wy = y * scale;
        const q = n(wx + 1.7, wy + 9.2, 3);
        const d = n(wx + q * 1.6, wy + q * 1.6);
        const off = (y - spineY(x)) / width;
        const shape = Math.exp(-off * off) * (0.55 + 0.45 * Math.sin(x * Math.PI));
        // Pillars of dust rising out of the bottom.
        const pillar = Math.max(0, 1 - Math.abs(Math.sin(x * Math.PI * 3.2 + 0.8)) * 4) * ramp(0.55, 1, y) * 0.9;
        const lane = ramp(0.52, 0.72, dust(wx * 1.6, wy * 1.6, 4)) * 0.85;
        let a = ramp(lo, hi, d) * shape * (1 - lane) * (1 - pillar) * strength;
        a = Math.min(1, a);
        const t = ramp(0.35, 0.7, hue(wx * 0.8, wy * 0.8, 3));
        let col = mix(mix(MAGENTA, VIOLET, ramp(0.2, 0.5, t)), TEAL, ramp(0.55, 0.95, t));
        // Hot cores where the gas is thickest.
        col = mix(col, AMBER, ramp(0.72, 0.92, d) * 0.7);
        const k = (j * GW + i) * 4;
        img.data[k] = col[0];
        img.data[k + 1] = col[1];
        img.data[k + 2] = col[2];
        img.data[k + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  };

  const far = layer(7, 2.2, 0.34, 0.86, 0.32, 0.75);
  const near = layer(23, 3.6, 0.46, 0.92, 0.22, 0.95);
  const r = rng(`nebula-${Math.round(w / 200)}`);
  const dust = Array.from({ length: 320 }, () => ({ x: r(), y: r(), r: r() < 0.08 ? 1.3 : 0.6 + r() * 0.5, a: 0.15 + r() * 0.6 }));
  return { far, near, dust };
}

/** Where each old star rests: deeper the older it is, nudged apart so none sit on another. */
function place(stars: Star[], w: number, h: number, now: number): Body[] {
  const bodies: Body[] = [];
  for (const star of stars) {
    const f = fateOf(star, now);
    if (!f || f.fate === 'giant') continue;
    const r = rng(star.id);
    const z = Math.max(0, Math.min(1, Math.log(Math.max(1, f.days / 2)) / Math.log(45)));
    const filaments: Filament[] =
      f.fate === 'supernova'
        ? Array.from({ length: 54 }, () => ({
            angle: r() * Math.PI * 2,
            len: 0.45 + r() * 0.6,
            bends: [
              [0.35, (r() - 0.5) * 0.4],
              [0.7, (r() - 0.5) * 0.5],
            ],
            color: ['255,90,60', '255,170,100', '110,210,220', '255,120,150'][Math.floor(r() * 4)],
          }))
        : [];
    bodies.push({ star, fate: f.fate, k: f.k, days: f.days, z, u: 0, v: 0, seed: r(), tilt: r() * Math.PI, squash: 0.6 + r() * 0.35, bipolar: r() > 0.55, filaments });
  }
  // Newest on the right, nearest the galaxy they came from; older ones drift left along the cloud.
  const byAge = [...bodies].sort((a, b) => a.days - b.days);
  byAge.forEach((b, i) => {
    const t = byAge.length > 1 ? i / (byAge.length - 1) : 0.5;
    b.u = 0.86 - t * 0.66 + (b.seed - 0.5) * 0.06;
    b.v = 0.6 - (b.u - 0.5) * 0.3 + Math.sin(i * 2.4 + b.seed * 3) * 0.13;
  });
  // Nudge apart (in pixels, front stars need more room).
  for (let it = 0; it < 60; it++) {
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        const need = 130 * (1.15 - 0.3 * (a.z + b.z));
        const dx = (b.u - a.u) * w;
        const dy = (b.v - a.v) * h;
        const d = Math.hypot(dx, dy) || 1;
        if (d >= need) continue;
        const push = (need - d) / 2 / d;
        a.u -= (dx * push) / w;
        a.v -= (dy * push) / h;
        b.u += (dx * push) / w;
        b.v += (dy * push) / h;
      }
    }
    for (const b of bodies) {
      b.u = Math.max(0.08, Math.min(0.92, b.u));
      // Clear of the title (top left) and the life line (bottom).
      b.v = Math.max(b.u < 0.32 ? 0.42 : 0.2, Math.min(1 - 130 / h, b.v));
    }
  }
  // Deepest first, so nearer ones draw over them.
  return bodies.sort((a, b) => b.z - a.z);
}

const scaleOf = (z: number) => 1.35 - 0.6 * z;

function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rgb: string, a: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${rgb},${a})`);
  g.addColorStop(0.35, `rgba(${rgb},${a * 0.35})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** One old star, in the stage of dying it has reached. */
function drawBody(ctx: CanvasRenderingContext2D, b: Body, x: number, y: number, a: number, t: number) {
  const sc = scaleOf(b.z);
  const breathe = Math.sin(t / 1600 + b.seed * 9);
  switch (b.fate) {
    case 'planetary': {
      // A hot core blowing off its shells: teal inside, a rose rim, sometimes two lobes.
      const R = sc * (16 + 44 * b.k) * (1 + 0.025 * breathe);
      const fade = 1 - 0.35 * b.k;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(b.tilt + t / 90000);
      ctx.scale(1, b.squash);
      glow(ctx, 0, 0, R * 1.9, '255,110,150', 0.07 * a * fade);
      const g = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R * 1.08);
      g.addColorStop(0, 'rgba(110,230,235,0)');
      g.addColorStop(0.45, `rgba(110,230,235,${0.2 * a * fade})`);
      g.addColorStop(0.75, `rgba(160,200,255,${0.2 * a * fade})`);
      g.addColorStop(0.9, `rgba(255,110,140,${0.55 * a * fade})`);
      g.addColorStop(1, 'rgba(255,110,140,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, R * 1.08, 0, Math.PI * 2);
      ctx.fill();
      if (b.bipolar) {
        for (const side of [-1, 1]) {
          const lg = ctx.createRadialGradient(side * R * 0.95, 0, 0, side * R * 0.95, 0, R * 0.85);
          lg.addColorStop(0, `rgba(255,140,170,${0.05 * a * fade})`);
          lg.addColorStop(0.75, `rgba(255,120,160,${0.2 * a * fade})`);
          lg.addColorStop(1, 'rgba(255,120,160,0)');
          ctx.fillStyle = lg;
          ctx.beginPath();
          ctx.ellipse(side * R * 0.95, 0, R * 0.85, R * 0.6, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
      glow(ctx, x, y, sc * 9, '220,240,255', 0.8 * a);
      glow(ctx, x, y, sc * 2.2, '255,255,255', a);
      break;
    }
    case 'dwarf': {
      // What's left: a small blue-white core, the last of its shell a faint wisp.
      const R = sc * (52 + 30 * b.k);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(b.tilt);
      ctx.scale(1, b.squash);
      const g = ctx.createRadialGradient(0, 0, R * 0.55, 0, 0, R);
      g.addColorStop(0, 'rgba(140,180,255,0)');
      g.addColorStop(0.85, `rgba(150,190,255,${0.13 * a * (1 - 0.7 * b.k)})`);
      g.addColorStop(1, 'rgba(140,180,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      glow(ctx, x, y, sc * (18 + 3 * breathe), '190,215,255', 0.6 * a);
      glow(ctx, x, y, sc * 2.4, '245,250,255', a);
      break;
    }
    case 'ember': {
      // Nearly cold: a dim coal that flickers now and then.
      const flick = 0.8 + 0.2 * Math.sin(t / 700 + b.seed * 40) * Math.sin(t / 1900 + b.seed * 7);
      glow(ctx, x, y, sc * 22, '200,70,45', 0.22 * a * flick * (1 - 0.4 * b.k));
      glow(ctx, x, y, sc * 7, '255,120,80', 0.45 * a * flick * (1 - 0.3 * b.k));
      glow(ctx, x, y, sc * 2.6, '255,190,150', a * flick);
      break;
    }
    case 'supernova': {
      // It blew apart: torn filaments still spreading, a pulsar blinking at the heart.
      const R = sc * (30 + 52 * b.k);
      const fade = 1 - 0.45 * b.k;
      glow(ctx, x, y, R * 1.2, '255,80,60', 0.08 * a * fade);
      ctx.save();
      ctx.translate(x, y);
      ctx.lineWidth = Math.max(0.6, sc * 0.9);
      ctx.lineCap = 'round';
      for (const fl of b.filaments) {
        const c = Math.cos(fl.angle);
        const s = Math.sin(fl.angle);
        const L = R * fl.len;
        ctx.strokeStyle = `rgba(${fl.color},${0.32 * a * fade})`;
        ctx.beginPath();
        ctx.moveTo(c * L * 0.25, s * L * 0.25);
        for (const [at, off] of fl.bends) ctx.lineTo(c * L * at - s * L * off * 0.3, s * L * at + c * L * off * 0.3);
        ctx.lineTo(c * L, s * L);
        ctx.stroke();
      }
      // The pulsar's two beams sweep round; it blinks every turn.
      const spin = t / 900 + b.seed * 6;
      ctx.rotate(spin);
      const beam = ctx.createLinearGradient(-R * 0.7, 0, R * 0.7, 0);
      beam.addColorStop(0, 'rgba(180,220,255,0)');
      beam.addColorStop(0.5, `rgba(200,230,255,${0.35 * a})`);
      beam.addColorStop(1, 'rgba(180,220,255,0)');
      ctx.fillStyle = beam;
      ctx.fillRect(-R * 0.7, -0.6, R * 1.4, 1.2);
      ctx.restore();
      const blink = (t + b.seed * 900) % 900 < 110 ? 1 : 0.35;
      glow(ctx, x, y, sc * 8, '200,230,255', 0.6 * a * blink);
      glow(ctx, x, y, sc * 1.8, '255,255,255', a * blink);
      break;
    }
    case 'brown': {
      // Never fully lit: a dusky, banded little disc.
      const rad = sc * 4.2;
      glow(ctx, x, y, sc * 14, '170,60,90', 0.18 * a);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.clip();
      const g = ctx.createRadialGradient(x - rad * 0.3, y - rad * 0.3, 0, x, y, rad);
      g.addColorStop(0, `rgba(190,90,105,${a})`);
      g.addColorStop(1, `rgba(70,20,32,${a})`);
      ctx.fillStyle = g;
      ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      ctx.fillStyle = `rgba(40,10,20,${0.35 * a})`;
      ctx.fillRect(x - rad, y - rad * 0.25, rad * 2, rad * 0.18);
      ctx.fillRect(x - rad, y + rad * 0.3, rad * 2, rad * 0.12);
      ctx.restore();
      break;
    }
    case 'giant':
      break;
  }
}

interface Props {
  stars: Star[];
  /** On screen: the scene only animates while it is. */
  active: boolean;
  onOpen: (id: string, at: Point) => void;
}

export function Nebula({ stars, active, onOpen }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const els = useRef(new Map<string, HTMLButtonElement>());
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<Fate | null>(null);
  const live = useRef({ hover: null as string | null, focus: null as Fate | null, px: 0, py: 0, sx: 0, sy: 0 });
  live.current.hover = hover;
  live.current.focus = focus;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ages move slowly: re-place on a new set of stars, a new size, or every few minutes.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5 * 60_000);
    return () => clearInterval(t);
  }, []);
  const key = stars.map((s) => `${s.id}:${s.status}:${s.updated}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const bodies = useMemo(() => (size.w ? place(stars, size.w, size.h, Date.now()) : []), [key, size.w, size.h, tick]);
  const gas = useMemo(() => (size.w ? paintGas(size.w, size.h) : null), [size.w, size.h]);
  // The current's course: in from beyond the right edge, then each star from newest to oldest.
  const path = useMemo(() => {
    const byAge = [...bodies].sort((a, b) => a.days - b.days);
    return byAge.length ? [{ u: 1.04, v: byAge[0].v - 0.08 }, ...byAge.map((b) => ({ u: b.u, v: b.v + 0.02 })), { u: -0.04, v: byAge[byAge.length - 1].v + 0.06 }] : [];
  }, [bodies]);
  const giants = stars.filter((s) => fateOf(s)?.fate === 'giant').length;
  const counts = useMemo(() => {
    const c: Record<Fate, number> = { giant: giants, planetary: 0, dwarf: 0, ember: 0, supernova: 0, brown: 0 };
    for (const b of bodies) c[b.fate]++;
    return c;
  }, [bodies, giants]);

  // The scene, frame by frame, while it's on screen.
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !gas || !active) return;
    const { w, h } = size;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d')!;
    const opened = performance.now();
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let last = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.documentElement.classList.contains('still') && now - last < 120) return;
      last = now;
      const t = calm ? 0 : now;
      const L = live.current;
      // The pointer leans the camera; eased so it glides.
      L.sx += (L.px - L.sx) * 0.05;
      L.sy += (L.py - L.sy) * 0.05;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // Flying in: the cloud opens up from slightly closer.
      const fly = Math.min(1, (now - opened) / 1600);
      const ease = 1 - Math.pow(1 - fly, 3);
      const zoom = 1.12 - 0.12 * ease;

      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(zoom, zoom);
      ctx.translate(-w / 2, -h / 2);

      // Background stars, far behind everything.
      for (const d of gas.dust) {
        const tw = d.a * (0.75 + 0.25 * Math.sin(t / 900 + d.x * 80));
        ctx.fillStyle = `rgba(230,236,255,${tw * 0.7})`;
        ctx.fillRect(d.x * w - L.sx * 3, d.y * h - L.sy * 3, d.r, d.r);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.globalCompositeOperation = 'lighter';
      const drift = Math.sin(t / 40000) * 14;
      ctx.drawImage(gas.far, -30 + drift - L.sx * 8, -20 - L.sy * 6, w + 60, h + 40);

      const seen = (b: Body) => (L.focus && b.fate !== L.focus ? 0.18 : 1) * (L.hover && b.star.id !== L.hover ? 0.75 : 1);
      const at = (b: Body) => {
        const p = 1 - b.z;
        return { x: b.u * w - L.sx * (6 + 22 * p), y: b.v * h - L.sy * (4 + 14 * p) };
      };
      const show = (b: Body, i: number) => {
        // Each star fades in as the camera arrives, deep ones last.
        const enter = Math.max(0, Math.min(1, (now - opened - 300 - i * 70) / 900));
        const a = enter * (1 - 0.4 * b.z) * seen(b);
        const { x, y } = at(b);
        drawBody(ctx, b, x, y, a, t);
      };
      // The current: motes drifting in from the galaxy (off the right) and on past each star, newest to oldest.
      if (path.length > 1) {
        for (let m = 0; m < 46; m++) {
          const f = (m / 46 + t / 90000) % 1;
          const seg = f * (path.length - 1);
          const i = Math.floor(seg);
          const p0 = path[i];
          const p1 = path[Math.min(path.length - 1, i + 1)];
          const e = seg - i;
          const wob = Math.sin(m * 7.3 + t / 2400) * 10;
          const x = (p0.u + (p1.u - p0.u) * e) * w - L.sx * 12;
          const y = (p0.v + (p1.v - p0.v) * e) * h + wob - L.sy * 8;
          const a = 0.35 * Math.sin(f * Math.PI) * Math.min(1, (now - opened) / 1500);
          glow(ctx, x, y, 3.2, '220,225,255', a);
        }
      }
      // Deep stars sit behind the near gas; front ones in front of it.
      bodies.forEach((b, i) => b.z >= 0.5 && show(b, i));
      ctx.drawImage(gas.near, -40 - drift * 1.6 - L.sx * 16, -24 - L.sy * 11, w + 80, h + 48);
      bodies.forEach((b, i) => b.z < 0.5 && show(b, i));
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();

      // Buttons and labels ride with their stars (through the same zoom).
      for (const b of bodies) {
        const el = els.current.get(b.star.id);
        if (!el) continue;
        const { x, y } = at(b);
        const X = w / 2 + (x - w / 2) * zoom;
        const Y = h / 2 + (y - h / 2) * zoom;
        el.style.transform = `translate3d(${X.toFixed(1)}px, ${Y.toFixed(1)}px, 0) translate(-50%, -22px)`;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [gas, bodies, path, active, size]);

  const hovered = bodies.find((b) => b.star.id === hover);
  const hoveredEl = hover ? els.current.get(hover) : undefined;
  const oldest = bodies.reduce((m, b) => Math.max(m, b.days), 0);

  return (
    <div
      ref={box}
      className="nebula-scene"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        live.current.px = ((e.clientX - r.left) / r.width) * 2 - 1;
        live.current.py = ((e.clientY - r.top) / r.height) * 2 - 1;
      }}
      onPointerLeave={() => ((live.current.px = 0), (live.current.py = 0))}
    >
      <canvas ref={canvas} className="nebula-canvas" aria-hidden />

      <div className="nebula-title">
        <span className="display">The Nebula</span>
        <span className="mono">
          {bodies.length ? `${bodies.length} resting · the oldest ${Math.floor(oldest)} d` : 'Nothing has burned out yet'}
        </span>
        <p>Two days after a star finishes, it leaves the sky and drifts in here to die the way real stars do. The older it is, the deeper it sits in the cloud.</p>
      </div>

      {bodies.map((b) => (
        <button
          key={b.star.id}
          ref={(el) => {
            if (el) els.current.set(b.star.id, el);
            else els.current.delete(b.star.id);
          }}
          className={`nebula-star${hover === b.star.id ? ' on' : ''}${focus && focus !== b.fate ? ' dim' : ''}`}
          style={{ opacity: 1 - 0.25 * b.z }}
          onPointerEnter={() => setHover(b.star.id)}
          onPointerLeave={() => setHover((h) => (h === b.star.id ? null : h))}
          onFocus={() => setHover(b.star.id)}
          onBlur={() => setHover((h) => (h === b.star.id ? null : h))}
          onClick={(e) => onOpen(b.star.id, { x: e.clientX, y: e.clientY })}
          aria-label={`${b.star.title}: ${FATE[b.fate].name}, finished ${ago(b.star.updated)}`}
        >
          <span className="nebula-hit" aria-hidden />
          <span className="name">{b.star.title}</span>
          <span className="mono" style={{ color: TAG[b.fate] }}>{FATE[b.fate].name}</span>
        </button>
      ))}

      {hovered && hoveredEl && (
        <aside className="nebula-card" style={cardAt(hoveredEl, box.current)}>
          <span className="mono" style={{ color: TAG[hovered.fate] }}>{FATE[hovered.fate].name} · {FATE[hovered.fate].says}</span>
          <strong>{hovered.star.title}</strong>
          <p>{plain(hovered.star.result ?? hovered.star.error ?? hovered.star.now, 170)}</p>
          <span className="mono nebula-card-foot">Finished {ago(hovered.star.updated)} · {ENGINE_NAME[hovered.star.engine]} · click to open</span>
        </aside>
      )}

      {/* The life line: how a star ends, and how many are at each stage. Hover one to find them. */}
      <nav className="nebula-life" aria-label="Stages">
        <div className="life-line">
          {LIFE.map((f, i) => (
            <span key={f} style={{ display: 'contents' }}>
              {i > 0 && <span className="life-arrow" aria-hidden />}
              <button className={`life-stage f-${f}${focus === f ? ' on' : ''}`} disabled={f === 'giant'} onPointerEnter={() => setFocus(f)} onPointerLeave={() => setFocus(null)} onFocus={() => setFocus(f)} onBlur={() => setFocus(null)}>
                <span className="life-icon" aria-hidden />
                <span className="mono">{FATE[f].name}</span>
                <span className="life-n">{counts[f]}</span>
                {f === 'giant' && <span className="mono life-where">in the sky</span>}
              </button>
            </span>
          ))}
        </div>
        <div className="life-line other">
          {OTHER.map((f) => (
            <button key={f} className={`life-stage f-${f}${focus === f ? ' on' : ''}`} onPointerEnter={() => setFocus(f)} onPointerLeave={() => setFocus(null)} onFocus={() => setFocus(f)} onBlur={() => setFocus(null)}>
              <span className="life-icon" aria-hidden />
              <span className="mono">{FATE[f].name}</span>
              <span className="life-n">{counts[f]}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

/** The hover card sits beside its star, on whichever side has room. */
function cardAt(el: HTMLElement, box: HTMLElement | null): React.CSSProperties {
  const r = el.getBoundingClientRect();
  const b = box?.getBoundingClientRect();
  if (!b) return {};
  const x = r.left - b.left + r.width / 2;
  const y = r.top - b.top;
  const right = x < b.width - 340;
  return { left: right ? x + 60 : undefined, right: right ? undefined : b.width - x + 60, top: Math.max(12, Math.min(b.height - 200, y - 70)) };
}
