// The Roadster world for developers: a season of arenas, one per workspace.
// The pier is the arena in front; the season overlays it (the arena below
// pauses). Going to an arena brings its workspace to the front, so Halo
// assumes it and launches go there.
//
// ⌘0 the season · ⌘1–9 an arena · ⌘N open a folder · ⌘L launch · Esc back

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../lib/api';
import type { useHalo } from '../lib/useHalo';
import type { Voice } from '../lib/useVoice';
import { arenaOf, carsOf, loose } from './arenas';
import { Pier } from './Pier';
import { Season } from './Season';
import { chord } from '../lib/keys';

type Halo = ReturnType<typeof useHalo>;

interface Props {
  halo: Halo;
  voice: Voice;
  draft: string;
  setDraft: (s: string) => void;
  now: string;
  switcher: ReactNode;
}

/** Something the season asks the arena to do once it is there. */
export interface PierCommand {
  kind: 'launch' | 'radio';
  n: number;
}

export function Roadster({ halo, voice, draft, setDraft, now, switcher }: Props) {
  const { state } = halo;
  const { workspaces } = state;
  const [season, setSeason] = useState(false);
  // The arena asked for, until the engine's next word agrees (undefined: none pending).
  const [want, setWant] = useState<string | null | undefined>(undefined);
  const [command, setCommand] = useState<PierCommand | null>(null);
  const [error, setError] = useState<string | null>(null);

  const front = want !== undefined ? want : state.current;
  useEffect(() => {
    if (want !== undefined && state.current === want) setWant(undefined);
  }, [state.current, want]);

  const strays = useMemo(() => loose(halo.stars, workspaces), [halo.stars, workspaces]);
  // Nothing to show in any arena yet: the season is where you start.
  const empty = workspaces.length === 0 && strays.length === 0;
  const showSeason = season || empty;
  const arenaId = front && workspaces.some((w) => w.id === front) ? front : workspaces.length && !strays.length ? workspaces[0].id : null;
  const workspace = workspaces.find((w) => w.id === arenaId) ?? null;
  // The arena shown is the one in front for the engine too, so launches land where you are.
  useEffect(() => {
    if (want === undefined && arenaId !== null && arenaId !== state.current) api.frontWorkspace(arenaId).catch(() => {});
  }, [arenaId, state.current, want]);
  const cars = useMemo(() => carsOf(halo.stars, workspaces, arenaId), [halo.stars, workspaces, arenaId]);
  // Its shells too: a workspace's own, or (the loose arena) those that belong to none open.
  const terms = useMemo(() => {
    const open = new Set(workspaces.map((w) => w.id));
    return halo.state.terminals.filter((t) => (arenaId === null ? !t.workspace || !open.has(t.workspace) : t.workspace === arenaId));
  }, [halo.state.terminals, workspaces, arenaId]);
  const arenaHalo = useMemo<Halo>(() => ({ ...halo, stars: cars, state: { ...halo.state, stars: cars, terminals: terms } }), [halo, cars, terms]);

  const go = useCallback(
    async (id: string | null) => {
      setError(null);
      setWant(id);
      setSeason(false);
      try {
        await api.frontWorkspace(id);
      } catch (e) {
        setWant(undefined);
        setError(String(e));
      }
    },
    [],
  );
  const pick = useCallback(async () => {
    setError(null);
    try {
      const w = await api.pickWorkspace();
      if (w) go(w.id);
    } catch (e) {
      setError(String(e));
    }
  }, [go]);
  const ask = useCallback((kind: PierCommand['kind']) => {
    setSeason(false);
    setCommand((c) => ({ kind, n: (c?.n ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && season && !empty) {
        e.preventDefault();
        setSeason(false);
        return;
      }
      const c = chord(e);
      if (!c || c.shift) return;
      if (c.key === '0') {
        e.preventDefault();
        setSeason(true);
      } else if (/^[1-9]$/.test(c.key)) {
        const w = workspaces[Number(c.key) - 1];
        if (w) {
          e.preventDefault();
          go(w.id);
        }
      } else if (c.key === 'n') {
        e.preventDefault();
        pick();
      } else if (c.key === 'l' && !empty) {
        e.preventDefault();
        ask('launch');
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [season, empty, workspaces, go, pick, ask]);

  return (
    <>
      <Pier
        halo={arenaHalo}
        voice={voice}
        draft={draft}
        setDraft={setDraft}
        now={now}
        switcher={switcher}
        arena={{ id: arenaId, name: workspace ? arenaOf(workspace).name : 'Own folders', workspace }}
        away={showSeason}
        command={command}
        onSeason={() => setSeason(true)}
      />
      {showSeason && <Season workspaces={workspaces} stars={halo.stars} terminals={halo.state.terminals} here={empty ? undefined : arenaId} onGo={go} onRadio={() => ask('radio')} />}
      {error && (
        <p className="roadster-error" role="alert">
          {error} <button className="btn quiet" onClick={() => setError(null)}>Dismiss</button>
        </p>
      )}
    </>
  );
}
