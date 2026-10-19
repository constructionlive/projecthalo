// The app's own shortcuts: ⌘-chords on macOS, Ctrl-chords elsewhere. In a
// terminal Ctrl belongs to the shell (Ctrl-C, Ctrl-L, Ctrl-W…), so there the
// app's chords are Ctrl+Shift, as in Windows Terminal.

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The summon key's name before the app has said which one it is. */
export const SUMMON_KEY = isMac ? 'right ⌘' : 'right Ctrl';

export interface Chord {
  /** 't', '1', '[', 'enter'… */
  key: string;
  shift: boolean;
}

const inTerminal = (e: KeyboardEvent) => e.target instanceof Element && !!e.target.closest('.xterm');

/** The key itself, whatever Shift makes of it (Ctrl+Shift+1 is "!" as a key). */
function keyName(e: KeyboardEvent): string {
  const c = e.code ?? '';
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (c === 'BracketLeft') return '[';
  if (c === 'BracketRight') return ']';
  if (c === 'Enter' || c === 'NumpadEnter') return 'enter';
  return e.key.toLowerCase();
}

/** The app chord this key press is, if it is one. */
export function chord(e: KeyboardEvent): Chord | null {
  if (e.altKey) return null;
  if (isMac) return e.metaKey && !e.ctrlKey ? { key: e.key.toLowerCase(), shift: e.shiftKey } : null;
  if (!e.ctrlKey || e.metaKey) return null;
  // In a terminal Shift is part of the chord, not a key of its own.
  if (inTerminal(e)) return e.shiftKey ? { key: keyName(e), shift: false } : null;
  return { key: keyName(e), shift: e.shiftKey };
}

/** A shortcut as this platform writes it: "⌘T" on macOS is "Ctrl+T" elsewhere ("Ctrl+Shift+T" in a terminal). */
export function shortcut(mac: string, terminal = false): string {
  if (isMac) return mac;
  return mac
    .replace(/⌘⇧/g, 'Ctrl+Shift+')
    .replace(/⌘/g, terminal ? 'Ctrl+Shift+' : 'Ctrl+')
    .replace(/Return|↩/g, 'Enter');
}
