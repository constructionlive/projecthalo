// The season: every workspace as an arena, each card live with how its cars
// are doing. Pick one to go there; open a folder to add one.

import { useEffect, useState } from 'react';

import { UpdateChip } from '../components/UpdateChip';
import { api, inApp } from '../lib/api';
import type { Star, Terminal, Workspace } from '../lib/types';
import { clock } from '../lib/useHalo';
import { ARENA, type ArenaStatus, FLAG_WORD, arenaOf, carsOf, loose, statusOf } from './arenas';

interface Props {
  workspaces: Workspace[];
  stars: Star[];
  terminals: Terminal[];
  /** The arena you came from (null: the loose cars), highlighted. */
  here: string | null | undefined;
  onGo: (id: string | null) => void;
  onRadio: () => void;
}

function Card({ w, cars, terms, status, keyHint, here, onGo }: { w: Workspace | null; cars: Star[]; terms: Terminal[]; status: ArenaStatus; keyHint: string; here: boolean; onGo: () => void }) {
  const arena = w ? arenaOf(w) : ARENA.bay;
  const [closing, setClosing] = useState(false);
  const label = w ? `${arena.name}: ${w.name}, ${FLAG_WORD[status.flag]}. ${status.line}` : `Own folders: ${cars.length} cars that belong to no workspace`;
  return (
    <div className={`arena-card ${status.flag}${w ? '' : ' loose'}${here ? ' here' : ''}`}>
      <img src={arena.image} alt="" loading="lazy" decoding="async" draggable={false} />
      <span className="arena-shade" aria-hidden />
      <button className="arena-open" onClick={onGo} aria-label={label}>
        <span className="mono arena-key" aria-hidden>{keyHint}</span>
        <span className="mono arena-flag" aria-hidden>
          <span className="dot" />
          {FLAG_WORD[status.flag]}
        </span>
        <span className="arena-body" aria-hidden>
          <span className="display arena-name">{w ? arena.name : 'Own folders'}</span>
          <span className="mono arena-repo">
            {w ? w.name : 'Halo'} <span className="arena-path">· {w ? w.path : 'each car in a folder of its own'}</span>
          </span>
          <span className="arena-facts mono">
            {w?.missing && <span className="chip warn">Folder missing</span>}
            {w?.branch && <span className="chip">⎇ {w.branch}{w.dirty ? ` ●${w.dirty}` : ''}</span>}
            {w && !w.branch && !w.missing && <span className="chip">Not a git repository</span>}
            <span>
              {cars.length === 1 ? '1 agent' : `${cars.length} agents`}
              {status.racing ? ` · ${status.racing} racing` : ''} · {terms.length === 1 ? '1 terminal' : `${terms.length} terminals`}
            </span>
            {terms.flatMap((t) => t.ports).map((p) => (
              <span key={p} className="chip port">:{p}</span>
            ))}
          </span>
          <span className="arena-line">{status.line}</span>
        </span>
      </button>
      {w && (
        <button
          className="arena-close mono"
          aria-label={`Close the ${w.name} workspace (its folder and cars stay as they are)`}
          disabled={closing}
          onClick={async () => {
            setClosing(true);
            try {
              await api.closeWorkspace(w.id);
            } finally {
              setClosing(false);
            }
          }}
        >
          Close
        </button>
      )}
    </div>
  );
}

export function Season({ workspaces, stars, terminals, here, onGo, onRadio }: Props) {
  const [now, setNow] = useState(clock());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(clock()), 15_000);
    return () => clearInterval(t);
  }, []);

  const rows = workspaces.map((w) => ({ w, cars: carsOf(stars, workspaces, w.id), terms: terminals.filter((t) => t.workspace === w.id) })).map((r) => ({ ...r, status: statusOf(r.cars) }));
  const openIds = new Set(workspaces.map((w) => w.id));
  const strayTerms = terminals.filter((t) => !t.workspace || !openIds.has(t.workspace));
  const strays = loose(stars, workspaces);
  const all = [...rows.map((r) => r.status), ...(strays.length ? [statusOf(strays)] : [])];
  const needs = all.reduce((n, s) => n + s.needs, 0);
  const red = all.filter((s) => s.flag === 'red').length;
  const racing = all.reduce((n, s) => n + s.racing, 0);

  const open = async () => {
    setError(null);
    try {
      const w = await api.pickWorkspace();
      if (w) onGo(w.id);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section className="season" aria-label="The season: every workspace">
      <header className="season-top" data-tauri-drag-region style={{ paddingTop: inApp ? 34 : 26 }}>
        <div className="season-title" data-tauri-drag-region style={{ paddingLeft: inApp ? 64 : 0 }}>
          <span className="mono season-when">Halo · {now}</span>
          <h1 className="display">The season</h1>
          <span className="mono season-sum">
            {workspaces.length} {workspaces.length === 1 ? 'arena' : 'arenas'} · {racing} racing
            {needs > 0 && <span className="needs"> · {needs} need{needs === 1 ? 's' : ''} you</span>}
            {red > 0 && <span className="red"> · {red} red flag{red === 1 ? '' : 's'}</span>}
          </span>
        </div>
        <div className="season-actions">
          <UpdateChip />
        <button className="btn season-radio" onClick={onRadio}>
          <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          Radio Halo
        </button>
        </div>
      </header>

      {rows.length === 0 && strays.length === 0 ? (
        <div className="season-empty">
          <img src={ARENA.bay.image} alt="" />
          <div className="season-empty-body">
            <h2 className="display">Open your first workspace</h2>
            <p>Pick a folder, usually a repository. It becomes an arena: agents you launch there work in that folder, and you can see them all from here.</p>
            <button className="btn solid" onClick={open}>Open a folder <span className="mono key">⌘N</span></button>
          </div>
        </div>
      ) : (
        <div className={`season-grid n${Math.min(rows.length + (strays.length ? 1 : 0), 5)}`}>
          {rows.map((r, i) => (
            <Card key={r.w.id} w={r.w} cars={r.cars} terms={r.terms} status={r.status} keyHint={i < 9 ? `⌘${i + 1}` : ''} here={here === r.w.id} onGo={() => onGo(r.w.id)} />
          ))}
          {strays.length > 0 && <Card w={null} cars={strays} terms={strayTerms} status={statusOf(strays)} keyHint="" here={here === null} onGo={() => onGo(null)} />}
        </div>
      )}

      <footer className="season-foot">
        {(rows.length > 0 || strays.length > 0) && (
          <button className="btn season-new" onClick={open}>
            <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 5v14M5 12h14" /></svg>
            New arena: open a folder <span className="mono key">⌘N</span>
          </button>
        )}
        {error && <span className="season-error" role="alert">{error}</span>}
        <span className="mono season-keys">⌘1–9 arena · ⌘0 the season · ⌘L launch</span>
      </footer>
    </section>
  );
}
