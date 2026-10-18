// Halo's whole conversation, filling the screen. It follows new words as
// they arrive (unless the person has scrolled up to read), and every star
// it mentions opens that star.

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Line } from '../lib/types';
import { clockAt } from '../lib/useHalo';
import { Md } from './Md';

/** "[AGENT DONE] s1abc "Title"\n…" → the agent's id, title and what happened.
 *  Older history says "[STAR LANDED]" for the same thing. */
export function parseWake(text: string): { id: string; title: string; what: string; body: string } | null {
  const m = text.match(/^\[(?:AGENT|STAR) ([A-Z ]+)\]\s*(\S+)\s*"([^"]*)"[:\s]*([\s\S]*)$/);
  if (!m) return null;
  const what = m[1].toLowerCase();
  return { what: what === 'landed' ? 'done' : what, id: m[2], title: m[3], body: m[4].replace(/^asks:\s*/, '').trim() };
}

/** Lines and marks in time order; a mark goes before the first line after it. */
function weave(lines: Line[], marks: Mark[]): ({ line: Line; i: number } | Mark)[] {
  const out: ({ line: Line; i: number } | Mark)[] = [];
  const ms = [...marks].sort((a, b) => a.ts - b.ts);
  let m = 0;
  lines.forEach((line, i) => {
    while (m < ms.length && ms[m].ts <= line.ts) out.push(ms[m++]);
    out.push({ line, i });
  });
  while (m < ms.length) out.push(ms[m++]);
  return out;
}

/** How far past the top the person has to keep pulling to go back to the galaxy. */
const PULL = 220;

const RADIO_WHAT: Record<string, string> = { done: 'crossed the line', 'needs you': 'boxing, needs you', failed: 'out of the run', stalled: 'slow, no word' };

/** Read as team radio (the Roadster theme): call signs and times on every line. */
/** Something to show in the thread at a moment that isn't a line: a car launching, say. */
export interface Mark {
  ts: number;
  key: string;
  node: ReactNode;
}

export function ThreadView({ lines, chunks, onStar, onBack, radio = false, marks = [], names }: { lines: Line[]; chunks: string[]; onStar: (id: string) => void; onBack: () => void; radio?: boolean; marks?: Mark[]; names?: { halo: string; back: string } }) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Pulling past the top: builds up while the person keeps scrolling up there,
  // drains away when they stop. The scroll that opened the thread doesn't count.
  const [pull, setPull] = useState(0);
  const pulled = useRef(0);
  const lastWheel = useRef(0);
  const openedAt = useRef(performance.now());

  useEffect(() => {
    if (pull <= 0) return;
    const t = setTimeout(() => {
      pulled.current = Math.max(0, pulled.current - 40);
      setPull(pulled.current);
    }, 160);
    return () => clearTimeout(t);
  }, [pull]);

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const now = performance.now();
    if (now - openedAt.current < 900) return;
    if (el.scrollTop <= 0 && e.deltaY < 0) {
      if (now - lastWheel.current > 400) pulled.current = 0;
      lastWheel.current = now;
      pulled.current += Math.min(60, -e.deltaY);
      setPull(pulled.current);
      if (pulled.current >= PULL) {
        pulled.current = 0;
        setPull(0);
        onBack();
      }
    } else if (e.deltaY > 0 && pulled.current > 0) {
      pulled.current = 0;
      setPull(0);
    }
  };

  // Open at the newest words; keep following them while the person is at the bottom.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight, behavior: lines.length && el.scrollTop > 0 ? 'smooth' : 'auto' });
  }, [lines.length, chunks.length]);

  return (
    <div ref={box} className={`threadview scroll${radio ? ' radio' : ''}`} onWheel={onWheel} onScroll={(e) => {
      const el = e.currentTarget;
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }}>
      <div className="threadview-col" style={{ transform: pull ? `translateY(${Math.min(pull, PULL) * 0.35}px)` : undefined, transition: pull ? 'none' : 'transform .4s ease' }}>
        <div className="pull-meter" aria-hidden style={{ opacity: pull ? 1 : 0 }}>
          <span className="mono">↑ keep pulling for the {names?.back ?? 'galaxy'}</span>
          <span className="pull-bar"><span style={{ width: `${Math.min(100, (pull / PULL) * 100)}%` }} /></span>
        </div>
        {lines.length === 0 && <p className="tv-empty">Nothing yet. Ask Halo anything below.</p>}
        {weave(lines, marks).map((item) => {
          if ('node' in item) return <div key={item.key} className="tv-mark">{item.node}</div>;
          const { line: l, i } = item;
          if (l.role === 'wake') {
            const w = parseWake(l.text);
            return (
              <button key={i} className="tv-wake" onClick={() => w && onStar(w.id)}>
                <span className="mono">{w ? `${w.title} · ${radio ? RADIO_WHAT[w.what] ?? w.what : w.what}` : l.text.split('\n')[0]}{radio && <span className="tv-time">{clockAt(l.ts)}</span>}</span>
                {w?.body && <span className="tv-wake-body">{w.body.length > 220 ? `${w.body.slice(0, 220)}…` : w.body}</span>}
              </button>
            );
          }
          return l.role === 'you' ? (
            <div key={i} className="tv-you">
              <span className="mono">{radio ? 'You · pit wall' : 'You'}{radio && <span className="tv-time">{clockAt(l.ts)}</span>}</span>
              <p>{l.text}</p>
            </div>
          ) : (
            radio ? (
              <div key={i} className="tv-call">
                <span className="mono">{names?.halo ?? 'Halo'}<span className="tv-time">{clockAt(l.ts)}</span></span>
                <Md className="tv-halo" text={l.text} />
              </div>
            ) : (
              <Md key={i} className="tv-halo" text={l.text} />
            )
          );
        })}
        {chunks.length > 0 && (
          <div className="tv-halo md">
            <p style={{ whiteSpace: 'pre-wrap' }}>
              {chunks.map((c, i) => (
                <span key={i} className="chunk">{c.replace(/\*\*/g, '')}</span>
              ))}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
