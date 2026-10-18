// What a custom theme is given: the same as the built-in worlds get.

import type { ReactNode } from 'react';

import type { useHalo } from '../lib/useHalo';
import type { Voice } from '../lib/useVoice';

export interface ThemeProps {
  /** Halo's state (thread, agents, workspaces, terminals) and what it is saying now. */
  halo: ReturnType<typeof useHalo>;
  voice: Voice;
  /** The ask line's text, kept across the theme's own views. */
  draft: string;
  setDraft: (s: string) => void;
  /** "Sun 18 Oct / 14:05", ticking. */
  now: string;
  /** Halo's own theme picker, where a theme wants to offer it (may be null). */
  switcher: ReactNode;
}
