// The conversation as a crawl: the newest words at the front, older ones
// gliding back and fading into the distance. Fixed height, so nothing around
// it moves; new words fade in where they land, and the rest slides up
// smoothly instead of jumping.

import { Fragment, useLayoutEffect, useRef } from 'react';

export interface CrawlEntry {
  key: string;
  role: 'you' | 'halo' | 'wake';
  text: string;
  /** While streaming: the pieces as they arrived (each fades in on its own). */
  chunks?: string[];
}

/** **bold** and `code`, with line breaks kept: the same layout while streaming and after. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') && p.length > 4 ? <strong key={i}>{p.slice(2, -2)}</strong> : p.startsWith('`') && p.endsWith('`') && p.length > 2 ? <code key={i}>{p.slice(1, -1)}</code> : <Fragment key={i}>{p}</Fragment>,
      )}
    </>
  );
}

function wakeLine(text: string): string {
  const m = text.match(/^\[(?:AGENT|STAR) ([A-Z ]+)\]\s*\S+\s*"([^"]*)"/);
  const what = m?.[1].toLowerCase();
  return m ? `${m[2]} · ${what === 'landed' ? 'done' : what}` : text.split('\n')[0];
}

export function Crawl({ entries, height, size = 24 }: { entries: CrawlEntry[]; height: number | string; size?: number }) {
  const mover = useRef<HTMLDivElement>(null);
  const last = useRef(0);

  useLayoutEffect(() => {
    const el = mover.current;
    if (!el) return;
    const h = el.offsetHeight;
    const grew = h - last.current;
    last.current = h;
    if (grew > 0 && grew < 600) {
      el.style.transition = 'none';
      el.style.transform = `translateY(${grew}px)`;
      void el.offsetHeight;
      el.style.transition = 'transform 0.55s cubic-bezier(0.2, 0.8, 0.2, 1)';
      el.style.transform = 'translateY(0)';
    }
  });

  return (
    <div className="crawl" style={{ height }}>
      <div className="crawl-plane">
        <div ref={mover} className="crawl-mover" style={{ fontSize: size }}>
          {entries.map((e) => (
            <div key={e.key} className={`crawl-${e.role}`}>
              {e.role === 'you' && <span className="mono crawl-who">You</span>}
              {e.role === 'wake' ? (
                <span className="mono">{wakeLine(e.text)}</span>
              ) : e.chunks ? (
                e.chunks.map((c, i) => (
                  <span key={i} className="chunk">
                    {c.replace(/\*\*/g, '')}
                  </span>
                ))
              ) : (
                <Inline text={e.text} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
