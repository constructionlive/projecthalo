// Settings, set once: who does the work, how far it may reach, and which
// world you're in. Every new star (and Halo itself) runs on it until it's
// changed here. Each theme names it its own way: the Garage on the pier, the
// Observatory in the galaxy.

import { type ReactNode, useEffect, useState } from 'react';

import { api } from '../lib/api';
import { type Access, ENGINE_NAME, type Engine, type Garage } from '../lib/types';

/** The words, so a theme can say it its own way. */
export interface SettingsWords {
  title: string;
  note: string;
  engine: string;
  /** Under the engine that's picked. */
  picked: string;
  access: string;
  /** Own folder, then anywhere. */
  workspace: [string, string];
  full: [string, string];
  theme: string;
  foot: string;
}

export function Settings({ words, theme, className = '', onChange, onClose }: { words: SettingsWords; theme: ReactNode; className?: string; onChange: (g: Garage) => void; onClose: () => void }) {
  const [g, setG] = useState<Garage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const access: [Access, [string, string]][] = [['workspace', words.workspace], ['full', words.full]];

  useEffect(() => {
    api.garage().then(setG, (e) => setError(String(e)));
    const keys = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    window.addEventListener('keydown', keys, true);
    return () => window.removeEventListener('keydown', keys, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (engine?: Engine, access?: Access) => {
    try {
      const next = await api.setGarage(engine, access);
      setG(next);
      onChange(next);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section className={`settings ${className}`} aria-label={words.title}>
      <div className="settings-head">
        <span className="display" style={{ fontSize: 24 }}>{words.title}</span>
        <button type="button" className="btn quiet" onClick={onClose}>Done · esc</button>
      </div>
      <p className="settings-note">{words.note}</p>

      <span className="mono settings-label">{words.engine}</span>
      <div role="radiogroup" aria-label="Engine" className="settings-pick">
        {(Object.keys(ENGINE_NAME) as Engine[]).map((k) => {
          const missing = !!g && !g.installed.includes(k);
          return (
            <button key={k} type="button" role="radio" aria-checked={g?.engine === k} disabled={!g || missing} onClick={() => save(k)} className={g?.engine === k ? 'on' : ''}>
              <span>{ENGINE_NAME[k]}</span>
              <span className="mono">{missing ? 'not installed' : g?.engine === k ? words.picked : ''}</span>
            </button>
          );
        })}
      </div>

      <span className="mono settings-label">{words.access}</span>
      <div role="radiogroup" aria-label="Permissions" className="settings-pick col">
        {access.map(([key, [name, says]]) => (
          <button key={key} type="button" role="radio" aria-checked={g?.access === key} disabled={!g} onClick={() => save(undefined, key)} className={`${g?.access === key ? 'on' : ''}${key === 'full' ? ' warn' : ''}`}>
            <span>{name}</span>
            <span className="settings-says">{says}</span>
          </button>
        ))}
      </div>

      <span className="mono settings-label">{words.theme}</span>
      <div className="settings-theme">{theme}</div>

      <span className="mono settings-foot">{words.foot}</span>
      {error && <span style={{ color: 'var(--signal)', fontSize: 13 }}>{error}</span>}
    </section>
  );
}
