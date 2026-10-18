// Just enough Markdown for agent replies: paragraphs, bullet lists, tables, **bold**, `code`.

import type { ReactNode } from 'react';

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith('**') ? <strong key={k++}>{tok.slice(2, -2)}</strong> : <code key={k++}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const BULLET = /^\s*([-*•]|\d+\.)\s+/;
const ROW = /^\s*\|.*\|\s*$/;

/** One block split into runs of plain lines, list items and table rows. */
function runs(lines: string[]): { kind: 'p' | 'ul' | 'table'; lines: string[] }[] {
  const out: { kind: 'p' | 'ul' | 'table'; lines: string[] }[] = [];
  for (const l of lines) {
    const kind = ROW.test(l) ? 'table' : BULLET.test(l) ? 'ul' : 'p';
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.lines.push(l);
    else out.push({ kind, lines: [l] });
  }
  return out;
}

const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function Md({ text, className }: { text: string; className?: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className={`md ${className ?? ''}`}>
      {blocks.flatMap((b, i) =>
        runs(b.split('\n')).map((r, j) => {
          const key = `${i}.${j}`;
          if (r.kind === 'ul')
            return (
              <ul key={key}>
                {r.lines.map((l, n) => (
                  <li key={n}>{inline(l.replace(BULLET, ''))}</li>
                ))}
              </ul>
            );
          if (r.kind === 'table') {
            const rows = r.lines.filter((l) => !/^\s*\|[\s|:-]+\|\s*$/.test(l)).map(cells);
            const [head, ...body] = rows;
            return (
              <div key={key} className="md-table">
                <table>
                  <thead>
                    <tr>{head.map((c, n) => <th key={n}>{inline(c)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {body.map((row, m) => (
                      <tr key={m}>{row.map((c, n) => <td key={n}>{inline(c)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          return <p key={key}>{inline(r.lines.map((l) => l.replace(/^#+\s*/, '')).join(' '))}</p>;
        }),
      )}
    </div>
  );
}

/** Markdown down to one plain sentence or two, for a caption. */
export function plain(text: string, max = 150): string {
  const flat = text.replace(/\*\*|`|^#+\s*/gm, '').replace(/^\s*([-*•]|\d+\.)\s+/gm, '').replace(/^\s*\|.*$/gm, '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return stop > max * 0.45 ? cut.slice(0, stop + 1) : `${cut.replace(/\s\S*$/, '')}…`;
}
