// The Workshop: where the person makes Halo look and work the way they want,
// by saying so. Pick a theme (a built-in, or one of theirs), say what to
// change, and an agent changes its code while the preview rebuilds live.
// Built-ins are never edited: customizing one makes the person's own copy.
// Every good build is kept, so a change can be undone.

import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../lib/api';
import type { ThemeKey } from '../lib/themeChoice';
import { ThemeFrame } from '../lib/themeHost';
import type { Star } from '../lib/types';
import type { useHalo } from '../lib/useHalo';
import { ago } from '../lib/useHalo';
import roadsterImage from '../roadster/plates/arena-bay.jpg';

type Halo = ReturnType<typeof useHalo>;

const BUILT_IN: { key: ThemeKey; from: string; name: string; note: string }[] = [
  { key: 'galaxy', from: 'galaxy', name: 'Galaxy', note: 'Halo and its agents as stars over the night.' },
  { key: 'roadster', from: 'roadster', name: 'Roadster', note: 'A season of arenas: agents race, terminals are red GTs.' },
];

const STARTS: [string, string, string][] = [
  ['blank', 'Blank', 'A plain page to grow from'],
  ['roadster', 'Roadster', 'A copy of the racing world'],
  ['galaxy', 'Galaxy', 'A copy of the night sky'],
];

/** A theme's agent: an agent working in its folder. */
const agentFor = (stars: Star[], id: string) =>
  [...stars].filter((s) => s.workspace === `theme:${id}`).sort((a, b) => b.created - a.created)[0];

interface Props {
  halo: Halo;
  current: ThemeKey;
  onUse: (t: ThemeKey) => void;
  onClose: () => void;
}

export function Workshop({ halo, current, onUse, onClose }: Props) {
  const themes = halo.state.themes;
  const [picked, setPicked] = useState<string>(current.startsWith('custom:') ? current.slice(7) : current);
  const [request, setRequest] = useState('');
  const [making, setMaking] = useState<{ name: string; from: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const mine = themes.find((t) => t.id === picked) ?? null;
  const builtIn = BUILT_IN.find((b) => b.key === picked) ?? null;
  const agent = mine ? agentFor(halo.stars, mine.id) : undefined;
  const working = agent && (agent.status === 'working' || agent.status === 'forming');

  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !making) onClose();
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [making, onClose]);
  useEffect(() => setConfirmDelete(false), [picked]);

  const run = async <T,>(f: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const create = async (name: string, from: string, then?: string) => {
    const t = await run(() => api.themeCreate(name, from));
    if (!t) return;
    setMaking(null);
    setPicked(t.id);
    if (then) await run(() => api.themeCustomize(t.id, then));
  };

  /** Say what to change: on a built-in, first make the person's own copy of it. */
  const change = async () => {
    const r = request.trim();
    if (!r || busy) return;
    setRequest('');
    if (mine) await run(() => api.themeCustomize(mine.id, r));
    else if (builtIn) await create(`My ${builtIn.name}`, builtIn.from, r);
  };

  const recent = useMemo(() => (agent ? agent.log.filter((l) => l.kind === 'said' || l.kind === 'tool' || l.kind === 'toolFailed').slice(-4) : []), [agent]);

  return (
    <section className="workshop" role="dialog" aria-label="Workshop: themes">
      <header className="ws-top">
        <div className="ws-title">
          <span className="mono ws-kicker">Workshop</span>
          <h1 className="display">Make Halo yours</h1>
        </div>
        <button className="btn quiet" onClick={onClose}>Close <span className="mono">esc</span></button>
      </header>

      <div className="ws-body">
        <nav className="ws-rail" aria-label="Themes">
          <span className="mono ws-label">Yours</span>
          {themes.length === 0 && <p className="ws-empty">None yet. Customize a built-in, or start one.</p>}
          {themes.map((t) => (
            <button key={t.id} className={`ws-card${picked === t.id ? ' on' : ''}`} onClick={() => setPicked(t.id)}>
              <span className="ws-swatch" style={{ background: swatch(t.id) }} aria-hidden />
              <span className="ws-card-text">
                <span className="ws-card-name">{t.name}</span>
                <span className="mono ws-card-meta">
                  {t.error ? <span className="bad">Build error</span> : `v${t.version}`}
                  {current === `custom:${t.id}` && <span className="in-use">In use</span>}
                  {agentFor(halo.stars, t.id)?.status === 'working' && <span className="live">Changing…</span>}
                </span>
              </span>
            </button>
          ))}
          {making ? (
            <form
              className="ws-new"
              onSubmit={(e) => {
                e.preventDefault();
                create(making.name, making.from);
              }}
            >
              <label className="mono ws-label" htmlFor="ws-name">New theme</label>
              <input id="ws-name" autoFocus value={making.name} onChange={(e) => setMaking({ ...making, name: e.target.value })} placeholder="Its name" />
              <div className="ws-starts" role="radiogroup" aria-label="Start from">
                {STARTS.map(([key, label, note]) => (
                  <button type="button" key={key} role="radio" aria-checked={making.from === key} className={`ws-start${making.from === key ? ' on' : ''}`} onClick={() => setMaking({ ...making, from: key })}>
                    <span>{label}</span>
                    <span className="ws-start-note">{note}</span>
                  </button>
                ))}
              </div>
              <div className="ws-row">
                <button className="btn solid" type="submit" disabled={busy || !making.name.trim()}>{busy ? 'Making…' : 'Make it'}</button>
                <button className="btn quiet" type="button" onClick={() => setMaking(null)}>Cancel</button>
              </div>
            </form>
          ) : (
            <button className="btn ws-add" onClick={() => setMaking({ name: '', from: 'blank' })}>+ New theme</button>
          )}

          <span className="mono ws-label">Built in</span>
          {BUILT_IN.map((b) => (
            <button key={b.key} className={`ws-card${picked === b.key ? ' on' : ''}`} onClick={() => setPicked(b.key)}>
              <span className="ws-swatch" style={{ background: b.key === 'roadster' ? `center/cover url(${roadsterImage})` : 'radial-gradient(circle at 50% 40%, #e6f0ff 0 3px, #20304e 4px, #0a0b0a 70%)' }} aria-hidden />
              <span className="ws-card-text">
                <span className="ws-card-name">{b.name}</span>
                <span className="mono ws-card-meta">{current === b.key ? <span className="in-use">In use</span> : 'Built in'}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="ws-main">
          <div className="ws-preview">
            {mine ? (
              mine.version > 0 ? (
                <ThemeFrame theme={mine} title={`Preview of ${mine.name}`} />
              ) : (
                <p className="ws-wait">Building its first version…</p>
              )
            ) : builtIn ? (
              <div className={`ws-builtin ${builtIn.key}`} style={builtIn.key === 'roadster' ? { backgroundImage: `linear-gradient(180deg, rgba(7,8,11,.05) 30%, rgba(7,8,11,.92) 85%), url(${roadsterImage})` } : undefined}>
                <span className="display">{builtIn.name}</span>
                <p>{builtIn.note}</p>
                <p className="ws-hint">Built-ins stay as they are. Say what you’d change below, and Halo makes your own copy and changes that.</p>
              </div>
            ) : null}
          </div>

          {mine && (
            <div className="ws-status" aria-live="polite">
              {mine.error ? (
                <details className="ws-error" open>
                  <summary>The latest change doesn’t build yet; the preview shows v{mine.version}.</summary>
                  <pre>{mine.error}</pre>
                </details>
              ) : (
                <span className="mono">v{mine.version} · built {mine.built ? ago(mine.built) : '—'} · {mine.ms} ms</span>
              )}
              {agent && (
                <div className={`ws-agent${working ? ' live' : ''}`}>
                  <span className="mono">{working ? 'Changing it' : agent.status === 'needsYou' ? 'Its agent asks' : 'Last change'}</span>
                  <span className="ws-agent-now">{agent.status === 'needsYou' ? agent.question : agent.now}</span>
                  {working && recent.map((l, i) => <span key={`${l.ts}-${i}`} className={`ws-agent-line ${l.kind}`}>{l.text}</span>)}
                </div>
              )}
            </div>
          )}

          <form className="ws-ask" onSubmit={(e) => (e.preventDefault(), change())}>
            <label className="sr" htmlFor="ws-ask">What should change?</label>
            <input
              ref={input}
              id="ws-ask"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              placeholder={mine ? `What should change in ${mine.name}?` : builtIn ? `What would you change in ${builtIn.name}?` : 'Pick a theme'}
              disabled={!mine && !builtIn}
              autoComplete="off"
            />
            <button className="btn solid" type="submit" disabled={!request.trim() || busy}>{busy ? '…' : 'Change it'}</button>
          </form>
          {error && <p className="ws-error-line" role="alert">{error}</p>}

          <div className="ws-actions">
            {mine && (
              <>
                <button className="btn" disabled={mine.version === 0} onClick={() => onUse(`custom:${mine.id}`)}>{current === `custom:${mine.id}` ? 'In use' : 'Use this theme'}</button>
                <button className="btn quiet" disabled={busy || mine.version < 2} onClick={() => run(() => api.themeUndo(mine.id))}>Undo last change</button>
                {confirmDelete ? (
                  <>
                    <span className="ws-confirm">Delete {mine.name} and its history?</span>
                    <button
                      className="btn signal"
                      onClick={async () => {
                        await run(() => api.themeDelete(mine.id));
                        if (current === `custom:${mine.id}`) onUse('roadster');
                        setPicked('roadster');
                      }}
                    >
                      Delete
                    </button>
                    <button className="btn quiet" onClick={() => setConfirmDelete(false)}>Keep</button>
                  </>
                ) : (
                  <button className="btn quiet ws-delete" onClick={() => setConfirmDelete(true)}>Delete…</button>
                )}
              </>
            )}
            {builtIn && <button className="btn" disabled={current === builtIn.key} onClick={() => onUse(builtIn.key)}>{current === builtIn.key ? 'In use' : 'Use this theme'}</button>}
          </div>
        </div>
      </div>
    </section>
  );
}

/** A colour of its own for each theme's card, from its id. */
function swatch(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `linear-gradient(135deg, hsl(${h % 360} 70% 55%), hsl(${(h >> 8) % 360} 60% 25%))`;
}
