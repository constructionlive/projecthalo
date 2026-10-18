// Race mode: drive one agent's car round the bay circuit while the agent
// works. Its own world (race.ts) under a broadcast HUD: lap and splits, the
// map, the race order, the agent's latest line, calls from cars that need
// you, speed and thrusters. Esc hands the car back.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { plain } from '../components/Md';
import { api } from '../lib/api';
import type { Star } from '../lib/types';
import { KIND_OF } from './car';
import { RaceScene, type RaceStatus } from './race';
import { ago } from '../lib/useHalo';

const fmt = (t: number | null) => {
  if (t === null) return '–:––.–––';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
};

export function RaceMode({ star, stars, num, day, onExit }: { star: Star; stars: Star[]; num: Map<string, string>; day: boolean; onExit: (open?: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<RaceScene | null>(null);
  const [st, setSt] = useState<RaceStatus | null>(null);
  const [outline, setOutline] = useState<[number, number][]>([]);
  const [radio, setRadio] = useState<Star | null>(null);
  const [text, setText] = useState('');
  const radioInput = useRef<HTMLInputElement>(null);

  // The rivals are the other cars still working, fixed for this run.
  const [rivals] = useState(() => stars.filter((s) => s.status === 'working' && s.id !== star.id).slice(0, 7));

  useLayoutEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const s = new RaceScene(cv, KIND_OF[star.engine], rivals.map((r) => ({ id: r.id, kind: KIND_OF[r.engine], label: r.title })), day);
    scene.current = s;
    if (location.search.includes('test')) (window as unknown as { race: RaceScene }).race = s;
    setOutline(s.outline());
    const ro = new ResizeObserver(() => s.resize());
    ro.observe(cv);
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last > 60) {
        last = t;
        setSt(s.status());
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      s.dispose();
      scene.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Calls: any car that needs you.
  const calls = stars.filter((s) => s.status === 'needsYou' && s.id !== star.id);
  const mine = stars.find((s) => s.id === star.id) ?? star;

  useEffect(() => {
    const KEY: Record<string, 'up' | 'down' | 'left' | 'right'> = { ArrowUp: 'up', w: 'up', ArrowDown: 'down', s: 'down', ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right' };
    const down = (e: KeyboardEvent) => {
      if (document.activeElement?.id === 'race-pit') return;
      if (radio) {
        if (e.key === 'Escape') (e.stopPropagation(), setRadio(null));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onExit();
        return;
      }
      if ((e.key === 'r' || e.key === 'R') && calls.length) {
        e.preventDefault();
        setRadio(calls[0]);
        setTimeout(() => radioInput.current?.focus(), 30);
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        scene.current?.thrust();
        return;
      }
      const k = KEY[e.key];
      if (k) {
        e.preventDefault();
        scene.current?.setKeys({ [k]: true });
      }
    };
    const up = (e: KeyboardEvent) => {
      const k = KEY[e.key];
      if (k) scene.current?.setKeys({ [k]: false });
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [radio, calls, onExit]);

  // Map: fit the outline to the box.
  const box = { w: 220, h: 110 };
  const xs = outline.map((p) => p[0]);
  const zs = outline.map((p) => p[1]);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const k = outline.length ? Math.min((box.w - 16) / (maxX - minX), (box.h - 16) / (maxZ - minZ)) : 1;
  const mp = (x: number, z: number) => [8 + (x - minX) * k, 8 + (z - minZ) * k];
  const path = outline.map((p, i) => `${i ? 'L' : 'M'}${mp(p[0], p[1]).join(' ')}`).join(' ') + ' Z';

  // Race order by distance run.
  const order = st
    ? [{ id: star.id, you: true, progress: st.progress }, ...st.rivals.map((r) => ({ id: r.id, you: false, progress: r.progress }))].sort((a, b) => b.progress - a.progress)
    : [];
  const title = (id: string) => stars.find((s) => s.id === id)?.title ?? '';

  const finished = mine.status === 'landed' || mine.status === 'failed' || mine.status === 'stopped';
  // Your own car's agent needs you: the car pits itself; answer there and it rejoins.
  const boxing = mine.status === 'needsYou';
  const [pitText, setPitText] = useState('');
  const pitInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    scene.current?.pit(boxing);
  }, [boxing]);
  useEffect(() => {
    if (st?.pitStopped) pitInput.current?.focus();
  }, [st?.pitStopped]);

  return (
    <div className="race">
      <canvas ref={canvas} className="race-world" aria-label={`Driving ${star.title} round the bay circuit`} />

      {st && (
        <>
          <div className="race-lap">
            <span className="mono">Lap</span>
            <span className="display">{st.lap}</span>
            <span className="mono t">{fmt(st.lapTime)}</span>
            <span className="mono best">Best {fmt(st.best)}</span>
            {st.split !== null && <span className={`mono split ${st.split > 0 ? 'slow' : 'fast'}`}>{st.split > 0 ? '+' : '−'}{Math.abs(st.split).toFixed(2)}</span>}
          </div>

          <div className="race-map" aria-hidden>
            <svg width={box.w} height={box.h}>
              <path d={path} />
              {st.rivals.map((r) => {
                const [x, y] = mp(r.x, r.z);
                return <circle key={r.id} cx={x} cy={y} r={3.5} className="rival" />;
              })}
              {(() => {
                const [x, y] = mp(st.you.x, st.you.z);
                return <circle cx={x} cy={y} r={5} className="you" />;
              })()}
            </svg>
          </div>

          <div className="race-side">
          <aside className="race-order" aria-label="Race order">
            {order.map((o, i) => (
              <div key={o.id} className={`race-row${o.you ? ' you' : ''}`}>
                <span className="mono pos">{i + 1}</span>
                <span className="mono num">{num.get(o.id)}</span>
                <span className="name">{o.you ? <><strong>You</strong> · {title(o.id)}</> : title(o.id)}</span>
              </div>
            ))}
          </aside>
          <RaceFeed star={mine} num={num.get(mine.id) ?? ''} />
          </div>

          <div className="race-calls">
            <div className="race-agent">
              <span className="mono">Your car’s agent · {mine.status === 'working' ? 'still working' : mine.status === 'needsYou' ? 'needs you' : 'finished'}</span>
              <p>{plain(mine.status === 'needsYou' ? mine.question ?? mine.now : mine.now, 110)}</p>
            </div>
            {calls.slice(0, 2).map((c) => (
              <div key={c.id} className="race-call">
                <span className="mono">#{num.get(c.id)} {c.title} · box box · needs you</span>
                <p>{plain(c.question ?? c.now, 90)} <span className="mono hint">R to radio back · keeps you racing</span></p>
              </div>
            ))}
          </div>

          <div className="race-speed">
            <span className="display">{Math.round(st.speed)}</span>
            <span className="mono">km/h</span>
            <div className="cells" aria-label={`${st.cells} thruster cells`}>
              <span className="mono">Thrusters</span>
              {Array.from({ length: 4 }, (_, i) => (
                <span key={i} className={`cell${i < st.cells ? ' on' : ''}`} style={i === st.cells ? { background: `linear-gradient(90deg, var(--go) ${st.cellCharge * 100}%, rgba(88,216,255,.2) ${st.cellCharge * 100}%)` } : undefined} />
              ))}
            </div>
          </div>

          <div className="mono race-keys">↑↓ throttle · ←→ steer · space thrusters · R radio · esc hand back</div>

          {st.phase === 'countdown' && (
            <div className="race-lights" aria-live="polite">
              {Array.from({ length: 5 }, (_, i) => (
                <span key={i} className={i < st.lights ? 'on' : ''} />
              ))}
            </div>
          )}
        </>
      )}

      {radio && (
        <form
          className="race-radio"
          onSubmit={async (e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t) return;
            setText('');
            setRadio(null);
            await api.tell(radio.id, t);
          }}
        >
          <span className="mono">Radio #{num.get(radio.id)} {radio.title}</span>
          <p>{plain(radio.question ?? radio.now, 160)}</p>
          <label className="sr" htmlFor="race-radio">Answer {radio.title}</label>
          <input ref={radioInput} id="race-radio" value={text} onChange={(e) => setText(e.target.value)} placeholder="Answer, Enter to send · Esc to keep racing" autoComplete="off" />
        </form>
      )}

      {boxing && st && !st.pitStopped && (
        <div className="race-boxing" aria-live="polite">
          <span className="mono">Box box · your car</span>
          <span className="display">Pitting</span>
          <span className="mono hint">Its agent needs you. The car is taking itself into the box.</span>
        </div>
      )}
      {boxing && st?.pitStopped && (
        <form
          className="race-radio race-pitstop"
          onSubmit={async (e) => {
            e.preventDefault();
            const t = pitText.trim();
            if (!t) return;
            setPitText('');
            await api.tell(mine.id, t);
          }}
        >
          <span className="mono">In the box · #{num.get(mine.id)} {mine.title} needs you</span>
          <p>{plain(mine.question ?? mine.now, 220)}</p>
          <label className="sr" htmlFor="race-pit">Answer {mine.title}</label>
          <input ref={pitInput} id="race-pit" value={pitText} onChange={(e) => setPitText(e.target.value)} placeholder="Answer, Enter to send and rejoin" autoComplete="off" />
        </form>
      )}

      {finished && st && (
        <div className="race-flag" role="dialog" aria-label="Run finished">
          <span className="chequer" aria-hidden />
          <span className="display">Chequered flag</span>
          <p>{star.title} {mine.status === 'landed' ? 'crossed the line' : 'is out of the run'}. {st.laps.length ? `${st.laps.length} lap${st.laps.length > 1 ? 's' : ''}, best ${fmt(Math.min(...st.laps))}.` : 'No full laps this time.'}</p>
          <div className="race-flag-actions">
            <button className="btn solid" onClick={() => onExit(star.id)}>See what it brought back</button>
            <button className="btn" onClick={() => onExit()}>Back to the broadcast</button>
          </div>
        </div>
      )}
    </div>
  );
}

const FEED_LABEL: Record<string, string> = { said: 'Agent', tool: 'Tool', toolFailed: 'Tool failed', you: 'You', error: 'Error', note: 'Note' };

/** Your car's agent, live: what it says and does, newest at the bottom, following along. */
function RaceFeed({ star, num }: { star: Star; num: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  const entries = star.log.slice(-40);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [star.log.length, star.now]);
  return (
    <section className={`race-feed${open ? '' : ' shut'}`} aria-label={`${star.title}, live`}>
      <button className="race-feed-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="mono num">{num}</span>
        <span className="name">{star.title}</span>
        <span className={`mono live${star.status === 'working' ? ' on' : ''}`}>{star.status === 'working' ? 'Live' : star.status === 'needsYou' ? 'Needs you' : 'Done'}</span>
      </button>
      {open && (
        <div ref={box} className="race-feed-list">
          <div className="feed-row brief">
            <span className="mono">Brief</span>
            <p>{plain(star.goal, 200)}</p>
          </div>
          {entries.map((l, i) => (
            <div key={`${l.ts}-${i}`} className={`feed-row ${l.kind}`}>
              <span className="mono">{FEED_LABEL[l.kind] ?? l.kind} · {ago(l.ts)}</span>
              <p>{l.kind === 'said' ? plain(l.text, 360) : plain(l.text, 160)}</p>
            </div>
          ))}
          {star.status === 'working' && (
            <div className="feed-row now">
              <span className="mono"><span className="dot" /> Now</span>
              <p>{plain(star.now, 160)}</p>
            </div>
          )}
          {star.result && star.status !== 'working' && (
            <div className="feed-row result">
              <span className="mono">Result</span>
              <p>{plain(star.result, 400)}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
