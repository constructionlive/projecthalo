#!/usr/bin/env node
// Stages the theme kit that ships inside Halo (Halo.app/Contents/Resources/kit
// on macOS, beside halo.exe on Windows): what a custom theme is built from,
// and what the theme agent reads to learn.
//
//   kit/ui/src/        Halo's own UI source, read-only: the built-in themes to
//                      fork or learn from; lib/api.ts is the sandbox's (calls
//                      become messages to Halo's window)
//   kit/node_modules/  React, three.js, xterm, the fonts
//   kit/bin/esbuild    the compiler (esbuild.exe on Windows; pinned, from npm,
//                      integrity-checked by npm)
//   kit/KIT.md         how a theme works, for people and agents
//
// Run by the app build (tauri.conf.json's beforeBuildCommand); safe to rerun.
// Plain Node, so it runs wherever the app builds.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'crates/halo-app/kit');
const UI = join(ROOT, 'ui');
const ESBUILD_VERSION = '0.28.2';
const win = process.platform === 'win32';
const PKG = `@esbuild/${process.platform}-${process.arch}`;
const ESBUILD = join(OUT, 'bin', win ? 'esbuild.exe' : 'esbuild');

/** A fresh copy of a folder (what was there before goes). */
function mirror(from, to) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, filter: (p) => !p.endsWith('.DS_Store') });
}

mkdirSync(join(OUT, 'bin'), { recursive: true });
mirror(join(UI, 'src'), join(OUT, 'ui/src'));
// In a theme, the app's api is the sandbox's.
writeFileSync(
  join(OUT, 'ui/src/lib/api.ts'),
  `// In a custom theme the app's api is the sandbox's: every call is a message to
// Halo's window, which checks the theme's permissions and answers.
export { api, inApp, themeReady } from '../kit/api';
export type { TermReplay } from '../kit/api';
`,
);
// The app's public images (the starfield, the grain) beside the stylesheet that uses them.
for (const f of readdirSync(join(UI, 'public')).filter((f) => f.endsWith('.png'))) {
  copyFileSync(join(UI, 'public', f), join(OUT, 'ui/src/styles', f));
}
const css = join(OUT, 'ui/src/styles/halo.css');
writeFileSync(css, readFileSync(css, 'utf8').replace(/url\('\/([a-z-]*\.png)'\)/g, "url('./$1')"));
copyFileSync(join(UI, 'src/kit/KIT.md'), join(OUT, 'KIT.md'));
copyFileSync(join(UI, 'tsconfig.json'), join(OUT, 'ui/tsconfig.json'));

for (const m of ['react', 'react-dom', 'scheduler', '@xterm', '@fontsource']) {
  mirror(join(UI, 'node_modules', m), join(OUT, 'node_modules', m));
}
// three.js: the library and its add-ons, not its docs, editor or sources.
rmSync(join(OUT, 'node_modules/three'), { recursive: true, force: true });
mirror(join(UI, 'node_modules/three/build'), join(OUT, 'node_modules/three/build'));
mirror(join(UI, 'node_modules/three/examples/jsm'), join(OUT, 'node_modules/three/examples/jsm'));
copyFileSync(join(UI, 'node_modules/three/package.json'), join(OUT, 'node_modules/three/package.json'));

const version = () => {
  try {
    return execFileSync(ESBUILD, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
if (version() !== ESBUILD_VERSION) {
  const tmp = mkdtempSync(join(tmpdir(), 'halo-esbuild-'));
  // npm is npm.cmd on Windows, which only a shell runs.
  const tgz = execFileSync('npm', ['pack', `${PKG}@${ESBUILD_VERSION}`, '--silent'], { cwd: tmp, encoding: 'utf8', shell: win }).trim().split('\n').pop();
  execFileSync('tar', ['-xzf', tgz], { cwd: tmp });
  copyFileSync(join(tmp, 'package', win ? 'esbuild.exe' : 'bin/esbuild'), ESBUILD);
  if (!win) chmodSync(ESBUILD, 0o755);
  rmSync(tmp, { recursive: true, force: true });
}
// Apple notarizes an app only if every executable in it carries the app's signature
// (releases only: everyday builds run the kit's esbuild as it comes).
if (process.platform === 'darwin' && process.env.NOTARIZE === '1' && process.env.APPLE_SIGNING_IDENTITY) {
  execFileSync('codesign', ['--force', '--options', 'runtime', '--timestamp', '-s', process.env.APPLE_SIGNING_IDENTITY, ESBUILD], { stdio: 'inherit' });
}

const size = (p) => (statSync(p).isDirectory() ? readdirSync(p).reduce((n, f) => n + size(join(p, f)), 0) : statSync(p).size);
console.log(`kit staged: ${Math.round(size(OUT) / 1e6)} MB, esbuild ${version()}`);
if (!existsSync(join(OUT, 'ui/src/kit/main.tsx'))) throw new Error('the kit has no ui/src/kit/main.tsx');
