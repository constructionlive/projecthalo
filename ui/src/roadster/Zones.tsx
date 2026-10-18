// The circuit's three places and the map between them.
//
// - Course: the race (the scene), cars working.
// - Grid & pit: cars waiting to launch, and cars waiting on the person (answer
//   them here).
// - Paddock: finished cars, newest first, a page at a time.

import { useState } from 'react';

import { plain } from '../components/Md';
import { api } from '../lib/api';
import type { Star } from '../lib/types';
import { ago } from '../lib/useHalo';

export type Zone = 'course' | 'pit' | 'paddock';

export const parked = (s: Star) => s.status === 'landed' || s.status === 'failed' || s.status === 'stopped';
export const racing = (s: Star) => s.status === 'working';
export const waiting = (s: Star) => s.status === 'needsYou' || s.status === 'forming';

/** The circuit map: each place, its count, click to go there. */
/** `tod` null: this arena has only its own hour, so no day/night switch. */
export function TrackMap({ zone, counts, onGo, tod, onTod }: { zone: Zone; counts: Record<Zone, number>; onGo: (z: Zone) => void; tod: 'day' | 'night' | null; onTod: (t: 'day' | 'night') => void }) {
  const spot = (z: Zone, x: number, y: number) => (
    <g className={`map-spot${zone === z ? ' on' : ''}`}>
      <circle cx={x} cy={y} r={zone === z ? 7 : 5} />
    </g>
  );
  return (
    <nav className="track-map" aria-label="Circuit map">
      <svg viewBox="0 0 240 132" aria-hidden>
        {/* The circuit: a rounded loop; the pit lane inside the main straight; the paddock off it. */}
        <path className="map-track" d="M40 96 L176 96 C214 96 222 70 208 50 C196 32 170 30 150 40 L96 66 C78 75 58 70 46 58 C30 42 14 60 18 78 C21 90 30 96 40 96 Z" />
        <path className="map-pit" d="M60 108 L160 108" />
        <path className="map-paddock" d="M72 120 h16 M96 120 h16 M120 120 h16" />
        {spot('course', 208, 50)}
        {spot('pit', 110, 108)}
        {spot('paddock', 104, 120)}
      </svg>
      <div className="map-links">
        {(['course', 'pit', 'paddock'] as Zone[]).map((z) => (
          <button key={z} className={`mono${zone === z ? ' on' : ''}`} aria-current={zone === z ? 'true' : undefined} onClick={() => onGo(z)}>
            {z === 'course' ? 'Course' : z === 'pit' ? 'Grid & pit' : 'Paddock'} <span>{counts[z]}</span>
          </button>
        ))}
      </div>
      {tod && (
        <div className="map-links map-tools">
          <button className="mono" onClick={() => onTod(tod === 'day' ? 'night' : 'day')} aria-label={`Switch to ${tod === 'day' ? 'night' : 'day'}`}>{tod === 'day' ? '☾ Night' : '☀ Day'}</button>
        </div>
      )}
    </nav>
  );
}

function Answer({ star }: { star: Star }) {
  const [text, setText] = useState('');
  return (
    <form
      className="answer"
      onSubmit={async (e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t) return;
        setText('');
        await api.tell(star.id, t);
      }}
    >
      <label className="sr" htmlFor={`zone-ans-${star.id}`}>Answer {star.title}</label>
      <input id={`zone-ans-${star.id}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Radio back…" />
      <button className="btn signal" type="submit" disabled={!text.trim()}>Send</button>
    </form>
  );
}

/** Grid & pit: what's waiting on you first, then what's waiting to launch. */
export function PitZone({ stars, num, onOpen }: { stars: Star[]; num: Map<string, string>; onOpen: (id: string) => void }) {
  const pit = stars.filter((s) => s.status === 'needsYou').sort((a, b) => b.updated - a.updated);
  const grid = stars.filter((s) => s.status === 'forming');
  return (
    <section className="zone-panel" aria-label="Grid and pit">
      <header className="zone-head">
        <span className="display">Grid &amp; pit</span>
        <span className="mono">{pit.length} need you · {grid.length} on the grid</span>
      </header>
      <div className="scroll zone-list">
        {pit.length + grid.length === 0 && <p className="zone-empty">Nobody waiting. Cars that need an answer pull in here.</p>}
        {pit.map((s) => (
          <article key={s.id} className="zone-card pit">
            <button className="zone-card-top" onClick={() => onOpen(s.id)}>
              <span className="mono num">{num.get(s.id)}</span>
              <span className="name">{s.title}</span>
              <span className="mono flag">Needs you · {ago(s.updated)}</span>
            </button>
            <p className="zone-q">{s.question ?? s.now}</p>
            <Answer star={s} />
          </article>
        ))}
        {grid.map((s) => (
          <article key={s.id} className="zone-card">
            <button className="zone-card-top" onClick={() => onOpen(s.id)}>
              <span className="mono num">{num.get(s.id)}</span>
              <span className="name">{s.title}</span>
              <span className="mono flag go">On the grid</span>
            </button>
            <p className="zone-q">{plain(s.goal, 140)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

const PAGE = 8;

/** Paddock: finished cars, newest first, a page at a time. */
export function PaddockZone({ stars, num, onOpen }: { stars: Star[]; num: Map<string, string>; onOpen: (id: string) => void }) {
  const [shown, setShown] = useState(PAGE);
  const done = stars.filter(parked).sort((a, b) => b.updated - a.updated);
  return (
    <section className="zone-panel" aria-label="Paddock">
      <header className="zone-head">
        <span className="display">Paddock</span>
        <span className="mono">{done.length} finished</span>
      </header>
      <div className="scroll zone-list">
        {done.length === 0 && <p className="zone-empty">No finished cars yet.</p>}
        {done.slice(0, shown).map((s) => (
          <button key={s.id} className={`zone-card fin${s.status !== 'landed' ? ' out' : ''}`} onClick={() => onOpen(s.id)}>
            <span className="zone-card-top">
              <span className="mono num">{num.get(s.id)}</span>
              <span className="name">{s.title}</span>
              <span className="mono flag">{s.status === 'landed' ? 'Fin' : s.status === 'failed' ? 'DNF' : 'Out'} · {ago(s.updated)}</span>
            </span>
            <span className="zone-q">{plain(s.result ?? s.error ?? s.now, 150)}</span>
          </button>
        ))}
        {done.length > shown && (
          <button className="btn zone-more" onClick={() => setShown(shown + PAGE)}>
            Load {Math.min(PAGE, done.length - shown)} more <span className="mono">· {done.length - shown} left</span>
          </button>
        )}
      </div>
    </section>
  );
}
