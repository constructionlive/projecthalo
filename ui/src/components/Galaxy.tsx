// Halo's sky as a galaxy: Halo at the centre, every star orbiting it on a
// tilted plane. Distance from Halo says what a star is doing: working close
// in, waiting on the person further out, finished on the outer ring. A new
// star is born at Halo's core and flies out to its orbit, then flares. Finished
// stars age: a few hours on they swell into dim red giants, and after two days
// they leave the sky for the Nebula, through its cloud on the galaxy's rim.
//
// The orbit is projected here (an ellipse, nearer stars a little larger and
// in front, farther ones passing behind Halo) and written straight to each
// star's style every frame: no re-renders, no 3D CSS (WebKit flattens nested
// 3D), and labels always upright and sharp.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { ageOf, colorOf, orbitStars, tagOf } from '../lib/stars';
import type { Star } from '../lib/types';

/** Seconds per revolution; how far the plane leans back (1 = seen from above). */
const TURN = 420;
const LEAN = 0.42;
const RING: Record<Star['status'], number> = { forming: 0.4, working: 0.5, needsYou: 0.66, landed: 0.86, failed: 0.86, stopped: 0.86 };
const RINGS = [0.4, 0.5, 0.66, 0.86];

/** A star's place on its ring, from its id: stable however many stars come and go. */
function angleOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (((h >>> 0) % 3600) / 3600) * Math.PI * 2;
}

interface Body {
  /** Current radius as a fraction of R (eases toward the ring for its status). */
  r: number;
  target: number;
  angle: number;
  born: number | null;
  flared: boolean;
}

/** Where a click landed, in page pixels: the camera zooms in from there. */
export interface Point {
  x: number;
  y: number;
}

interface Props {
  stars: Star[];
  selected: string | null;
  busy: boolean;
  /** The mic is on (Halo is hearing the person). */
  hearing?: boolean;
  onSelect: (id: string | null, at?: Point) => void;
  /** Old stars gone to the Nebula; its cloud on the rim flies you in. */
  remnants?: number;
  onRemnants?: (at: Point) => void;
}

export function Galaxy({ stars, selected, busy, hearing = false, onSelect, remnants = 0, onRemnants }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const els = useRef(new Map<string, HTMLButtonElement>());
  const bodies = useRef(new Map<string, Body>());
  const first = useRef(true);
  const [birth, setBirth] = useState(0);
  // The orbit slows to a stop under the pointer, so a star is easy to click.
  const hover = useRef(false);
  const shown = orbitStars(stars);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep a body per star: new ones start at the core (unless they were there when the sky opened).
  useEffect(() => {
    // Until the stars have loaded, nothing counts as newborn.
    if (first.current && shown.length === 0) return;
    const now = performance.now();
    let newborn = false;
    for (const s of shown) {
      const b = bodies.current.get(s.id);
      if (b) b.target = RING[s.status];
      else {
        const fresh = !first.current;
        bodies.current.set(s.id, { r: fresh ? 0 : RING[s.status], target: RING[s.status], angle: angleOf(s.id), born: fresh ? now : null, flared: !fresh });
        newborn ||= fresh;
      }
    }
    first.current = false;
    if (newborn) setBirth((n) => n + 1);
  });

  // The orbit, frame by frame.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let speed = 1;
    let turnAt = 0;
    const R = w / 2;
    const cx = w / 2;
    const cy = w * 0.4;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      // In the background: a few frames a second is plenty.
      if (document.documentElement.classList.contains('still') && t - last < 120) return;
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      speed += ((hover.current ? 0 : 1) - speed) * Math.min(1, dt * 3);
      turnAt = (turnAt + (dt * speed) / TURN) % 1;
      const turn = turnAt;
      for (const [id, el] of els.current) {
        const b = bodies.current.get(id);
        if (!b) continue;
        // Ease out to the ring: a fast launch that settles softly.
        b.r += (b.target - b.r) * Math.min(1, dt * (b.born !== null && t - b.born < 2400 ? 1.9 : 1.2));
        if (!b.flared && Math.abs(b.target - b.r) < 0.02) {
          b.flared = true;
          el.classList.add('nova');
          setTimeout(() => el.classList.remove('nova'), 1400);
        }
        const a = b.angle + turn * Math.PI * 2;
        const depth = Math.sin(a); // -1 far side … 1 near side
        const x = cx + Math.cos(a) * b.r * R;
        const y = cy + depth * b.r * R * LEAN;
        const scale = (0.82 + 0.18 * (depth + 1) / 2) * (b.born !== null ? Math.min(1, 0.25 + (t - b.born) / 1200) : 1);
        el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -14px) scale(${scale.toFixed(3)})`;
        el.style.zIndex = String(depth < 0 ? 10 + Math.round((depth + 1) * 10) : 30 + Math.round(depth * 10));
        el.style.opacity = String(b.born !== null && t - b.born < 400 ? (t - b.born) / 400 : 0.72 + 0.28 * (depth + 1) / 2);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [w]);

  const R = w / 2;
  const h = w * 0.8;
  const cy = w * 0.4;

  return (
    <div ref={box} className="galaxy" style={{ height: h }} onPointerEnter={() => (hover.current = true)} onPointerLeave={() => (hover.current = false)}>
      <svg className="galaxy-rings" width={w} height={h} aria-hidden>
        <defs>
          <radialGradient id="g-disc" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(150,180,240,0.10)" />
            <stop offset="60%" stopColor="rgba(120,150,220,0.03)" />
            <stop offset="100%" stopColor="rgba(120,150,220,0)" />
          </radialGradient>
        </defs>
        <ellipse cx={R} cy={cy} rx={R * 0.94} ry={R * 0.94 * LEAN} fill="url(#g-disc)" />
        {RINGS.map((f) => (
          <ellipse key={f} cx={R} cy={cy} rx={R * f} ry={R * f * LEAN} fill="none" stroke="rgba(238,235,227,0.12)" strokeWidth={1} strokeDasharray={f === 0.86 ? '2 5' : undefined} />
        ))}
        {Array.from({ length: 120 }, (_, i) => {
          const a = (i / 120) * Math.PI * 2;
          const major = i % 10 === 0;
          const r1 = R * 0.94;
          const r2 = R * (major ? 0.9 : 0.92);
          return <line key={i} x1={R + Math.cos(a) * r1} y1={cy + Math.sin(a) * r1 * LEAN} x2={R + Math.cos(a) * r2} y2={cy + Math.sin(a) * r2 * LEAN} stroke={major ? 'rgba(238,235,227,0.6)' : 'rgba(238,235,227,0.22)'} strokeWidth={major ? 1.4 : 1} />;
        })}
      </svg>

      <button key={birth} className={`core-btn${busy ? ' busy' : ''}${birth ? ' birthing' : ''}`} onClick={() => onSelect(null)} aria-label={`Halo, ${busy ? 'thinking' : 'ready'}: open the thread`} style={{ left: R, top: cy, width: w * 0.3, height: w * 0.3, zIndex: 20 }}>
        <span className="corona" aria-hidden />
        <span className="spike" style={{ width: '180%', transform: 'translate(-50%, -50%) rotate(0deg)' }} aria-hidden />
        <span className="spike" style={{ width: '150%', transform: 'translate(-50%, -50%) rotate(60deg)' }} aria-hidden />
        <span className="spike" style={{ width: '150%', transform: 'translate(-50%, -50%) rotate(120deg)' }} aria-hidden />
        <span className="spike" style={{ width: '70%', opacity: 0.55, transform: 'translate(-50%, -50%) rotate(90deg)' }} aria-hidden />
        <span className="nucleus" aria-hidden />
        <span className="birth-ring" aria-hidden />
      </button>

      {shown.map((s) => (
        <button
          key={s.id}
          ref={(el) => {
            if (el) els.current.set(s.id, el);
            else els.current.delete(s.id);
          }}
          className={`star orbiting s-${s.status}${ageOf(s) === 'cooling' ? ' giant' : ''}${selected === s.id ? ' sel' : ''}`}
          onClick={(e) => {
            const g = e.currentTarget.querySelector('.glyph')?.getBoundingClientRect();
            onSelect(s.id, g ? { x: g.left + g.width / 2, y: g.top + g.height / 2 } : { x: e.clientX, y: e.clientY });
          }}
          aria-label={`${s.title}, ${tagOf(s)}`}
          style={{ opacity: 0 }}
        >
          <span className="glyph" aria-hidden>
            <span className="halo-ring" />
            <span className="core" />
            <span className="flare" />
          </span>
          <span className="label">
            <span className="name">{s.title}</span>
            <span className="mono tag" style={{ color: colorOf(s) }}>{tagOf(s)}</span>
          </span>
        </button>
      ))}

      {remnants > 0 && (
        // The Nebula's cloud on the near rim, where old stars end up.
        <button className="remnant-belt" onClick={(e) => onRemnants?.({ x: e.clientX, y: e.clientY })} aria-label={`The Nebula: ${remnants} old stars`} style={{ left: R + Math.cos(0.5) * R * 0.92, top: cy + Math.sin(0.5) * R * 0.92 * LEAN }}>
          <span className="nebula" aria-hidden>
            {Array.from({ length: Math.min(remnants, 9) }, (_, i) => (
              <span key={i} className="dwarf" style={{ left: `${18 + ((i * 37) % 64)}%`, top: `${26 + ((i * 53) % 48)}%` }} />
            ))}
          </span>
          <span className="mono">Nebula <span className="num">{remnants}</span></span>
        </button>
      )}

      <div className="mono" aria-hidden style={{ position: 'absolute', left: '50%', bottom: 4, transform: 'translateX(-50%)', fontSize: 9, color: 'var(--muted)', whiteSpace: 'nowrap', display: 'flex', gap: 8, alignItems: 'center' }}>
        Halo <span className="sep">·</span> <span style={{ color: hearing ? 'var(--signal)' : busy ? 'var(--star)' : undefined }}>{hearing ? 'hearing you' : busy ? 'thinking' : 'ready'}</span>
        {(busy || hearing) && <span className="blink" style={{ width: 6, height: 10, background: hearing ? 'var(--signal)' : 'var(--star)' }} />}
      </div>
    </div>
  );
}
