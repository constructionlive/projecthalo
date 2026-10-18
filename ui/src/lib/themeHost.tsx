// A custom theme in Halo's window. The theme runs in a sandboxed frame:
// scripts only, no same origin (so nothing of Halo's window, its storage or
// its connection to the app), and a content policy that lets it load only its
// own build (no network: nothing can leave). It reaches Halo only by messages,
// and this side answers a call only when the theme's permissions allow it.

import { useEffect, useMemo, useRef, useState } from 'react';

import { api, themeBase } from './api';
import type { ThemeInfo } from './types';

/** Which permission each call needs. A call not listed here is never answered. */
export const CALLS: Record<string, string> = {
  state: 'read',
  hotkey: 'read',
  voiceStatus: 'read',
  garage: 'read',
  appVersion: 'read',
  engineModels: 'read',
  starFiles: 'read',
  updateCheck: 'read',
  ask: 'ask',
  cancel: 'ask',
  tell: 'agents',
  stop: 'agents',
  spawnStar: 'agents',
  openStarFile: 'agents',
  pickWorkspace: 'workspaces',
  openWorkspace: 'workspaces',
  closeWorkspace: 'workspaces',
  frontWorkspace: 'workspaces',
  terminalOpen: 'terminals',
  terminalWrite: 'terminals',
  terminalResize: 'terminals',
  terminalClose: 'terminals',
  terminalReplay: 'terminals',
  voiceStart: 'voice',
  voiceStop: 'voice',
  setGarage: 'settings',
  setSummonKey: 'settings',
  allowHotkey: 'settings',
  updateInstall: 'app',
};

/** Which permission each stream needs. */
export const STREAMS: Record<string, string> = {
  halo: 'read',
  'select-star': 'read',
  hotkey: 'read',
  'update-available': 'read',
  'update-progress': 'read',
  term: 'terminals',
  voice: 'voice',
  'voice-hold': 'voice',
};

/** The frame's document: the build, its base, and the content policy. */
function frameDoc(base: string, version: number): string {
  const policy = [
    `default-src 'none'`,
    `script-src ${base}`,
    `style-src ${base} 'unsafe-inline'`,
    `img-src ${base} data: blob:`,
    `font-src ${base} data:`,
    `media-src ${base} blob:`,
    `connect-src ${base}`,
    `worker-src blob:`,
  ].join('; ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><base href="${base}"><link rel="stylesheet" href="theme.css?v=${version}"></head><body><div id="root"></div><script type="module" src="theme.js?v=${version}"></script></body></html>`;
}

interface Props {
  theme: ThemeInfo;
  /** It didn't start, or it stopped with an error. */
  onTrouble?: (why: string) => void;
  title?: string;
}

export function ThemeFrame({ theme, onTrouble, title }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const base = themeBase(theme.id);
  const doc = useMemo(() => (base ? frameDoc(base, theme.version) : ''), [base, theme.version]);
  // By content: every theme event brings a new permissions array, and re-running the bridge
  // without reloading the frame would drop its subscriptions (it never asks again).
  const perms = theme.permissions.join('\n');
  const allowed = useMemo(() => new Set(perms.split('\n').filter(Boolean)), [perms]);
  // The latest callback, without resubscribing the bridge when the parent re-renders.
  const troubled = useRef(onTrouble);
  troubled.current = onTrouble;

  useEffect(() => {
    const win = () => frame.current?.contentWindow ?? null;
    const post = (msg: Record<string, unknown>) => win()?.postMessage({ halo: 1, ...msg }, '*');
    const subs = new Map<string, Promise<() => void>>();
    let ready = false;
    setTrouble(null);
    setStarted(false);
    const late = setTimeout(() => {
      if (ready) return;
      const why = 'It didn’t start within 10 seconds.';
      setTrouble(why);
      troubled.current?.(why);
    }, 10_000);

    const listen = (name: string) => {
      if (subs.has(name) || !allowed.has(STREAMS[name] ?? '\u0000')) return;
      if (name === 'halo') subs.set(name, api.onEvent((e) => post({ t: 'event', e })));
      else if (name === 'term') subs.set(name, api.onTerminalData((id, at, data) => post({ t: 'term', id, at, data })));
      else subs.set(name, api.on(name, (payload) => post({ t: 'signal', name, payload })));
    };

    const onMessage = async (ev: MessageEvent) => {
      // Only this frame, and only the shape the kit speaks.
      if (!win() || ev.source !== win()) return;
      const m = ev.data;
      if (!m || m.halo !== 1 || typeof m.t !== 'string') return;
      if (m.t === 'ready') {
        ready = true;
        setStarted(true);
        clearTimeout(late);
      } else if (m.t === 'error') {
        const why = String(m.message ?? 'It stopped with an error.').split('\n')[0];
        setTrouble(why);
        troubled.current?.(why);
      } else if (m.t === 'listen' && typeof m.name === 'string') listen(m.name);
      else if (m.t === 'call' && typeof m.method === 'string' && typeof m.id === 'number') {
        const need = Object.hasOwn(CALLS, m.method) ? CALLS[m.method] : null;
        if (!need || !allowed.has(need)) {
          post({ t: 'ret', id: m.id, error: `This theme may not use ${m.method}${need ? ` (needs the “${need}” permission in its theme.json)` : ''}.` });
          return;
        }
        try {
          const fn = (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m.method];
          const value = await fn(...(Array.isArray(m.args) ? m.args : []));
          post({ t: 'ret', id: m.id, value });
        } catch (e) {
          post({ t: 'ret', id: m.id, error: e instanceof Error ? e.message : String(e) });
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      clearTimeout(late);
      window.removeEventListener('message', onMessage);
      subs.forEach((off) => off.then((f) => f()));
    };
  }, [allowed, doc]);

  if (!base) return <p className="theme-frame-none">Custom themes run in the app.</p>;
  return (
    <div className="theme-frame" data-ready={started || undefined} data-theme={theme.id} data-version={theme.version}>
      <iframe ref={frame} title={title ?? theme.name} sandbox="allow-scripts" srcDoc={doc} />
      {trouble && (
        <div className="theme-trouble" role="alert">
          <strong>{theme.name}</strong> isn’t working: {trouble}
        </div>
      )}
    </div>
  );
}
