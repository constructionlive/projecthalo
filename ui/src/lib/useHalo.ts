// Halo's state for a window: a snapshot from the engine, kept current by its events.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from './api';
import type { HaloEvent, HaloState, HotkeyStatus, Star } from './types';

const EMPTY: HaloState = { busy: false, engine: 'claude', lines: [], stars: [], workspaces: [], current: null, terminals: [], themes: [] };

export interface Halo {
  state: HaloState;
  /** Halo's reply in this turn, as it streams. */
  live: string;
  /** The same, in the pieces it arrived in (each fades in on its own). */
  chunks: string[];
  /** The tool Halo is using right now. */
  tool: string | null;
  error: string | null;
  stars: Star[];
  refresh: () => void;
  ask: (text: string) => Promise<void>;
}

export function prettyTool(name: string): string {
  return name.replace(/^mcp__desk__/, '').replace(/^desk_/, '').replace(/__/g, ' · ').replace(/_/g, ' ');
}

/** Pauses every animation while the window is hidden or in the background. */
export function useStillWhenAway() {
  useEffect(() => {
    const update = () => document.documentElement.classList.toggle('still', document.hidden || !document.hasFocus());
    update();
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
}

export function useHalo(): Halo {
  const [state, setState] = useState<HaloState>(EMPTY);
  const [live, setLive] = useState('');
  const [chunks, setChunks] = useState<string[]>([]);
  const [tool, setTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(() => {
    // Defaults first: an older engine (or a test fixture) may not send every field.
    api.state().then((s) => alive.current && setState({ ...EMPTY, ...s })).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    const onEvent = (e: HaloEvent) => {
      switch (e.type) {
        case 'turnStarted':
          setLive('');
          setChunks([]);
          setError(null);
          setState((s) => ({ ...s, busy: true }));
          refresh();
          break;
        case 'text':
          setLive((l) => l + e.delta);
          setChunks((c) => [...c, e.delta]);
          break;
        case 'tool':
          setTool(e.done ? null : prettyTool(e.name));
          break;
        case 'turnDone':
          setTool(null);
          setLive('');
          setChunks([]);
          refresh();
          break;
        case 'error':
          setError(e.message);
          break;
        case 'star':
          setState((s) => {
            const i = s.stars.findIndex((x) => x.id === e.star.id);
            const stars = i >= 0 ? s.stars.map((x) => (x.id === e.star.id ? e.star : x)) : [...s.stars, e.star];
            return { ...s, stars };
          });
          break;
        case 'workspaces':
          setState((s) => ({ ...s, workspaces: e.workspaces, current: e.current }));
          break;
        case 'terminal':
          setState((s) => {
            const has = s.terminals.some((t) => t.id === e.terminal.id);
            return { ...s, terminals: has ? s.terminals.map((t) => (t.id === e.terminal.id ? e.terminal : t)) : [...s.terminals, e.terminal] };
          });
          break;
        case 'terminalClosed':
          setState((s) => ({ ...s, terminals: s.terminals.filter((t) => t.id !== e.id) }));
          break;
        case 'theme':
          setState((s) => ({ ...s, themes: [e.theme, ...s.themes.filter((t) => t.id !== e.theme.id)] }));
          break;
        case 'themeRemoved':
          setState((s) => ({ ...s, themes: s.themes.filter((t) => t.id !== e.id) }));
          break;
      }
    };
    const off = api.onEvent(onEvent);
    return () => {
      alive.current = false;
      off.then((f) => f());
    };
  }, [refresh]);

  const ask = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) return;
      setError(null);
      await api.ask(t);
      refresh();
    },
    [refresh],
  );

  const stars = useMemo(() => [...state.stars].sort((a, b) => a.created - b.created), [state.stars]);
  return { state, live, chunks, tool, error, stars, refresh, ask };
}

/** The latest thing Halo said (or is saying). */
export function voiceOf(h: Halo): string {
  if (h.live.trim()) return h.live;
  const last = [...h.state.lines].reverse().find((l) => l.role === 'halo');
  return last?.text ?? '';
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** A moment as HH:MM, for radio logs. */
export function clockAt(ms: number): string {
  return new Date(ms).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function clock(d = new Date()): string {
  const day = d.toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} / ${time}`;
}

/** The summon key and whether macOS lets Halo hear it; follows changes live. */
export function useHotkey(): HotkeyStatus | null {
  const [status, setStatus] = useState<HotkeyStatus | null>(null);
  useEffect(() => {
    const load = () => api.hotkey().then(setStatus).catch(() => {});
    load();
    const off = api.on<HotkeyStatus>('hotkey', setStatus);
    const t = setInterval(load, 4000);
    return () => {
      clearInterval(t);
      off.then((f) => f());
    };
  }, []);
  return status;
}
