// The Roadster theme, whole: night on the San Francisco waterfront.
//
// - The pier (home): the curl ramp and its ring of light (Halo), every star a
//   car running the stunt. Halo's words come up as broadcast captions; the
//   timing tower on the right lists every car; the ask line is team radio.
// - Team radio (the thread): the camera lifts into the sky over the bridge and
//   the whole conversation reads as radio traffic.
// - Onboard (a star): the camera drops in behind that car and rides with it;
//   its brief, its radio and its payload sit beside the shot.
//
// Esc, "← Arena" or the breadcrumb go back; pulling past the top of the radio
// log does too.

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { HotkeyChip } from '../components/HotkeyChip';
import { UpdateChip } from '../components/UpdateChip';
import { openWorkshop } from '../lib/themeChoice';
import { LightStar } from '../components/LightStar';
import { Settings, type SettingsWords } from '../components/Settings';
import { plain } from '../components/Md';
import { Mic } from '../components/Mic';
import { StarView } from '../components/StarView';
import { type Mark, ThreadView } from '../components/ThreadView';
import { api, inApp } from '../lib/api';
import { ENGINE_NAME, type Engine, type Star } from '../lib/types';
import type { useHalo } from '../lib/useHalo';
import type { Voice } from '../lib/useVoice';
import { KIND_OF } from './car';
import { Cutscene, CutscenePreload } from './Cutscene';
import { type CarState, type Key, RoadsterScene } from './scene';
import { RaceMode } from './RaceMode';
import type { PierCommand } from './Roadster';
import { TerminalCockpit, termFlag } from './TerminalCockpit';
import { PaddockZone, PitZone, TrackMap, type Zone, parked, racing, waiting } from './Zones';
import type { Terminal, Workspace } from '../lib/types';
import { chord, isMac, shortcut, SUMMON_KEY } from '../lib/keys';

/** How many finished cars stay parked on the course; the rest are in the paddock list. */
const PARKED_ON_COURSE = 4;

type View = { kind: 'pier' } | { kind: 'radio' } | { kind: 'onboard'; id: string } | { kind: 'terminal'; id: string };
type Halo = ReturnType<typeof useHalo>;

const KIND_NAME = { roadster: 'Roadster', gt: 'GT', formula: 'Formula', rosso: 'Rosso GT' } as const;
/** Which car each engine drives, for the launch panel. */
const CAR_OF: Record<Engine, string> = { claude: KIND_NAME[KIND_OF.claude], codex: KIND_NAME[KIND_OF.codex], opencode: KIND_NAME[KIND_OF.opencode] };

/** In this world the main thread is Launch Control; Halo is the galaxy's name. */
const NAME = 'Control';

const GARAGE_WORDS: SettingsWords = {
  title: 'Garage',
  note: 'Set once. Every car you launch, and Launch Control, runs this way until you change it here.',
  engine: 'Who drives',
  picked: 'driving',
  access: 'Permissions',
  workspace: ['Own lane', 'Files and shell in the car’s own folder. Nothing outside it, nothing asked.'],
  full: ['Open road', 'Anywhere on this Mac, no sandbox, nothing asked. Only for jobs you trust.'],
  theme: 'Theme',
  foot: 'Cars already out keep their engine; the next turn of every car uses these permissions.',
};
const LAUNCH_WORDS = { title: 'Launch', go: 'Launch', placeholder: 'What should the agent do? Be specific: files, commands, what done looks like.' };

/** Race-control words for where a car is. */
function flag(s: Star): { text: string; tone: 'go' | 'pit' | 'fin' | 'out' } {
  if (s.status === 'needsYou') return { text: 'Pit', tone: 'pit' };
  if (s.status === 'landed') return { text: 'Fin', tone: 'fin' };
  if (s.status === 'failed') return { text: 'DNF', tone: 'out' };
  if (s.status === 'stopped') return { text: 'Out', tone: 'out' };
  if (s.status === 'forming') return { text: 'Grid', tone: 'go' };
  if (s.stalled) return { text: 'Slow', tone: 'pit' };
  return { text: `Lap ${Math.max(1, s.turns)}`, tone: 'go' };
}

/** What a terminal's GT does in the scene: races while its shell runs something,
 *  parks in a bay at rest, retired (red) after a failure, dark once the shell ends. */
function termCar(t: Terminal): CarState {
  if (t.status === 'running') return 'working';
  if (t.status === 'exited') return 'stopped';
  if (t.last && t.last.exit !== 0 && t.last.exit !== 130) return 'failed';
  return 'landed';
}

/** Car numbers by launch order, stable for the session. */
function numbers(stars: Star[]): Map<string, string> {
  const m = new Map<string, string>();
  [...stars].sort((a, b) => a.created - b.created).forEach((s, i) => m.set(s.id, String(i + 1).padStart(2, '0')));
  return m;
}

/** Tower order: the pit first (they need the person), then on track, then finished. */
function towerOrder(stars: Star[]): Star[] {
  const rank = (s: Star) => (s.status === 'needsYou' ? 0 : s.status === 'working' || s.status === 'forming' ? 1 : 2);
  return [...stars].sort((a, b) => rank(a) - rank(b) || b.updated - a.updated);
}

function PitReply({ star, num, onOpen }: { star: Star; num: string; onOpen: () => void }) {
  const [answer, setAnswer] = useState('');
  return (
    <div className="pit-call">
      <button className="pit-q" onClick={onOpen}>
        <span className="mono">#{num} {star.title} · boxing</span>
        <span>{star.question ?? star.now}</span>
      </button>
      <form
        className="answer"
        onSubmit={async (e) => {
          e.preventDefault();
          const t = answer.trim();
          if (!t) return;
          setAnswer('');
          await api.tell(star.id, t);
        }}
      >
        <label className="sr" htmlFor={`pit-${star.id}`}>Answer {star.title}</label>
        <input id={`pit-${star.id}`} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Radio back…" />
        <button className="btn signal" type="submit" disabled={!answer.trim()}>Send</button>
      </form>
    </div>
  );
}

interface Props {
  halo: Halo;
  voice: Voice;
  draft: string;
  setDraft: (s: string) => void;
  now: string;
  switcher: ReactNode;
  /** The arena this pier is: a workspace (or, id null, the loose cars). */
  arena: { id: string | null; name: string; workspace: Workspace | null };
  /** The season is over it: stop drawing. */
  away: boolean;
  command: PierCommand | null;
  onSeason: () => void;
}

export function Pier({ halo, voice, draft, setDraft, now, switcher, arena, away, command, onSeason }: Props) {
  const { state, stars } = halo;
  const [view, setView] = useState<View>({ kind: 'pier' });
  const [zone, setZone] = useState<Zone>('course');
  // Race mode: the car you're driving.
  const [raceCar, setRaceCar] = useState<string | null>(null);
  useEffect(() => {
    if (scene.current) scene.current.paused = !!raceCar || away || view.kind === 'terminal';
  }, [raceCar, away, view.kind]);
  // Day or night: golden hour from 7 to 6, unless you pick.
  const [tod, setTod] = useState<'day' | 'night'>(() => {
    try {
      const t = localStorage.getItem('roadster-tod');
      if (t === 'day' || t === 'night') return t;
    } catch {
      /* fall through */
    }
    const h = new Date().getHours();
    return h >= 7 && h < 18 ? 'day' : 'night';
  });
  const [launching, setLaunching] = useState(false);
  const [garage, setGarage] = useState(false);
  // The Garage's engine, once picked there (until the next state catches up).
  const [engine, setEngine] = useState<Engine | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<RoadsterScene | null>(null);
  const labels = useRef(new Map<string, HTMLButtonElement>());
  const tree = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const speedEl = useRef<HTMLSpanElement>(null);
  // A launch cutscene playing, for this car.
  const [cut, setCut] = useState<string | null>(null);
  // The car you have your hands on (hovering it).
  const [driving, setDriving] = useState<string | null>(null);
  const [webgl, setWebgl] = useState(true);

  const num = numbers(stars);
  // On the course: everything still going, and only the latest few finished.
  const onCourse = [...stars.filter((x) => !parked(x)), ...stars.filter(parked).sort((a, b) => b.updated - a.updated).slice(0, PARKED_ON_COURSE)];
  const counts = { course: stars.filter(racing).length, pit: stars.filter(waiting).length, paddock: stars.filter(parked).length };
  const hearing = !!voice.status?.recording || voice.holding;
  const mood = hearing ? 'hearing' : state.busy ? 'thinking' : 'ready';

  // The world: made once, told about cars, mood and shot as they change.
  useLayoutEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    let s: RoadsterScene;
    try {
      s = new RoadsterScene(cv);
    } catch {
      setWebgl(false);
      return;
    }
    scene.current = s;
    // Tests read the cars' poses through this.
    if (import.meta.env.DEV || location.search.includes('test')) (window as unknown as { pier: RoadsterScene }).pier = s;
    const ro = new ResizeObserver(() => s.resize());
    ro.observe(cv);
    // Labels ride along with their cars.
    let raf = 0;
    const place = () => {
      raf = requestAnimationFrame(place);
      // Nothing moves while the scene is paused (the season or race mode is over it).
      if (s.paused) return;
      setCut((c) => (c === s.cutscene ? c : s.cutscene));
      // Plates stay out from behind the timing tower and the car card.
      const edge = document.querySelector('.tower, .zone-panel')?.getBoundingClientRect().left ?? Infinity;
      const card = document.querySelector('.car-card')?.getBoundingClientRect();
      // Nearest the bottom first; any plate that would sit on another lifts clear of it.
      const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
      // Launch Control's sign: a click target laid over it; plates keep clear of it.
      const sg = s.projectSign();
      if (tree.current && sg) {
        tree.current.style.transform = `translate3d(${(sg.x - sg.w / 2).toFixed(1)}px, ${(sg.y - sg.h / 2).toFixed(1)}px, 0)`;
        tree.current.style.width = `${sg.w.toFixed(0)}px`;
        tree.current.style.height = `${sg.h.toFixed(0)}px`;
        placed.push({ x0: sg.x - sg.w / 2, x1: sg.x + sg.w / 2, y0: sg.y - sg.h / 2, y1: sg.y + sg.h / 2 });
      }
      // The car in your hands: its card's stage and its speed.
      const slot = s.driving ? document.querySelector('.car-card .stage-slot')?.getBoundingClientRect() : undefined;
      s.setStage(slot ? { x: slot.left, y: slot.top, w: slot.width, h: slot.height } : null, s.driving);
      if (s.driving && speedEl.current) speedEl.current.textContent = String(Math.round(s.debug(s.driving)?.speed ?? 0));
      const spots = [...labels.current].map(([id, el]) => ({ el, p: s.project(id) })).sort((a, b) => (b.p?.y ?? 0) - (a.p?.y ?? 0));
      for (const { el, p } of spots) {
        const w = el.offsetWidth;
        const underCard = !!card && !!p && p.x - w / 2 < card.right + 4 && p.y - el.offsetHeight < card.bottom + 4 && p.y > card.top - 4;
        const shown = !!p && p.x + w / 2 < edge - 8 && p.x - w / 2 > 8 && !underCard;
        el.style.visibility = shown ? 'visible' : 'hidden';
        if (!p || !shown) continue;
        const h = el.offsetHeight + 3;
        let y = p.y;
        for (let tries = 0; tries < 8; tries++) {
          const hit = placed.find((r) => p.x - w / 2 < r.x1 && p.x + w / 2 > r.x0 && y - h < r.y1 && y > r.y0);
          if (!hit) break;
          y = hit.y0;
        }
        placed.push({ x0: p.x - w / 2, x1: p.x + w / 2, y0: y - h, y1: y });
        el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      }
      // Whatever covers the right of the shot (the tower): centre the shot in the rest. Onboard fills the screen, so nothing to dodge.
      const cover = document.querySelector('.pier:not([data-view="onboard"]) .tower, .pier:not([data-view="onboard"]) .zone-panel');
      const cr = cover?.getBoundingClientRect();
      const head = document.querySelector('.pier-top')?.getBoundingClientRect();
      const foot = document.querySelector('.pier[data-view="pier"] .captions')?.getBoundingClientRect() ?? document.querySelector('.pier-ask')?.getBoundingClientRect();
      // On a narrow window the tower sits along the bottom, not the side.
      const side = cr && cr.width > 0 && cr.width < cv.clientWidth * 0.6;
      const bottomEdge = Math.min(foot?.top ?? cv.clientHeight, side || !cr ? Infinity : cr.top);
      s.setInsets(side ? Math.max(0, cv.clientWidth - cr.left + 16) : 0, head?.bottom ?? 0, Math.max(0, cv.clientHeight - bottomEdge + 8));
    };
    raf = requestAnimationFrame(place);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      s.dispose();
      scene.current = null;
    };
  }, []);

  // Another arena's cars appear where they are; only new ones launch.
  const shownArena = useRef<string | null | undefined>(undefined);
  const [hasDay, setHasDay] = useState(true);
  useEffect(() => {
    if (shownArena.current !== undefined && shownArena.current !== arena.id) scene.current?.resetCars();
    if (scene.current) {
      scene.current.setArena(arena.workspace?.arena ?? 'bay');
      setHasDay(scene.current.hasDay);
    }
    shownArena.current = arena.id;
    // The agents' cars, and each terminal as a red GT that races while its shell runs something.
    const agents = onCourse.slice(0, 18).map((s) => ({ id: s.id, state: s.status as CarState, stalled: s.stalled, engine: s.engine }));
    const shells = terms.slice(0, 12).map((t) => ({ id: t.id, state: termCar(t), stalled: false, engine: 'claude' as const, kind: 'rosso' as const }));
    scene.current?.setCars([...agents, ...shells]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stars, arena.id, state.terminals]);
  useEffect(() => scene.current?.setMood(mood), [mood]);
  useEffect(() => {
    scene.current?.setTimeOfDay(tod);
    try {
      localStorage.setItem('roadster-tod', tod);
    } catch {
      /* not remembered */
    }
  }, [tod]);
  useEffect(() => {
    scene.current?.setShot(view.kind === 'onboard' ? { kind: 'onboard', id: view.id } : view.kind === 'radio' ? { kind: 'radio' } : zone === 'paddock' ? { kind: 'paddock' } : zone === 'pit' ? { kind: 'pit' } : { kind: 'wide' });
  }, [view, zone]);

  const home = useCallback(() => setView({ kind: 'pier' }), []);
  // A new arena starts on its course, with nobody in a car.
  useEffect(() => {
    setView({ kind: 'pier' });
    setZone('course');
    setRaceCar(null);
  }, [arena.id]);
  // What the season asked for on the way here.
  useEffect(() => {
    if (!command) return;
    if (command.kind === 'launch') {
      setView({ kind: 'pier' });
      setLaunching(true);
    } else setView({ kind: 'radio' });
  }, [command]);
  const onboard = useCallback((id: string) => {
    setView({ kind: 'onboard', id });
    setTimeout(() => input.current?.focus(), 400);
  }, []);

  // Terminal cars: this arena's shells, numbered by when they were opened.
  const terms = [...state.terminals].sort((a, b) => a.created - b.created);
  // A car keeps its number for life: closing T2 doesn't make T3 the new T2.
  const termNums = useRef(new Map<string, number>());
  const lastNum = useRef(new Map<string, number>());
  const arenaKey = arena.id ?? '';
  for (const t of terms) {
    if (termNums.current.has(t.id)) continue;
    const n = (lastNum.current.get(arenaKey) ?? 0) + 1;
    lastNum.current.set(arenaKey, n);
    termNums.current.set(t.id, n);
  }
  const tnum = new Map(terms.map((t) => [t.id, `T${termNums.current.get(t.id)}`]));
  const [termError, setTermError] = useState<string | null>(null);
  const newTerminal = useCallback(async () => {
    setTermError(null);
    try {
      // About the size the cockpit's screen will be; it fits itself once open.
      const t = await api.terminalOpen(120, 32, arena.id ?? 'none');
      setView({ kind: 'terminal', id: t.id });
    } catch (e) {
      setTermError(String(e));
    }
  }, [arena.id]);
  const askAbout = useCallback(
    (t: (typeof terms)[number]) => {
      const what = t.last ? `\`${t.last.command}\` exited ${t.last.exit}` : t.command ? `it is running \`${t.command}\`` : 'it';
      halo.ask(`Look at my terminal ${t.id} in ${t.cwd} (${what}). What went wrong, and what should I do?`);
      setView({ kind: 'radio' });
    },
    [halo],
  );

  useEffect(() => {
    const off = api.on<string>('select-star', (id) => onboard(id));
    const keys = (e: KeyboardEvent) => {
      if (raceCar) return;
      // Onboard a terminal car every key is the shell's, Esc too.
      if (e.key === 'Escape' && view.kind !== 'pier' && view.kind !== 'terminal' && !launching && !garage) home();
      const c = chord(e);
      if (c?.key === 't' && !c.shift && view.kind !== 'terminal' && !away) {
        e.preventDefault();
        newTerminal();
      }
    };
    // Hands on a car: arrows and space drive it, unless you're typing something.
    const KEY: Record<string, Key> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', ' ': 'action' };
    const drive = (e: KeyboardEvent) => {
      if (raceCar) return;
      const s = scene.current;
      // D: get in the car under your pointer and race it.
      if ((e.key === 'd' || e.key === 'D') && e.type === 'keydown' && s?.driving && view.kind === 'pier' && !(document.activeElement instanceof HTMLInputElement && document.activeElement.value)) {
        const st = stars.find((x) => x.id === s.driving);
        if (st?.status === 'working') {
          e.preventDefault();
          setRaceCar(st.id);
          return;
        }
      }
      const k = KEY[e.key];
      if (!k || !s?.driving || view.kind !== 'pier' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLInputElement | null;
      const typing = !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.value !== ''));
      if (typing) return;
      if (s.press(k, e.type === 'keydown')) e.preventDefault();
    };
    window.addEventListener('keydown', keys);
    window.addEventListener('keydown', drive);
    window.addEventListener('keyup', drive);
    return () => {
      window.removeEventListener('keydown', keys);
      window.removeEventListener('keydown', drive);
      window.removeEventListener('keyup', drive);
      off.then((f) => f());
    };
  }, [view.kind, launching, garage, home, onboard, raceCar, stars, newTerminal, away]);

  const car = view.kind === 'onboard' ? stars.find((s) => s.id === view.id) ?? null : null;
  const pit = stars.filter((s) => s.status === 'needsYou');
  const onTrack = stars.filter((s) => s.status === 'working' || s.status === 'forming').length;
  const status = state.busy ? (halo.tool ? `${NAME} · ${halo.tool}` : `${NAME} is thinking`) : `${onTrack} on track · ${pit.length} in the pit`;
  useEffect(() => scene.current?.setStatus(status), [status]);

  // The captions: the last thing you said and Halo's latest words.
  const lastHalo = halo.chunks.length ? halo.live : [...state.lines].reverse().find((l) => l.role === 'halo')?.text;
  const lastYou = [...state.lines].reverse().find((l) => l.role === 'you')?.text;
  const caption = plain(lastHalo ?? 'Launch Control here. Tell me the job; anything long goes out as a car, and I’ll radio when it crosses the line.', 160);

  // Every car's launch, in its place in the radio log.
  const marks: Mark[] = stars.map((s) => {
    const f = flag(s);
    return {
      ts: s.created,
      key: `launch-${s.id}`,
      node: (
        <button className={`launch-mark ${f.tone}`} onClick={() => onboard(s.id)}>
          <span className="mono num">{num.get(s.id)}</span>
          <span className="mono">Launched</span>
          <span className="name">{s.title}</span>
          <span className="mono flag">{f.text}</span>
        </button>
      ),
    };
  });

  const submit = async () => {
    const t = draft.trim();
    if (!t) return;
    setDraft('');
    if (car) await api.tell(car.id, t);
    else await halo.ask(t);
  };

  return (
    <div className="pier" data-view={view.kind}>
      <canvas
        ref={canvas}
        className="pier-world"
        aria-label="The pier at night: Halo is the ring of light over the curl ramp, each agent is a car"
        onClick={(e) => {
          if (view.kind !== 'pier') return;
          const id = scene.current?.pick(e.clientX, e.clientY);
          if (id && tnum.has(id)) setView({ kind: 'terminal', id });
          else if (id) onboard(id);
        }}
        onPointerMove={(e) => {
          const s = scene.current;
          if (!s) return;
          const r = e.currentTarget.getBoundingClientRect();
          s.setPointer(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
          if (view.kind !== 'pier') return;
          // Take the wheel of the car under the pointer; keep it while you stay near it.
          const hit = s.pick(e.clientX, e.clientY, 34);
          let next = hit ?? s.driving;
          if (!hit && s.driving) {
            const at = s.project(s.driving, 0.6);
            if (!at || Math.hypot(at.x + r.left - e.clientX, at.y + r.top - e.clientY) > 160) next = null;
          }
          if (next !== s.driving) {
            s.control(next);
            setDriving(next);
          }
          e.currentTarget.style.cursor = next ? 'pointer' : '';
        }}
        onPointerLeave={() => {
          scene.current?.setPointer(0, 0);
          scene.current?.control(null);
          setDriving(null);
        }}
        onWheel={(e) => {
          if (view.kind === 'pier' && scene.current?.driving) scene.current.zoom(e.deltaY);
        }}
      />
      {!webgl && <p className="pier-nogl">This Mac’s graphics can’t draw the pier. Switch back to Galaxy at the top.</p>}
      <div className="pier-vignette" aria-hidden />

      <header data-tauri-drag-region className="pier-top" style={{ paddingTop: inApp && isMac ? 30 : 22 }}>
        <nav aria-label="Where you are" data-tauri-drag-region style={{ display: 'flex', alignItems: 'baseline', gap: 16, paddingLeft: inApp && isMac ? 64 : 0, minWidth: 0 }}>
          <button className="crumb mono season-crumb" onClick={onSeason} aria-label={`The season: every workspace (${shortcut('⌘0')})`}>← Season</button>
          <button className="crumb display" onClick={home} style={{ fontSize: 30, letterSpacing: '0.1em', lineHeight: 1, whiteSpace: 'nowrap' }} aria-label={`${arena.name}: the arena`}>{arena.name}</button>
          {view.kind === 'pier' ? (
            <span className="mono pier-place">
              {arena.workspace ? (
                <span className="arena-where" title={arena.workspace.path}>
                  {arena.workspace.name}
                  {arena.workspace.branch && <span className="arena-branch">⎇ {arena.workspace.branch}{arena.workspace.dirty ? ` ●${arena.workspace.dirty}` : ''}</span>}
                </span>
              ) : (
                <span>Own folders</span>
              )}{' '}
              <span className="sep">/</span> {now.split(' / ')[1]} <span className="sep">/</span> {status}
            </span>
          ) : (
            <span className="mono crumbs">
              <span className="sep">/</span>
              <button className="crumb" onClick={home}>{arena.workspace?.name ?? 'Arena'}</button>
              <span className="sep">/</span>
              {view.kind === 'radio' ? <span>Team radio</span> : <span>{car ? `#${num.get(car.id)} ${car.title}` : 'Onboard'}</span>}
            </span>
          )}
        </nav>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <UpdateChip />
          <button className="btn quiet customize-btn" onClick={openWorkshop}>Customize</button>
          <HotkeyChip />
          <button className="btn quiet" onClick={() => setGarage(true)} aria-label={`Garage: ${ENGINE_NAME[engine ?? state.engine]}`}>Garage <span className="mono" style={{ fontSize: 9, color: 'var(--faint)' }}>{ENGINE_NAME[engine ?? state.engine]}</span></button>
          <button className="btn quiet-line" onClick={newTerminal} aria-label={`New terminal car (${shortcut('⌘T')})`}>+ Terminal</button>
          <button className="btn" onClick={() => (home(), setLaunching(true))}>+ Launch</button>
        </div>
      </header>

      {/* Over the world: the cars' plates and Halo's start tree. */}
      <div className="pier-marks" aria-hidden={view.kind !== 'pier'}>
        <button ref={tree} className="sign-mark" onClick={() => setView({ kind: 'radio' })} aria-label={`Launch Control, ${mood === 'hearing' ? 'hearing you' : mood}: open team radio`} />
        {terms.filter((t) => t.status === 'running').map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              if (el) labels.current.set(t.id, el);
              else labels.current.delete(t.id);
            }}
            className="plate term"
            onClick={() => setView({ kind: 'terminal', id: t.id })}
            aria-label={`Terminal ${tnum.get(t.id)}: ${t.command ?? t.shell}, ${termFlag(t).text}`}
          >
            <span className="mono num">{tnum.get(t.id)}</span>
            <span className="name">{t.command ?? t.shell}</span>
            <span className="mono flag">{t.ports.length ? t.ports.map((p) => `:${p}`).join(' ') : 'Racing'}</span>
          </button>
        ))}
        {onCourse.filter((x) => !parked(x)).slice(0, 18).map((s) => {
          const f = flag(s);
          return (
            <button
              key={s.id}
              ref={(el) => {
                if (el) labels.current.set(s.id, el);
                else labels.current.delete(s.id);
              }}
              className={`plate ${f.tone}`}
              onClick={() => onboard(s.id)}
              aria-label={`Car ${num.get(s.id)}, ${s.title}: ${f.text}`}
            >
              <span className="mono num">{num.get(s.id)}</span>
              <span className="name">{s.title}</span>
              <span className="mono flag">{f.text}</span>
            </button>
          );
        })}
      </div>

      {/* The timing tower: every car, on the pier and beside team radio. */}
      <div className="pier-tower" aria-hidden={view.kind === 'onboard'}>
        {zone === 'course' ? (
          <aside className="tower" aria-label="Timing tower">
            <div className="tower-head">
              <span className="mono">Run</span>
              <span className="display">{String(stars.length - counts.paddock).padStart(2, '0')}</span>
            </div>
            <div className="scroll tower-list">
              {stars.length === 0 && <p className="tower-empty">No cars out. Tell Halo the job, or launch one.</p>}
              {towerOrder(stars.filter((x) => !parked(x))).map((s, i) => {
                const f = flag(s);
                return (
                  <div key={s.id}>
                    <button className={`tower-row ${f.tone}`} onClick={() => onboard(s.id)}>
                      <span className="mono pos">{String(i + 1).padStart(2, ' ')}</span>
                      <span className="mono num">{num.get(s.id)}</span>
                      <span className="name">{s.title}</span>
                      <span className="mono flag">{f.text}</span>
                    </button>
                    {s.status === 'needsYou' && <PitReply star={s} num={num.get(s.id) ?? ''} onOpen={() => onboard(s.id)} />}
                  </div>
                );
              })}
              {counts.paddock > 0 && (
                <button className="tower-row fin tower-more" onClick={() => setZone('paddock')}>
                  <span className="mono pos" />
                  <span className="mono num">{String(counts.paddock).padStart(2, '0')}</span>
                  <span className="name">Finished, in the paddock</span>
                  <span className="mono flag">→</span>
                </button>
              )}
              <div className="tower-sub mono">
                <span>Terminals</span>
                <button className="tower-add" onClick={newTerminal} aria-label={`New terminal car (${shortcut('⌘T')})`}>+ {shortcut('⌘T')}</button>
              </div>
              {terms.length === 0 && <p className="tower-empty">No terminals. {shortcut('⌘T')} opens one in {arena.workspace?.name ?? 'your home folder'}.</p>}
              {terms.map((t) => {
                const f = termFlag(t);
                return (
                  <button key={t.id} className={`tower-row term ${f.tone}`} onClick={() => setView({ kind: 'terminal', id: t.id })} aria-label={`Terminal ${tnum.get(t.id)}: ${t.command ?? t.last?.command ?? t.shell}, ${f.text}`}>
                    <span className="mono pos" />
                    <span className="mono num">{tnum.get(t.id)}</span>
                    <span className="name mono-name">{t.command ?? t.last?.command ?? t.shell}</span>
                    <span className="mono flag">{f.text}</span>
                  </button>
                );
              })}
              {termError && <p className="tower-empty" role="alert">{termError}</p>}
            </div>
          </aside>
        ) : zone === 'pit' ? (
          <PitZone stars={stars} num={num} onOpen={onboard} />
        ) : (
          <PaddockZone stars={stars} num={num} onOpen={onboard} />
        )}
      </div>

      {view.kind === 'pier' && <TrackMap zone={zone} counts={counts} onGo={setZone} tod={hasDay ? tod : null} onTod={setTod} />}
      {garage && <Settings words={GARAGE_WORDS} theme={switcher} onChange={(g) => setEngine(g.engine)} onClose={() => setGarage(false)} />}

      {/* The car in your hands: it turns on a little stage; the keys are yours. */}
      {(() => {
        const term = driving && view.kind === 'pier' ? terms.find((x) => x.id === driving) : undefined;
        if (term) {
          const tf = termFlag(term);
          return (
            <aside className="car-card term" aria-label={`Terminal ${tnum.get(term.id)}`}>
              <div className="stage-slot" aria-hidden />
              <div className="car-card-body">
                <div className="car-card-head">
                  <span className="mono num">{tnum.get(term.id)}</span>
                  <span className="name mono-name">{term.command ?? term.last?.command ?? term.shell}</span>
                </div>
                <span className="mono car-card-kind">Rosso GT · {term.shell} · <span className={`flag ${tf.tone}`}>{tf.text}</span></span>
                <div className="car-card-speed">
                  <span ref={speedEl} className="display">0</span>
                  <span className="mono">km/h</span>
                </div>
                <span className="mono car-card-keys">Click to go onboard · its shell</span>
              </div>
            </aside>
          );
        }
        const d = driving && view.kind === 'pier' ? stars.find((x) => x.id === driving) : undefined;
        if (!d) return null;
        const kind = KIND_OF[d.engine];
        const f = flag(d);
        return (
          <aside className="car-card" aria-label={`Driving ${d.title}`}>
            <div className="stage-slot" aria-hidden />
            <div className="car-card-body">
              <div className="car-card-head">
                <span className="mono num">{num.get(d.id)}</span>
                <span className="name">{d.title}</span>
              </div>
              <span className="mono car-card-kind">{KIND_NAME[kind]} · {ENGINE_NAME[d.engine]} · <span className={`flag ${f.tone}`}>{f.text}</span></span>
              <div className="car-card-speed">
                <span ref={speedEl} className="display">0</span>
                <span className="mono">km/h</span>
              </div>
              {f.tone === 'go' ? (
                <span className="mono car-card-keys"><strong className="drive-key">D drive it</strong> · ↑↓ speed · ←→ lane · space {kind === 'roadster' ? 'flip' : 'boost'} · scroll zoom · click to ride</span>
              ) : (
                <span className="mono car-card-keys">Click to open {f.tone === 'pit' ? 'and answer' : ''}</span>
              )}
            </div>
          </aside>
        );
      })()}

      <CutscenePreload />
      {cut && <Cutscene key={cut} title={stars.find((x) => x.id === cut)?.title ?? ''} num={num.get(cut) ?? ''} onDone={() => scene.current?.skipCut()} />}

      {/* Home: the captions. */}
      <div className="pier-home" aria-hidden={view.kind !== 'pier'}>

        <div
          className="captions"
          role="button"
          tabIndex={0}
          aria-label="Open team radio"
          onClick={() => setView({ kind: 'radio' })}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setView({ kind: 'radio' })}
          onWheel={(e) => e.deltaY < -6 && setView({ kind: 'radio' })}
        >
          {lastYou && <p className="cap-you"><span className="mono">You</span> {plain(lastYou, 90)}</p>}
          <div className="cap-halo" key={halo.chunks.length ? 'live' : lastHalo}>
            <span className="mono cap-sign">
              <span className={`cap-dot${state.busy ? ' on' : ''}`} /> Launch Control
            </span>
            <p className="cap-text">{caption}</p>
          </div>
          <span className="mono cap-hint">↑ scroll for team radio</span>
          {halo.error && <span style={{ color: 'var(--signal)', fontSize: 12 }}>{halo.error}</span>}
        </div>
      </div>

      {/* Launching: its own layer over everything, so nothing (the tower) covers it. */}
      {launching && (
        <div className="launch-layer" onPointerDown={(e) => e.target === e.currentTarget && setLaunching(false)}>
          <div className="launch-pad">
            <LightStar engine={engine ?? state.engine} words={LAUNCH_WORDS} where={arena.workspace ? `${arena.name} · ${arena.workspace.name}` : arena.name} kinds={CAR_OF} onDone={() => setLaunching(false)} />
          </div>
        </div>
      )}

      {/* Team radio: the whole thread. */}
      <div className="pier-radio" aria-hidden={view.kind !== 'radio'}>
        <button className="back mono" onClick={home}>← Arena <span className="sep">esc</span></button>
        {view.kind === 'radio' && <ThreadView radio names={{ halo: NAME, back: 'pier' }} marks={marks} lines={state.lines} chunks={halo.chunks} onStar={onboard} onBack={home} />}
      </div>

      {/* Onboard: one car, the camera riding behind it. */}
      <div className="pier-onboard" aria-hidden={view.kind !== 'onboard'}>
        <button className="back mono" onClick={home}>← Arena <span className="sep">esc</span></button>
        {car && car.status === 'working' && <button className="btn solid onboard-drive" onClick={() => setRaceCar(car.id)}>Drive it ▸</button>}
        {car && <StarView key={car.id} star={car} onboard />}
      </div>

      {view.kind === 'terminal' && (
        <TerminalCockpit
          terminals={terms}
          id={view.id}
          num={tnum}
          arena={arena.name}
          branch={arena.workspace?.branch ?? null}
          onSelect={(id) => setView({ kind: 'terminal', id })}
          onNew={newTerminal}
          onBack={home}
          onAsk={askAbout}
        />
      )}

      {raceCar && stars.find((x) => x.id === raceCar) && (
        <RaceMode
          star={stars.find((x) => x.id === raceCar)!}
          stars={stars}
          num={num}
          day={tod === 'day'}
          onExit={(open) => {
            setRaceCar(null);
            if (open) onboard(open);
          }}
        />
      )}

      <form className="pier-ask" onSubmit={(e) => (e.preventDefault(), submit())}>
        <div className={`ask radio${car ? ' to-star' : ''}`}>
          <span className="prompt mono" aria-hidden>{car ? `#${num.get(car.id)}` : 'Radio'}</span>
          <label className="sr" htmlFor="ask">{car ? `Radio ${car.title}` : `Radio ${NAME}`}</label>
          <input
            ref={input}
            id="ask"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={hearing ? 'On air… let go to send' : car ? `Radio ${car.title}…` : `Radio ${NAME}… (hold ${SUMMON_KEY} to talk)`}
            autoComplete="off"
          />
          {state.busy && !car && <button type="button" className="btn quiet" onClick={() => api.cancel()}>Stop</button>}
          <Mic voice={voice} />
          <button className="icon-btn solid" type="submit" aria-label="Send" disabled={!draft.trim()}>
            <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        </div>
      </form>
    </div>
  );
}
