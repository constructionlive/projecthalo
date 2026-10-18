// One star, filling the screen: its own thread (what it was asked, what it
// did, what it said), what it needs from the person, and what it made.
// The ask line at the bottom talks to this star while it's open.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { api } from '../lib/api';
import { colorOf, tagOf } from '../lib/stars';
import { ENGINE_NAME, type Star, type StarFile } from '../lib/types';
import { ago } from '../lib/useHalo';
import { Md } from './Md';

/** The words for each theme: a star in the galaxy, a car on the pier. */
const WORDS = {
  star: { asked: 'Asked', made: 'Made', none: 'Nothing yet. Files this star writes show up here.', stop: 'Stop this star', id: 'Star', turns: 'Turns', waiting: 'Waiting on you', landed: 'Landed', failed: 'Failed' },
  car: { asked: 'Brief', made: 'Payload', none: 'Nothing on board yet. Files this car writes show up here.', stop: 'Bring it in', id: 'Car', turns: 'Laps', waiting: 'In the pit · needs you', landed: 'Crossed the line', failed: 'Out of the run' },
};

export function StarView({ star, onboard = false }: { star: Star; onboard?: boolean }) {
  const w = WORDS[onboard ? 'car' : 'star'];
  const [files, setFiles] = useState<StarFile[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const open = star.status === 'working' || star.status === 'forming';

  useEffect(() => {
    api.starFiles(star.id).then(setFiles).catch(() => setFiles([]));
  }, [star.id, star.updated, star.status]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [star.log.length, star.status]);

  // A landed star's last words are its result, shown as the result: don't say them twice.
  const log = star.log.filter((l) => !(star.status === 'landed' && l.kind === 'said' && star.result?.startsWith(l.text.replace(/…$/, ''))));

  return (
    <div className={`starview${onboard ? ' onboard' : ''}`}>
      <div ref={box} className="starview-main scroll" onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}>
        <div className="starview-col">
          <div className="sv-head">
            <span className="mono" style={{ fontSize: 10, color: colorOf(star) }}>{tagOf(star)} <span className="sep">/</span> {ENGINE_NAME[star.engine]}{star.model ? ` · ${star.model}` : ''} <span className="sep">/</span> lit {ago(star.created)}</span>
            <h1 className="display">{star.title}</h1>
          </div>

          <div className="tv-you">
            <span className="mono">{w.asked}</span>
            <p>{star.goal}</p>
          </div>

          {log.map((l, i) =>
            l.kind === 'said' ? (
              <Md key={i} className="tv-halo" text={l.text} />
            ) : l.kind === 'you' ? (
              <div key={i} className="tv-you">
                <span className="mono">You</span>
                <p>{l.text}</p>
              </div>
            ) : (
              <div key={i} className={`sv-step sv-${l.kind}`}>
                <span className="mono">{l.kind === 'tool' ? '›' : l.kind === 'note' ? '·' : '!'}</span>
                <span>{l.text}</span>
              </div>
            ),
          )}

          {open && (
            <div className="sv-now">
              <span className="sv-pulse" aria-hidden />
              <span>{star.stalled ? `Quiet a while. Last: ${star.now}` : star.now}</span>
            </div>
          )}
          {star.status === 'needsYou' && star.question && (
            <div className="sv-card signal">
              <span className="mono">{w.waiting}</span>
              <p>{star.question}</p>
              <span className="mono" style={{ color: 'var(--faint)' }}>Answer below ↓</span>
            </div>
          )}
          {star.status === 'landed' && star.result && (
            <div className="sv-card">
              <span className="mono">{w.landed} · {ago(star.updated)}</span>
              <Md className="tv-halo" text={star.result} />
            </div>
          )}
          {star.error && (
            <div className="sv-card signal">
              <span className="mono">{w.failed}</span>
              <p>{star.error}</p>
            </div>
          )}
        </div>
      </div>

      <aside className="starview-side scroll">
        <div className="count-head">
          <span className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>{w.made}</span>
          <span className="num">{String(files.length).padStart(2, '0')}</span>
        </div>
        {files.length === 0 && <p style={{ fontSize: 13, color: 'var(--faint)' }}>{w.none}</p>}
        {files.slice(0, 30).map((f) => (
          <div key={f.name} className="sv-file">
            <button onClick={() => api.openStarFile(star.id, f.name, false)} title={`Open ${f.name}`}>{f.name}</button>
            <span className="mono">{f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`}</span>
            <button className="btn quiet" onClick={() => api.openStarFile(star.id, f.name, true)} aria-label={`Show ${f.name} in Finder`}>Show</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button className="btn" onClick={() => api.openStarFile(star.id, null, false)}>Open folder</button>
          {open && <button className="btn" onClick={() => api.stop(star.id)}>{w.stop}</button>}
        </div>
        <dl className="mono sv-meta">
          <dt>{w.id}</dt>
          <dd>{star.id}</dd>
          <dt>{w.turns}</dt>
          <dd>{star.turns}</dd>
          <dt>Last heard</dt>
          <dd>{ago(star.lastActivity)}</dd>
        </dl>
      </aside>
    </div>
  );
}
