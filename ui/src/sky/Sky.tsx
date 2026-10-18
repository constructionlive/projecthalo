// The Sky: one continuous space with three depths.
//
// - Galaxy (home): Halo and its stars, the conversation crawling back beside
//   them, what needs the person.
// - Thread: scroll up on (or click) the crawl and the conversation fills the
//   screen while the galaxy recedes behind it.
// - Star: click a star and the camera dives into it; it fills the screen with
//   its own thread, and the ask line talks to that star.
//
// "← Galaxy", Esc or the breadcrumb go back. The ask line at the bottom is
// always there and always talks to what is open.

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Crawl, type CrawlEntry } from '../components/Crawl';
import { Galaxy, type Point } from '../components/Galaxy';
import { HotkeyChip } from '../components/HotkeyChip';
import { UpdateChip } from '../components/UpdateChip';
import { openWorkshop } from '../lib/themeChoice';
import { LightStar } from '../components/LightStar';
import { Settings, type SettingsWords } from '../components/Settings';
import { Mic } from '../components/Mic';
import { Nebula } from '../components/Nebula';
import { StarView } from '../components/StarView';
import { ThreadView } from '../components/ThreadView';
import { api, inApp } from '../lib/api';
import { ageOf, colorOf } from '../lib/stars';
import { ENGINE_NAME, type Engine, type Star } from '../lib/types';
import { ago } from '../lib/useHalo';
import type { ThemeProps } from '../kit/theme';

type View = { kind: 'galaxy' } | { kind: 'thread' } | { kind: 'nebula' } | { kind: 'star'; id: string; from?: 'nebula' };

const OBSERVATORY_WORDS: SettingsWords = {
  title: 'Observatory',
  note: 'Set once. Every star you light, and Halo itself, runs this way until you change it here.',
  engine: 'What lights the stars',
  picked: 'lighting',
  access: 'How far a star may reach',
  workspace: ['Close orbit', 'Files and shell in the star’s own folder. Nothing outside it, nothing asked.'],
  full: ['Deep space', 'Anywhere on this Mac, no sandbox, nothing asked. Only for jobs you trust.'],
  theme: 'Sky',
  foot: 'Stars already lit keep their engine; the next turn of every star uses these permissions.',
};

function NeedsYou({ star, onOpen }: { star: Star; onOpen: (at: Point) => void }) {
  const [answer, setAnswer] = useState('');
  const send = async () => {
    const t = answer.trim();
    if (!t) return;
    setAnswer('');
    await api.tell(star.id, t);
  };
  return (
    <div className="row">
      <button onClick={(e) => onOpen({ x: e.clientX, y: e.clientY })} style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="mono" style={{ fontSize: 9, color: 'var(--signal)' }}>{star.title} →</span>
        <span style={{ fontSize: 16, lineHeight: 1.45 }}>{star.question ?? star.now}</span>
      </button>
      <form className="answer" onSubmit={(e) => (e.preventDefault(), send())}>
        <label className="sr" htmlFor={`ans-${star.id}`}>Answer {star.title}</label>
        <input id={`ans-${star.id}`} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer…" />
        <button className="btn signal" type="submit" disabled={!answer.trim()}>Reply</button>
      </form>
    </div>
  );
}

/** The Galaxy theme: given Halo's state and voice by the window (or, forked, by a theme's frame). */
export function Sky({ halo, voice, draft, setDraft, now, switcher }: ThemeProps) {
  const { state, stars } = halo;
  const [view, setView] = useState<View>({ kind: 'galaxy' });
  // The last star opened: kept while the view zooms back out.
  const [shownStar, setShownStar] = useState<string | null>(null);
  const [origin, setOrigin] = useState<Point>({ x: 0, y: 0 });
  const [lighting, setLighting] = useState(false);
  const [observing, setObserving] = useState(false);
  // The Observatory's engine, once picked there (until the next state catches up).
  const [engine, setEngine] = useState<Engine | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const zoomFrom = useCallback((at?: Point) => {
    const r = stage.current?.getBoundingClientRect();
    if (r) setOrigin(at ? { x: at.x - r.left, y: at.y - r.top } : { x: r.width / 2, y: r.height / 2 });
  }, []);
  const openStar = useCallback((id: string, at?: Point, from?: 'nebula') => {
    zoomFrom(at);
    setShownStar(id);
    setView({ kind: 'star', id, from });
    setTimeout(() => input.current?.focus(), 400);
  }, [zoomFrom]);
  // Into the Nebula, flying in from wherever it was clicked (its cloud on the rim).
  const openNebula = useCallback((at?: Point) => (zoomFrom(at), setView({ kind: 'nebula' })), [zoomFrom]);
  const home = useCallback(() => setView({ kind: 'galaxy' }), []);
  // Back one place: a star opened in the Nebula goes back to it.
  const back = useCallback(() => setView((v) => (v.kind === 'star' && v.from === 'nebula' ? { kind: 'nebula' } : { kind: 'galaxy' })), []);

  useEffect(() => {
    const off = api.on<string>('select-star', (id) => openStar(id));
    return () => {
      off.then((f) => f());
    };
  }, [openStar]);

  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && view.kind !== 'galaxy' && !lighting && !observing) back();
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [view.kind, lighting, observing, back]);

  const star = stars.find((s) => s.id === (view.kind === 'star' ? view.id : shownStar)) ?? null;
  const waiting = stars.filter((s) => s.status === 'needsYou');
  const allLanded = useMemo(() => stars.filter((s) => s.status === 'landed' && ageOf(s) !== 'remnant').sort((a, b) => b.updated - a.updated), [stars]);
  const remnants = stars.filter((s) => ageOf(s) === 'remnant').length;
  const working = stars.filter((s) => s.status === 'working' || s.status === 'forming').length;
  const status = state.busy ? (halo.tool ? `Using ${halo.tool}` : 'Thinking') : `${working} working · ${waiting.length} waiting on you`;

  const entries: CrawlEntry[] = state.lines.slice(-8).map((l, i, all) => ({ key: `${l.ts}-${state.lines.length - all.length + i}`, role: l.role, text: l.text }));
  if (halo.chunks.length) entries.push({ key: 'live', role: 'halo', text: halo.live, chunks: halo.chunks });
  if (entries.length === 0) entries.push({ key: 'hello', role: 'halo', text: 'I’m Halo. Tell me what’s on your mind. Anything long goes out as a star, and I’ll tell you when it lands.' });

  const talkingToStar = view.kind === 'star' && star;
  const submit = async () => {
    const t = draft.trim();
    if (!t) return;
    setDraft('');
    if (talkingToStar) await api.tell(star.id, t);
    else await halo.ask(t);
  };

  return (
    <div data-view={view.kind} data-from={view.kind === 'star' ? view.from : undefined} style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', '--zx': `${origin.x}px`, '--zy': `${origin.y}px` } as CSSProperties}>
      <div className="starfield" aria-hidden style={{ position: 'absolute', inset: 0, opacity: 0.9, pointerEvents: 'none' }} />
      <div aria-hidden style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 260, pointerEvents: 'none', background: 'linear-gradient(to top, rgba(10,11,10,1) 0%, rgba(10,11,10,.9) 40%, rgba(46,66,104,.16) 92%, rgba(46,66,104,0) 100%)' }} />

      <header data-tauri-drag-region style={{ position: 'relative', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: `${inApp ? 30 : 22}px clamp(16px, 3vw, 44px) 16px`, borderBottom: '1px solid var(--line)', zIndex: 4 }}>
        <nav aria-label="Where you are" data-tauri-drag-region style={{ display: 'flex', alignItems: 'baseline', gap: 16, paddingLeft: inApp ? 64 : 0, minWidth: 0 }}>
          <button className="crumb display" onClick={home} style={{ fontSize: 30, letterSpacing: '0.16em', lineHeight: 1 }} aria-label="Galaxy">Halo</button>
          {view.kind !== 'galaxy' && (
            <span className="mono crumbs">
              <span className="sep">/</span>
              <button className="crumb" onClick={home}>Galaxy</button>
              <span className="sep">/</span>
              {view.kind === 'star' && view.from === 'nebula' && (
                <>
                  <button className="crumb" onClick={back}>Nebula</button>
                  <span className="sep">/</span>
                </>
              )}
              {view.kind === 'thread' ? <span>Thread</span> : view.kind === 'nebula' ? <span>Nebula</span> : <span style={{ color: star ? colorOf(star) : undefined }}>{star?.title ?? 'Star'}</span>}
            </span>
          )}
          {view.kind === 'galaxy' && <span className="mono" style={{ fontSize: 10, color: 'var(--faint)' }}>{now} <span className="sep">/</span> {status}</span>}
        </nav>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <UpdateChip />
          <button className="btn quiet customize-btn" onClick={openWorkshop}>Customize</button>
          <HotkeyChip />
          <button className="btn quiet" onClick={() => setObserving(true)} aria-label={`Observatory: ${ENGINE_NAME[engine ?? state.engine]}`}>Observatory <span className="mono" style={{ fontSize: 9, color: 'var(--faint)' }}>{ENGINE_NAME[engine ?? state.engine]}</span></button>
          <button className="btn" onClick={() => (home(), setLighting(true))}>+ Light a star</button>
        </div>
      </header>

      <div ref={stage} className="stage">
        {/* Galaxy: home. */}
        <div className="layer layer-galaxy" aria-hidden={view.kind !== 'galaxy'}>
          <section aria-label="The sky" style={{ position: 'relative', flex: '999 1 520px', minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 'min(100%, calc((100vh - 230px) / 0.8))' }}>
              <Galaxy stars={stars} selected={null} busy={state.busy} hearing={!!voice.status?.recording || voice.holding} onSelect={(id, at) => (id ? openStar(id, at) : setView({ kind: 'thread' }))} remnants={remnants} onRemnants={openNebula} />
            </div>
            {lighting && (
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 16, display: 'flex', justifyContent: 'center', zIndex: 3 }}>
                <LightStar engine={engine ?? state.engine} onDone={() => setLighting(false)} />
              </div>
            )}
          </section>

          <aside aria-label="Halo" style={{ flex: '1 1 380px', maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 18, padding: '18px 0 12px', minHeight: 0 }}>
            <div
              className="crawl-door"
              role="button"
              tabIndex={0}
              aria-label="Open the whole thread"
              onClick={() => setView({ kind: 'thread' })}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setView({ kind: 'thread' })}
              onWheel={(e) => e.deltaY < -6 && setView({ kind: 'thread' })}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                <span className="mono" style={{ fontSize: 10, color: 'var(--faint)' }}>Halo {state.busy && <span className="blink">▍</span>}</span>
                <span className="mono crawl-hint">↑ scroll for the whole thread</span>
              </div>
              <Crawl entries={entries} height="clamp(220px, 40vh, 420px)" size={22} />
              {halo.error && <span style={{ color: 'var(--signal)', fontSize: 12 }}>{halo.error}</span>}
            </div>

            <div className="scroll" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 22, paddingRight: 4 }}>
              {waiting.length > 0 && (
                <section aria-label="Waiting on you">
                  <div className="count-head signal">
                    <span className="mono" style={{ fontSize: 10 }}>Waiting on you</span>
                    <span className="num">{String(waiting.length).padStart(2, '0')}</span>
                  </div>
                  {waiting.map((s) => <NeedsYou key={s.id} star={s} onOpen={(at) => openStar(s.id, at)} />)}
                </section>
              )}
              {allLanded.length > 0 && (
                <section aria-label="Landed">
                  <div className="count-head">
                    <span className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>Landed</span>
                    <span className="num">{String(allLanded.length).padStart(2, '0')}</span>
                  </div>
                  {allLanded.slice(0, 5).map((s) => (
                    <button key={s.id} onClick={(e) => openStar(s.id, { x: e.clientX, y: e.clientY })} className="landed-row">
                      <span><strong>{s.title}</strong> · {s.now}</span>
                      <span className="mono">{ago(s.updated)}</span>
                    </button>
                  ))}
                  {remnants > 0 && (
                    <button className="landed-row" onClick={(e) => openNebula({ x: e.clientX, y: e.clientY })}>
                      <span>{remnants} older {remnants === 1 ? 'star rests' : 'stars rest'} in the Nebula</span>
                      <span className="mono">→</span>
                    </button>
                  )}
                </section>
              )}
            </div>
          </aside>
        </div>

        {/* Thread: the conversation fills the screen. */}
        <div className="layer layer-thread" aria-hidden={view.kind !== 'thread'}>
          <button className="back mono" onClick={home}>← Galaxy <span className="sep">esc</span></button>
          {view.kind === 'thread' && <ThreadView lines={state.lines} chunks={halo.chunks} onStar={(id) => openStar(id)} onBack={home} />}
        </div>

        {/* The Nebula: where old stars go to die. */}
        <div className="layer layer-nebula" aria-hidden={view.kind !== 'nebula'}>
          <Nebula stars={stars} active={view.kind === 'nebula'} onOpen={(id, at) => openStar(id, at, 'nebula')} />
          <button className="back mono" onClick={home}>← Galaxy <span className="sep">esc</span></button>
        </div>

        {/* Star: dived into. */}
        <div className="layer layer-star" aria-hidden={view.kind !== 'star'}>
          <button className="back mono" onClick={back}>← {view.kind === 'star' && view.from === 'nebula' ? 'Nebula' : 'Galaxy'} <span className="sep">esc</span></button>
          {star && <StarView key={star.id} star={star} />}
        </div>
      </div>

      {observing && <Settings words={OBSERVATORY_WORDS} className="sky" theme={switcher} onChange={(g) => setEngine(g.engine)} onClose={() => setObserving(false)} />}

      <form onSubmit={(e) => (e.preventDefault(), submit())} style={{ position: 'relative', padding: '10px clamp(16px, 3vw, 44px) 22px', zIndex: 4 }}>
        <div className={`ask${talkingToStar ? ' to-star' : ''}`}>
          <span className="prompt" aria-hidden>{talkingToStar ? '✦' : '›'}</span>
          <label className="sr" htmlFor="ask">{talkingToStar ? `Tell ${star.title}` : 'Ask Halo'}</label>
          <input
            ref={input}
            id="ask"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={voice.status?.recording ? 'Listening…' : talkingToStar ? `Tell ${star.title}…` : 'Say what’s on your mind…'}
            autoComplete="off"
          />
          {state.busy && !talkingToStar && <button type="button" className="btn quiet" onClick={() => api.cancel()}>Stop</button>}
          <Mic voice={voice} />
          <button className="icon-btn solid" type="submit" aria-label="Send" disabled={!draft.trim()}>
            <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        </div>
      </form>

      <div className="grain" aria-hidden />
    </div>
  );
}
