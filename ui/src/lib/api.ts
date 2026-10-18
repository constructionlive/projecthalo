// The bridge to Halo's engine. Inside the app it calls Rust. In a browser it
// either talks to a running debug app over its dev bridge (`?bridge=http://…`,
// for end-to-end tests) or runs a small demo of the same shape (design work).

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { demo } from './demo';
import type { Access, Engine, Garage, HaloEvent, HaloState, HotkeyStatus, ModelChoice, Star, StarFile, SummonKey, Terminal, ThemeInfo, UpdateInfo, Workspace } from './types';

export const inApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const bridge = !inApp && typeof location !== 'undefined' ? new URLSearchParams(location.search).get('bridge') : null;

type Unlisten = () => void;

// In the demo, ?update shows the update chip.
const demoUpdate: UpdateInfo | null =
  typeof location !== 'undefined' && location.search.includes('update')
    ? { version: '0.2.0', current: '0.0.1', date: null, notes: 'Arenas for every workspace.\nTerminal cars.\nFaster switching.', critical: location.search.includes('critical') }
    : null;

// The Garage in the demo: remembered for the page only.
let demoGarage: Garage = { engine: 'claude', access: 'workspace', installed: ['claude', 'codex', 'opencode'] };

/** Where a custom theme's build is served from (null: it can't be, in the demo). */
export function themeBase(id: string): string | null {
  if (inApp) return `halotheme://localhost/${encodeURIComponent(id)}/`;
  if (bridge) return `${bridge}/theme/${encodeURIComponent(id)}/`;
  return null;
}

export interface TermReplay {
  at: number;
  data: Uint8Array;
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function viaBridge<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${bridge}${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error !== undefined) throw new Error(j.error);
  return j.ok as T;
}

function pick<T>(app: () => Promise<T>, path: string, body: unknown, offline: () => Promise<T>): Promise<T> {
  if (inApp) return app();
  if (bridge) return viaBridge<T>(path, body);
  return offline();
}

export const api = {
  state: () => pick(() => invoke<HaloState>('get_state'), '/state', undefined, () => demo.state()),
  ask: (text: string) => pick<void>(() => invoke('ask', { text }), '/ask', { text }, () => demo.ask(text)),
  tell: (id: string, text: string) => pick(() => invoke<string>('tell_star', { id, text }), '/tell', { id, text }, () => demo.tell(id, text)),
  stop: (id: string) => pick(() => invoke<string>('stop_star', { id }), '/stop', { id }, () => demo.stop(id)),
  cancel: () => pick<void>(() => invoke('cancel_halo'), '/cancel', {}, () => Promise.resolve()),
  hideSummon: () => pick<void>(() => invoke('hide_summon'), '/hide-summon', {}, () => Promise.resolve()),
  fitSummon: (height: number) => pick<void>(() => invoke('fit_summon', { height }), '/fit-summon', { height }, () => Promise.resolve()),
  hotkey: () => pick<HotkeyStatus>(() => invoke('hotkey_status'), '/hotkey', undefined, async () => ({ key: 'rightCommand', label: 'right ⌘', allowed: true, listening: true })),
  allowHotkey: () => pick<void>(() => invoke('open_input_monitoring'), '/allow-hotkey', {}, () => Promise.resolve()),
  setSummonKey: (key: SummonKey) => pick<void>(() => invoke('set_summon_key', { key }), '/summon-key', { key }, () => Promise.resolve()),
  starFiles: (id: string) => pick<StarFile[]>(() => invoke('star_files', { id }), '/star-files', { id }, async () => (id === 's3' ? [{ name: 'replies.md', size: 4200, modified: Date.now() }] : [])),
  openStarFile: (id: string, name: string | null, reveal: boolean) => pick<void>(() => invoke('open_star_file', { id, name, reveal }), '/noop', {}, () => Promise.resolve()),
  /** In `workspace` (an id), else the one in front; `'none'`: a folder of its own. */
  spawnStar: (goal: string, title?: string, engine?: string, workspace?: string, model?: string) =>
    pick<import('./types').Star>(
      () => invoke('spawn_star', { goal, title: title ?? null, engine: engine ?? null, model: model ?? null, workspace: workspace ?? null }),
      '/spawn',
      { goal, title, engine, model, workspace },
      () => demo.spawn(goal, title, engine as Engine | undefined, workspace, model),
    ),
  /** What an engine's CLI can run (asked once per app run; the first ask takes a few seconds). */
  engineModels: (engine: Engine) => pick<ModelChoice[]>(() => invoke('engine_models', { engine }), '/models', { engine }, () => demo.models(engine)),
  /** The macOS folder picker; null if the person cancelled. */
  pickWorkspace: () => pick<Workspace | null>(() => invoke('pick_workspace'), '/noop', {}, () => demo.pickWorkspace()),
  openWorkspace: (path: string) => pick<Workspace>(() => invoke('open_workspace', { path }), '/workspace-open', { path }, () => demo.openWorkspace(path)),
  closeWorkspace: (id: string) => pick<void>(() => invoke('close_workspace', { id }), '/workspace-close', { id }, () => demo.closeWorkspace(id)),
  /** A shell in `workspace` (an id), else the one in front; `'none'`: the home folder. */
  terminalOpen: (cols: number, rows: number, workspace?: string) =>
    pick<Terminal>(() => invoke('terminal_open', { workspace: workspace ?? null, cols, rows }), '/term-open', { workspace }, () => demo.terminalOpen(cols, rows, workspace)),
  terminalWrite: (id: string, data: string) => pick<void>(() => invoke('terminal_write', { id, data }), '/term-write', { id, data }, () => demo.terminalWrite(id, data)),
  terminalResize: (id: string, cols: number, rows: number) => pick<void>(() => invoke('terminal_resize', { id, cols, rows }), '/term-resize', { id, cols, rows }, () => Promise.resolve()),
  terminalClose: (id: string) => pick<void>(() => invoke('terminal_close', { id }), '/term-close', { id }, () => demo.terminalClose(id)),
  /** Everything it has printed so far, and where that ends in its whole output (`at`). */
  terminalReplay: async (id: string): Promise<TermReplay> => {
    if (inApp || bridge) {
      const r = inApp ? await invoke<{ at: number; data: string }>('terminal_replay', { id }) : await viaBridge<{ at: number; data: string }>('/term-replay', { id });
      return { at: r.at, data: fromB64(r.data) };
    }
    return demo.terminalReplay(id);
  },
  /** Output as it arrives, for every terminal: `at` is where the chunk starts in the whole output. */
  onTerminalData(cb: (id: string, at: number, data: Uint8Array) => void): Promise<Unlisten> {
    if (inApp) return listen<{ id: string; at: number; data: string }>('term', (e) => cb(e.payload.id, e.payload.at, fromB64(e.payload.data)));
    if (bridge) {
      // The dev bridge sends terminal output on its event stream, marked termData.
      const es = new EventSource(`${bridge}/events`);
      es.onmessage = (m) => {
        const e = JSON.parse(m.data);
        if (e.type === 'termData') cb(e.id, e.at, fromB64(e.data));
      };
      return Promise.resolve(() => es.close());
    }
    return Promise.resolve(demo.onTerminalData(cb));
  },
  /** A new theme, from a built-in ('blank', 'roadster', 'galaxy'), built once. */
  themeCreate: (name: string, from: string) => pick<ThemeInfo>(() => invoke('theme_create', { name, from }), '/theme-create', { name, from }, () => Promise.reject(new Error('Themes are made in the app.'))),
  themeBuild: (id: string) => pick<ThemeInfo>(() => invoke('theme_build', { id }), '/theme-build', { id }, () => Promise.reject(new Error('Themes are made in the app.'))),
  themeUndo: (id: string) => pick<ThemeInfo>(() => invoke('theme_undo', { id }), '/theme-undo', { id }, () => Promise.reject(new Error('Themes are made in the app.'))),
  themeDelete: (id: string) => pick<void>(() => invoke('theme_delete', { id }), '/theme-delete', { id }, () => Promise.reject(new Error('Themes are made in the app.'))),
  /** An agent that changes the theme as asked; it rebuilds as the agent saves. */
  themeCustomize: (id: string, request: string, engine?: Engine, model?: string) =>
    pick<Star>(() => invoke('theme_customize', { id, request, engine: engine ?? null, model: model ?? null }), '/theme-customize', { id, request, engine, model }, () => Promise.reject(new Error('Themes are made in the app.'))),
  /** Is there a newer Halo? null: this is the newest. */
  updateCheck: () => pick<UpdateInfo | null>(() => invoke('update_check'), '/noop', {}, async () => demoUpdate),
  /** Downloads, verifies and installs it, then Halo restarts. */
  updateInstall: () => pick<void>(() => invoke('update_install'), '/noop', {}, () => new Promise((r) => setTimeout(r, 1500))),
  appVersion: () => pick<string>(() => invoke('app_version'), '/noop', {}, async () => '0.0.1'),
  /** The workspace in front: Halo assumes it, and launches go there. */
  frontWorkspace: (id: string | null) => pick<void>(() => invoke('front_workspace', { id }), '/workspace-front', { id }, () => demo.frontWorkspace(id)),
  garage: () => pick<Garage>(() => invoke('get_garage'), '/garage', undefined, async () => demoGarage),
  setGarage: (engine?: Engine, access?: Access) =>
    pick<Garage>(() => invoke('set_garage', { engine: engine ?? null, access: access ?? null }), '/garage', { engine: engine ?? null, access: access ?? null }, async () => (demoGarage = { ...demoGarage, ...(engine && { engine }), ...(access && { access }) })),
  voiceStatus: () => pick<import('./useVoice').VoiceStatus>(() => invoke('voice_status'), '/voice-status', undefined, async () => ({ state: 'ready', model: 'parakeet-tdt-0.6b-v3', error: null, recording: false, transcribing: false })),
  voiceStart: (send: boolean) => pick<void>(() => invoke('voice_start', { send }), '/voice-start', { send }, () => Promise.resolve()),
  voiceStop: () => pick<void>(() => invoke('voice_stop'), '/voice-stop', {}, () => Promise.resolve()),
  openSky: (starId?: string) => pick<void>(() => invoke('open_sky', { starId: starId ?? null }), '/open-sky', { starId: starId ?? null }, () => Promise.resolve()),

  onEvent(cb: (e: HaloEvent) => void): Promise<Unlisten> {
    if (inApp) return listen<HaloEvent>('halo', (e) => cb(e.payload));
    if (bridge) {
      const es = new EventSource(`${bridge}/events`);
      es.onmessage = (m) => cb(JSON.parse(m.data) as HaloEvent);
      return Promise.resolve(() => es.close());
    }
    return Promise.resolve(demo.on(cb));
  },

  /** App-level signals: `select-star` (Sky), `summon-shown` (Summon). */
  on<T>(name: string, cb: (payload: T) => void): Promise<Unlisten> {
    return inApp ? listen<T>(name, (e) => cb(e.payload)) : Promise.resolve(() => {});
  },
};
