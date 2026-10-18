// Which world the window shows: a built-in, or a theme the person made.

/** Anything in the window can open the Workshop (themes, Customize). */
export const openWorkshop = () => window.dispatchEvent(new Event('halo-customize'));

export type ThemeKey = 'galaxy' | 'roadster' | `custom:${string}`;

export function savedTheme(): ThemeKey {
  try {
    const t = localStorage.getItem('halo-theme');
    if (t === 'roadster' || t === 'galaxy' || t?.startsWith('custom:')) return t as ThemeKey;
  } catch {
    /* fall through */
  }
  return 'galaxy';
}

export function saveTheme(t: ThemeKey) {
  try {
    localStorage.setItem('halo-theme', t);
  } catch {
    /* the choice just won't be remembered */
  }
}
