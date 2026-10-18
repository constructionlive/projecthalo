// Onboard a terminal car: the red GT's cockpit, and on its dash the real
// shell. Every key goes to the shell (Esc too, so vim and less work); the
// app's own keys are ⌘-chords: ⌘Return back, ⌘[ ⌘] the other cars, ⌘T a new
// one, ⌘W close it, ⌘K clear, ⌘⇧H ask Halo about what's on screen.

import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal as XTerm } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';

import { api, inApp } from '../lib/api';
import type { Terminal } from '../lib/types';
import cockpit from './plates/cockpit-gt.jpg';

/** The night palette: amber cursor, the season's blue and orange. */
const THEME = {
  background: '#06080d',
  foreground: '#e6e3db',
  cursor: '#ffb547',
  cursorAccent: '#06080d',
  selectionBackground: 'rgba(255, 181, 71, 0.28)',
  black: '#1a1d24',
  red: '#ff6b6b',
  green: '#7ee08a',
  yellow: '#ffcf6b',
  blue: '#7fb4ff',
  magenta: '#c4a7ff',
  cyan: '#6fdde8',
  white: '#d7d9df',
  brightBlack: '#5c6170',
  brightRed: '#ff8c8c',
  brightGreen: '#a2f0ab',
  brightYellow: '#ffe08f',
  brightBlue: '#a5cbff',
  brightMagenta: '#d9c6ff',
  brightCyan: '#9cecf2',
  brightWhite: '#ffffff',
};

/** ⌘-chords the cockpit keeps; everything else is the shell's. */
function cockpitChord(e: KeyboardEvent): boolean {
  if (!e.metaKey || e.ctrlKey || e.altKey) return false;
  const k = e.key.toLowerCase();
  return k === 'enter' || k === '[' || k === ']' || k === 'k' || k === 't' || k === 'w' || (e.shiftKey && k === 'h');
}

/** ⌘-chords the window's own handlers take (season, arenas, launch): the shell mustn't get them either. */
function windowChord(e: KeyboardEvent): boolean {
  if (!e.metaKey || e.ctrlKey || e.altKey) return false;
  const k = e.key.toLowerCase();
  return /^[0-9]$/.test(k) || k === 'l' || k === 'n';
}

/** The live shell: draws what it has printed, then follows it; keys go to it. */
function Shell({ id, onTerm }: { id: string; onTerm: (term: XTerm | null) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const told = useRef(onTerm);
  told.current = onTerm;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new XTerm({
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.22,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10_000,
      macOptionIsMeta: true,
      allowProposedApi: true,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank')));
    term.open(el);
    // The GPU renderer when the machine has it; the DOM one otherwise.
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch {
      /* DOM renderer */
    }
    // The app's chords are caught on the window, wherever focus is; the shell never sees them.
    term.attachCustomKeyEventHandler((e) => !cockpitChord(e) && !windowChord(e));
    told.current(term);
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }

    // Output: what it printed before we looked, then everything after, by byte position.
    let shown = -1;
    const early: { at: number; data: Uint8Array }[] = [];
    const take = (at: number, data: Uint8Array) => {
      const end = at + data.length;
      if (end <= shown) return;
      term.write(at >= shown ? data : data.subarray(shown - at));
      shown = end;
    };
    const off = api.onTerminalData((tid, at, data) => {
      if (tid !== id) return;
      if (shown < 0) early.push({ at, data });
      else take(at, data);
    });
    let live = true;
    api.terminalReplay(id).then((r) => {
      if (!live) return;
      term.write(r.data);
      shown = r.at;
      early.forEach((c) => take(c.at, c.data));
      early.length = 0;
    });

    const typed = term.onData((s) => api.terminalWrite(id, s).catch(() => {}));
    const sized = term.onResize(({ cols, rows }) => api.terminalResize(id, cols, rows).catch(() => {}));
    api.terminalResize(id, term.cols, term.rows).catch(() => {});
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          /* hidden */
        }
      });
    });
    ro.observe(el);
    term.focus();
    // Tests read what the shell shows through this (the GPU renderer draws no DOM text).
    if (location.search.includes('test')) (window as unknown as { xterm: XTerm }).xterm = term;
    return () => {
      told.current(null);
      live = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      typed.dispose();
      sized.dispose();
      off.then((f) => f());
      term.dispose();
    };
  }, [id]);

  return <div ref={host} className="cockpit-xterm" />;
}

function since(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

function took(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Where a terminal car is, in race words. */
export function termFlag(t: Terminal): { text: string; tone: 'go' | 'fin' | 'out' | 'grid' } {
  if (t.status === 'exited') return { text: 'Shell ended', tone: 'out' };
  if (t.status === 'running') return { text: t.ports.length ? `Lapping ${t.ports.map((p) => `:${p}`).join(' ')}` : 'Racing', tone: 'go' };
  // Ctrl-C (130) is you stopping it, not a crash.
  if (t.last && t.last.exit === 130) return { text: 'Stopped', tone: 'grid' };
  if (t.last && t.last.exit !== 0) return { text: `Retired · exit ${t.last.exit}`, tone: 'out' };
  if (t.last) return { text: 'Chequered', tone: 'fin' };
  return { text: 'On the grid', tone: 'grid' };
}

interface Props {
  terminals: Terminal[];
  id: string;
  /** "T1"… by when each was opened in this arena. */
  num: Map<string, string>;
  arena: string;
  branch: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onBack: () => void;
  onAsk: (t: Terminal) => void;
}

/** How long a "close it?" waits for the second ⌘W or a click. */
const CONFIRM_MS = 4000;

export function TerminalCockpit({ terminals, id, num, arena, branch, onSelect, onNew, onBack, onAsk }: Props) {
  const t = terminals.find((x) => x.id === id) ?? null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (t?.status !== 'running') return;
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [t?.status]);

  const term = useRef<XTerm | null>(null);
  // A terminal still running something asks once before it goes.
  const [closing, setClosing] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => setClosing(null), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [closing]);

  const step = (d: number) => {
    const i = terminals.findIndex((x) => x.id === id);
    const next = terminals[(i + d + terminals.length) % terminals.length];
    if (next) onSelect(next.id);
  };
  const close = async (tid: string) => {
    setClosing(null);
    setCloseError(null);
    const i = terminals.findIndex((x) => x.id === tid);
    const rest = terminals.filter((x) => x.id !== tid);
    try {
      await api.terminalClose(tid);
    } catch (e) {
      setCloseError(String(e));
      return;
    }
    if (tid !== id) return;
    const next = rest[Math.min(i, rest.length - 1)];
    if (next) onSelect(next.id);
    else onBack();
  };
  const askClose = (tid: string) => {
    const x = terminals.find((y) => y.id === tid);
    if (x?.status === 'running' && closing !== tid) setClosing(tid);
    else close(tid);
  };

  // The cockpit's keys, caught before the shell and wherever focus is (a button, the page…).
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (windowChord(e)) {
        e.preventDefault();
        return; // on to the window's own handlers
      }
      if (!cockpitChord(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const k = e.key.toLowerCase();
      if (k === 'enter') onBack();
      else if (k === '[') step(-1);
      else if (k === ']') step(1);
      else if (k === 'k') term.current?.clear();
      else if (k === 't') onNew();
      else if (k === 'w') askClose(id);
      else if (k === 'h' && t) onAsk(t);
    };
    window.addEventListener('keydown', keys, true);
    return () => window.removeEventListener('keydown', keys, true);
  });

  if (!t) return null;
  const f = termFlag(t);
  const failed = !!t.last && t.last.exit !== 0 && t.last.exit !== 130 && t.status !== 'running';
  return (
    <section className="cockpit" aria-label={`Onboard ${num.get(t.id) ?? ''}: ${t.shell} in ${t.cwd}`}>
      {/* Through the windscreen: the track, the bridge, the red bonnet running into the dash. */}
      <div className="cockpit-view" style={{ backgroundImage: `url(${cockpit})` }} aria-hidden />
      <div className="cockpit-shade" aria-hidden />

      <header className="cockpit-top" data-tauri-drag-region style={{ paddingTop: inApp ? 30 : 22 }}>
        <div className="cockpit-id" data-tauri-drag-region style={{ paddingLeft: inApp ? 64 : 0 }}>
          <button className="crumb mono cockpit-back" onClick={onBack}>← {arena} <span className="sep">⌘Return</span></button>
          <span className="display cockpit-name">{num.get(t.id)} · {t.shell}</span>
          <span className="mono cockpit-where" title={t.cwd}>
            {t.cwd.replace(/^\/Users\/[^/]+/, '~')}
            {branch && <span className="cockpit-branch">⎇ {branch}</span>}
          </span>
        </div>
        <div className={`cockpit-status ${f.tone}`} aria-live="polite">
          <span className="mono cockpit-flag">{f.text}</span>
          <span className="display cockpit-clock">
            {t.status === 'running' && t.started ? since(t.started) : t.last ? took(t.last.ms) : '—'}
          </span>
          <span className="mono cockpit-cmd">{t.status === 'running' ? t.command ?? 'running' : t.last ? `last: ${t.last.command}` : t.integrated ? 'ready' : 'this shell doesn’t report its commands'}</span>
        </div>
      </header>

      <div className="cockpit-dash">
        <div className="cockpit-tabs" role="tablist" aria-label="Terminal cars in this arena">
          {terminals.map((x) => {
            const xf = termFlag(x);
            return (
              <div key={x.id} className={`cockpit-tab ${xf.tone}${x.id === id ? ' on' : ''}`}>
                <button role="tab" aria-selected={x.id === id} className="cockpit-tab-pick" onClick={() => onSelect(x.id)} title={`${x.command ?? x.last?.command ?? x.shell} · ${xf.text}`}>
                  <span className="mono">{num.get(x.id)}</span>
                  <span className="cockpit-tab-name">{x.command ?? x.last?.command ?? x.shell}</span>
                  {x.ports.map((p) => (
                    <span key={p} className="mono cockpit-port">:{p}</span>
                  ))}
                </button>
                <button className="cockpit-tab-close" onClick={() => askClose(x.id)} aria-label={`Close ${num.get(x.id)} (⌘W)`} title="Close (⌘W)">
                  <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.4"><path d="M2 2l6 6M8 2l-6 6" /></svg>
                </button>
              </div>
            );
          })}
          <button className="cockpit-tab add" onClick={onNew} aria-label="New terminal car (⌘T)">+</button>
          <span className="cockpit-tabs-fill" />
          {t.ports.map((p) => (
            <a key={p} className="btn quiet cockpit-open" href={`http://localhost:${p}`} target="_blank" rel="noreferrer">Open :{p} ↗</a>
          ))}
          {failed && (
            <button className="btn cockpit-ask" onClick={() => onAsk(t)}>Ask Halo why it failed <span className="mono">⌘⇧H</span></button>
          )}
        </div>
        {closing && (() => {
          const x = terminals.find((y) => y.id === closing);
          return (
            <div className="cockpit-confirm" role="alertdialog" aria-label={`Close ${num.get(closing)}?`}>
              <span>
                {num.get(closing)} is still running <code>{x?.command ?? 'something'}</code>. Close it and stop that?
              </span>
              <button className="btn signal" onClick={() => close(closing)}>Close {num.get(closing)} <span className="mono">⌘W</span></button>
              <button className="btn quiet" onClick={() => setClosing(null)}>Keep it</button>
            </div>
          );
        })()}
        {closeError && <p className="cockpit-error" role="alert">{closeError}</p>}
        <Shell key={t.id} id={t.id} onTerm={(x) => (term.current = x)} />
        {t.status === 'exited' && (
          <div className="cockpit-ended">
            <span>The shell ended{t.exit !== null ? ` (exit ${t.exit})` : ''}.</span>
            <button className="btn solid" onClick={onNew}>New terminal car <span className="mono">⌘T</span></button>
            <button className="btn" onClick={() => close(t.id)}>Close it <span className="mono">⌘W</span></button>
          </div>
        )}
      </div>

      <footer className="cockpit-keys mono" aria-hidden>
        <span>⌘Return back to the arena</span>
        <span>⌘[ ⌘] other cars</span>
        <span>⌘T new car</span>
        <span>⌘W close car</span>
        <span>⌘K clear</span>
        <span>⌘⇧H ask Halo</span>
      </footer>
    </section>
  );
}
