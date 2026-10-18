// The theme being built: esbuild points this at its entry (src/index.tsx).
declare module '@theme' {
  import type { ComponentType } from 'react';
  import type { ThemeProps } from './theme';
  const Theme: ComponentType<ThemeProps>;
  export default Theme;
}
