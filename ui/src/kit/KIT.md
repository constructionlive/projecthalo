# Halo theme kit (version 1)

A theme is the whole of Halo's window: how Halo, its agents, workspaces and
terminals look and feel, and how the person works with them. Halo's own worlds
(Galaxy, Roadster) are themes; so are the ones people make.

A theme is a folder of web code (TypeScript, React 19, CSS, optionally
three.js), built by Halo and run in a sandboxed frame in Halo's window.

## The folder

```
theme.json        name, description, permissions (see below)
src/index.tsx     the entry: export default function Theme(props: ThemeProps)
src/…             everything else it needs: components, CSS, images, video
dist/             the build (Halo writes it; never edit)
.kit/             read-only reference: this file and Halo's own UI source
```

## Building

    "<Halo>" --theme-build "<this folder>"

prints nothing but a time when it builds, or the errors (file:line: what's
wrong). Halo also rebuilds by itself whenever a file in `src/` changes, and the
window reloads the theme. A build that fails leaves the last good one showing,
so keep it building: fix errors before moving on. Every good build is kept;
the person can undo back through them.

## The entry

```tsx
import type { ThemeProps } from '@halo/ui/kit/theme';

export default function Theme({ halo, voice, draft, setDraft, now, switcher }: ThemeProps) {
  // halo.state: { busy, engine, lines, stars, workspaces, current, terminals, themes }
  // halo.stars: the agents (each: id, title, goal, status, now, question, result, log…)
  // halo.live / halo.chunks: what Halo is saying right now, as it streams
  // halo.ask(text): talk to Halo
  return <main>…</main>;
}
```

`ThemeProps` is in `.kit/ui/src/kit/theme.ts`; the types of everything
(`Star`, `Workspace`, `Terminal`, `Line`, events) are in
`.kit/ui/src/lib/types.ts`.

Words: Halo is the assistant; the background workers are **agents** (in the
Roadster world, cars). Never call them "stars" in the person's view.

## What a theme can do: `api`

```ts
import { api } from '@halo/ui/lib/api';
```

Every call goes to Halo, which answers only if the theme's `theme.json` lists
the permission it needs. A refused call rejects with a message saying which.

| permission   | calls                                                                       |
|--------------|-----------------------------------------------------------------------------|
| `read`       | `state()`, `garage()`, `appVersion()`, `engineModels(engine)`, `starFiles(id)`, `updateCheck()`, `hotkey()`, `voiceStatus()`; streams `onEvent`, `on('select-star')` |
| `ask`        | `ask(text)`, `cancel()`                                                     |
| `agents`     | `spawnStar(goal, title?, engine?, workspace?, model?)` (launch an agent), `tell(id, text)` (answer or redirect one), `stop(id)`, `openStarFile(id, name, reveal)` |
| `workspaces` | `pickWorkspace()`, `openWorkspace(path)`, `closeWorkspace(id)`, `frontWorkspace(id)` |
| `terminals`  | `terminalOpen(cols, rows, workspace?)`, `terminalWrite(id, text)`, `terminalResize(id, cols, rows)`, `terminalClose(id)`, `terminalReplay(id)`, stream `onTerminalData` |
| `voice`      | `voiceStart(send)`, `voiceStop()`; stream `on('voice')`                     |
| `settings`   | `setGarage(engine, access)`, `setSummonKey(key)`, `allowHotkey()`           |
| `app`        | `updateInstall()`                                                           |

Ask for the fewest permissions the theme needs. `useHalo()` (in
`@halo/ui/lib/useHalo`) needs `read`; most themes want `read`, `ask`, `agents`.

## Halo's own parts

Import anything from Halo's UI as `@halo/ui/…` (the source is in `.kit/ui/src`):

- `@halo/ui/components/ThreadView`: the conversation, with agent reports
- `@halo/ui/components/StarView`: one agent in full (goal, log, files, answer)
- `@halo/ui/components/LightStar`: the launch panel (who drives, which model)
- `@halo/ui/components/Md`: renders Halo's markdown
- `@halo/ui/roadster/TerminalCockpit`: a real terminal (xterm.js)
- `@halo/ui/lib/useHalo`: `useHalo()`, `ago(ms)`, `clock()`
- `@halo/ui/styles/halo.css`: Halo's base styles and tokens (`--ink`, `--signal`, `--display`, `--voice`, `--mono`…); the frame loads it

To learn how a full world is built, read `.kit/ui/src/roadster/` (a 3D world
with three.js: `scene.ts`, `Pier.tsx`) and `.kit/ui/src/sky/Sky.tsx` (Galaxy).

## Assets

Import images, video, fonts and models from `src/`:
`import url from './sky.jpg'` gives a URL to use in `<img>`, CSS or three.js.
Keep them reasonable (a few MB each).

## Rules

- **Offline and sandboxed.** The frame can load only the theme's own build: no
  network, no remote scripts, fonts or images, no `fetch` to other sites. Put
  everything the theme needs in `src/`.
- **No storage of its own.** `localStorage` isn't available in the frame; keep
  state in React, or in Halo (`api`).
- **Always a way back.** Halo puts a small Themes button in the corner of every
  custom theme; never cover the bottom-right 120 × 50 px.
- **"Needs you" must stay unmistakable.** An agent whose status is `needsYou`
  is waiting on the person: show its question clearly and let them answer
  (`api.tell`). No theme may hide it.
- **Works at any size**, from a phone-width window to a large display.
- **Accessible as drawn:** real `<button>`s and `<input>`s with labels; text
  readable against its background.
