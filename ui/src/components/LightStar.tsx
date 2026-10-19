// Launch an agent yourself: say what it should do, pick who drives (the
// engine) and on what (the model), go. The last pick is remembered.

import { useEffect, useRef, useState } from 'react';

import { api } from '../lib/api';
import { ENGINE_NAME, type Engine, type ModelChoice } from '../lib/types';
import { chord, shortcut } from '../lib/keys';

/** The words, so a theme can say it its own way. */
export interface LightWords {
  title: string;
  go: string;
  placeholder: string;
}

const STAR_WORDS: LightWords = { title: 'Launch an agent', go: 'Launch', placeholder: 'What should it do? Be specific: files, names, what to hand back.' };
const ENGINES = Object.keys(ENGINE_NAME) as Engine[];
const PICK_KEY = 'halo-launch-pick';
/** More models than this read better as a list than as chips. */
const CHIPS_MAX = 6;

interface Pick {
  engine: Engine;
  /** The model last used with each engine. */
  models: Partial<Record<Engine, string>>;
}

function savedPick(): Pick | null {
  try {
    const p = JSON.parse(localStorage.getItem(PICK_KEY) ?? 'null');
    return p && ENGINES.includes(p.engine) ? p : null;
  } catch {
    return null;
  }
}

function savePick(p: Pick) {
  try {
    localStorage.setItem(PICK_KEY, JSON.stringify(p));
  } catch {
    /* not remembered */
  }
}

interface Props {
  engine: Engine;
  onDone: (id?: string) => void;
  words?: LightWords;
  /** Where it will work, e.g. "Mesa Night · billing". */
  where?: string;
  /** What each engine is in this world (the Roadster's cars). */
  kinds?: Partial<Record<Engine, string>>;
}

export function LightStar({ engine, onDone, words = STAR_WORDS, where, kinds }: Props) {
  const saved = useRef(savedPick());
  const [goal, setGoal] = useState('');
  const [title, setTitle] = useState('');
  const [eng, setEng] = useState<Engine>(saved.current?.engine ?? engine);
  const [chosen, setChosen] = useState<Partial<Record<Engine, string>>>(saved.current?.models ?? {});
  const [installed, setInstalled] = useState<Engine[] | null>(null);
  const [models, setModels] = useState<Partial<Record<Engine, ModelChoice[] | string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.garage().then((g) => setInstalled(g.installed)).catch(() => setInstalled(ENGINES));
  }, []);
  // A remembered engine that's no longer installed: fall back to the Garage's.
  useEffect(() => {
    if (installed && !installed.includes(eng)) setEng(installed.includes(engine) ? engine : installed[0] ?? engine);
  }, [installed, eng, engine]);
  // Each engine's models, asked once while the panel is open.
  useEffect(() => {
    if (models[eng] !== undefined || (installed && !installed.includes(eng))) return;
    let live = true;
    api
      .engineModels(eng)
      .then((list) => live && setModels((m) => ({ ...m, [eng]: list })))
      .catch((e) => live && setModels((m) => ({ ...m, [eng]: String(e) })));
    return () => {
      live = false;
    };
  }, [eng, models, installed]);

  const list = models[eng];
  const options = Array.isArray(list) ? list : [];
  // The remembered model, if this engine still offers it; else its first (the default).
  const model = options.find((m) => m.id === chosen[eng])?.id ?? options[0]?.id ?? '';
  const picked = options.find((m) => m.id === model);

  const launch = async () => {
    if (!goal.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const s = await api.spawnStar(goal.trim(), title.trim() || undefined, eng, undefined, model || undefined);
      savePick({ engine: eng, models: { ...chosen, [eng]: model } });
      onDone(s.id);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <form
      className="lightstar rise"
      aria-label={words.title}
      onSubmit={(e) => (e.preventDefault(), launch())}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone();
        if (chord(e.nativeEvent)?.key === 'enter') launch();
      }}
    >
      <div className="ls-head">
        <span className="display ls-title">{words.title}</span>
        {where && <span className="mono ls-where">into {where}</span>}
        <button type="button" className="btn quiet ls-cancel" onClick={() => onDone()}>Cancel · esc</button>
      </div>

      <label className="sr" htmlFor="ls-goal">What should it do?</label>
      <textarea id="ls-goal" autoFocus rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={words.placeholder} />

      <fieldset className="ls-field">
        <legend className="mono">Who drives</legend>
        <div className="ls-engines" role="radiogroup" aria-label="Engine">
          {ENGINES.map((k) => {
            const missing = !!installed && !installed.includes(k);
            return (
              <button key={k} type="button" role="radio" aria-checked={eng === k} disabled={missing} className={`ls-engine${eng === k ? ' on' : ''}`} onClick={() => setEng(k)}>
                {kinds?.[k] && <span className="mono ls-kind">{kinds[k]}</span>}
                <span className="ls-name">{ENGINE_NAME[k]}</span>
                <span className="mono ls-state">{installed === null ? '…' : missing ? 'Not installed' : 'Ready'}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="ls-field">
        <legend className="mono">Model</legend>
        {list === undefined ? (
          <div className="ls-models loading" aria-live="polite">
            <span className="mono">Asking {ENGINE_NAME[eng]} what it can run…</span>
          </div>
        ) : typeof list === 'string' ? (
          <p className="ls-note warn">Couldn’t list {ENGINE_NAME[eng]}’s models ({list}). It will use its default.</p>
        ) : options.length > CHIPS_MAX ? (
          <>
            <label className="sr" htmlFor="ls-model">Model</label>
            <select id="ls-model" className="ls-select" value={model} onChange={(e) => setChosen((c) => ({ ...c, [eng]: e.target.value }))}>
              {options.map((m) => (
                <option key={m.id || 'default'} value={m.id}>{m.label}{m.note ? ` · ${m.note}` : ''}</option>
              ))}
            </select>
          </>
        ) : (
          <div className="ls-models" role="radiogroup" aria-label="Model">
            {options.map((m) => (
              <button key={m.id || 'default'} type="button" role="radio" aria-checked={model === m.id} className={`ls-model${model === m.id ? ' on' : ''}`} onClick={() => setChosen((c) => ({ ...c, [eng]: m.id }))}>
                {m.label}
              </button>
            ))}
          </div>
        )}
        {picked?.note && options.length <= CHIPS_MAX && <p className="ls-note">{picked.note}</p>}
      </fieldset>

      <div className="ls-foot">
        <label className="sr" htmlFor="ls-title">Name (optional)</label>
        <input id="ls-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name (optional)" />
        <button type="submit" className="btn solid ls-go" disabled={!goal.trim() || busy}>
          {busy ? 'Launching…' : words.go} <span className="ls-key">{shortcut('⌘Return')}</span>
        </button>
      </div>
      {error && <span className="ls-error" role="alert">{error}</span>}
    </form>
  );
}
