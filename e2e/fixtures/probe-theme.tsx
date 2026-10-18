// A theme that tries every way out of its sandbox and reports what happened.
// e2e/run.mjs installs it to check the frame keeps a theme in.

import { api } from '@halo/ui/lib/api';
import type { ThemeProps } from '@halo/ui/kit/theme';
import { useEffect } from 'react';

export default function Theme({ halo }: ThemeProps) {
  // Every workspace count it's shown: the test checks live updates keep arriving.
  const workspaces = halo.state.workspaces.length;
  useEffect(() => window.parent.postMessage({ halo: 1, t: 'probe-ws', n: workspaces }, '*'), [workspaces]);
  useEffect(() => {
    const r: Record<string, string> = {};
    const t = async (k: string, f: () => unknown) => {
      try {
        const v = await f();
        r[k] = `allowed: ${String(v).slice(0, 60)}`;
      } catch (e) {
        r[k] = `blocked: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
      }
    };
    (async () => {
      await t('parentDocument', () => window.parent.document.title);
      await t('localStorage', () => localStorage.getItem('halo-theme'));
      await t('tauriInternals', () => {
        if ((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__) return 'present';
        throw new Error('absent');
      });
      await t('tauriIpc', () => fetch('ipc://localhost/plugin%3Aapp%7Cversion', { method: 'POST' }).then((x) => x.status));
      await t('internet', () => fetch('https://example.com/').then((x) => x.status));
      await t('otherRoute', () => fetch(new URL('/state', document.baseURI).href).then((x) => x.status));
      await t('ownBuild', () => fetch('theme.css').then((x) => x.status));
      await t('readState', () => api.state().then((s) => `lines=${s.lines.length}`));
      await t('openTerminal', () => api.terminalOpen(80, 24));
      await t('notACall', () => (api as unknown as Record<string, (n: number) => Promise<unknown>>).fitSummon(100));
      // Repeated: the listener in Halo's window may be installed after this starts.
      for (let i = 0; i < 20; i++) {
        window.parent.postMessage({ halo: 1, t: 'probe', r }, '*');
        await new Promise((res) => setTimeout(res, 500));
      }
    })();
  }, []);
  return <p style={{ color: '#fff', padding: 40 }}>Probing the sandbox…</p>;
}
