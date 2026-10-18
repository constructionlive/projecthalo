// Inside a custom theme: the same `api` as the app's own (lib/api.ts), but
// every call is a message to Halo's window, which decides whether this theme
// may make it (the permissions in its theme.json) and answers. The theme runs
// in a sandboxed frame with no other way out.
//
// When a theme is built, this file stands in for lib/api.ts, so the app's own
// components and a forked built-in theme work here unchanged.

import type { api as HostApi, TermReplay } from '../lib/api';
import type { HaloEvent } from '../lib/types';

export type { TermReplay };

type Api = typeof HostApi;
type Unlisten = () => void;

/** Inside Halo's window: the frame is always drawn there. */
export const inApp = true;

let seq = 0;
const waiting = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>();
const eventListeners = new Set<(e: HaloEvent) => void>();
const termListeners = new Set<(id: string, at: number, data: Uint8Array) => void>();
const signalListeners = new Map<string, Set<(p: unknown) => void>>();

function post(msg: Record<string, unknown>) {
  window.parent.postMessage({ halo: 1, ...msg }, '*');
}

window.addEventListener('message', (ev) => {
  // Only Halo's window speaks to a theme.
  if (ev.source !== window.parent) return;
  const m = ev.data;
  if (!m || m.halo !== 1) return;
  if (m.t === 'ret') {
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error !== undefined) w.no(new Error(m.error));
    else w.ok(m.value);
  } else if (m.t === 'event') eventListeners.forEach((l) => l(m.e));
  else if (m.t === 'term') termListeners.forEach((l) => l(m.id, m.at, m.data));
  else if (m.t === 'signal') signalListeners.get(m.name)?.forEach((l) => l(m.payload));
});

function call(method: string, args: unknown[]): Promise<unknown> {
  const id = ++seq;
  return new Promise((ok, no) => {
    waiting.set(id, { ok, no });
    post({ t: 'call', id, method, args });
  });
}

const subscribe = {
  onEvent(cb: (e: HaloEvent) => void): Promise<Unlisten> {
    eventListeners.add(cb);
    post({ t: 'listen', name: 'halo' });
    return Promise.resolve(() => eventListeners.delete(cb));
  },
  onTerminalData(cb: (id: string, at: number, data: Uint8Array) => void): Promise<Unlisten> {
    termListeners.add(cb);
    post({ t: 'listen', name: 'term' });
    return Promise.resolve(() => termListeners.delete(cb));
  },
  on<T>(name: string, cb: (payload: T) => void): Promise<Unlisten> {
    const set = signalListeners.get(name) ?? new Set();
    signalListeners.set(name, set);
    const l = cb as (p: unknown) => void;
    set.add(l);
    post({ t: 'listen', name });
    return Promise.resolve(() => set.delete(l));
  },
};

/** Every other method: a call Halo answers (or refuses). */
export const api = new Proxy(subscribe, {
  get(target, name) {
    if (typeof name !== 'string') return undefined;
    if (name in target) return target[name as keyof typeof target];
    return (...args: unknown[]) => call(name, args);
  },
}) as unknown as Api;

/** Tells Halo the theme is up (else it offers to go back after a few seconds). */
export function themeReady() {
  post({ t: 'ready' });
}
