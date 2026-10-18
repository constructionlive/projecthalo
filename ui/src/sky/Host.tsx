// The window: Halo's state and voice, the ask line's draft and the clock, and
// which world shows them (Galaxy, Roadster, or a theme the person made). The
// Workshop, where themes are made by asking, opens over any of them; a custom
// theme always has a way back to it in the corner.

import { useCallback, useEffect, useState } from 'react';

import { Workshop } from '../components/Workshop';
import { type ThemeKey, savedTheme, saveTheme } from '../lib/themeChoice';
import { ThemeFrame } from '../lib/themeHost';
import { clock, useHalo, useStillWhenAway } from '../lib/useHalo';
import { useVoice } from '../lib/useVoice';
import { Roadster } from '../roadster/Roadster';
import { Sky } from './Sky';

export function Host() {
  useStillWhenAway();
  const halo = useHalo();
  const [theme, setThemeState] = useState<ThemeKey>(savedTheme);
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(clock());
  const [workshop, setWorkshop] = useState(false);
  const voice = useVoice((text, sent) => {
    if (!sent) setDraft((d) => (d.trim() ? `${d.trim()} ${text}` : text));
  });
  const setTheme = useCallback((t: ThemeKey) => {
    setThemeState(t);
    saveTheme(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(clock()), 20_000);
    const open = () => setWorkshop(true);
    window.addEventListener('halo-customize', open);
    return () => {
      clearInterval(t);
      window.removeEventListener('halo-customize', open);
    };
  }, []);

  const custom = theme.startsWith('custom:') ? halo.state.themes.find((t) => `custom:${t.id}` === theme) : undefined;
  // A theme that's gone (deleted, or not loaded yet in a fresh window) shows the Galaxy meanwhile.
  const shown: ThemeKey = theme.startsWith('custom:') && !custom ? 'galaxy' : theme;

  const switcher = (
    <div role="radiogroup" aria-label="Theme" className="theme-switch">
      {(
        [
          ['galaxy', 'Galaxy'],
          ['roadster', 'Roadster'],
          ...halo.state.themes.filter((t) => t.version > 0).map((t) => [`custom:${t.id}`, t.name] as [ThemeKey, string]),
        ] as [ThemeKey, string][]
      ).map(([id, label]) => (
        <button key={id} role="radio" aria-checked={shown === id} className={`mono${shown === id ? ' on' : ''}`} onClick={() => setTheme(id)}>
          {label}
        </button>
      ))}
      <button className="mono theme-switch-customize" onClick={() => setWorkshop(true)}>Customize…</button>
    </div>
  );
  const props = { halo, voice, draft, setDraft, now, switcher };

  return (
    <>
      {shown === 'roadster' ? (
        <Roadster {...props} />
      ) : custom ? (
        <>
          <ThemeFrame theme={custom} />
          <button className="host-corner mono" onClick={() => setWorkshop(true)} aria-label="Themes and Customize">
            <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" /></svg>
            Themes
          </button>
        </>
      ) : (
        <Sky {...props} />
      )}
      {workshop && <Workshop halo={halo} current={shown} onUse={setTheme} onClose={() => setWorkshop(false)} />}
    </>
  );
}
