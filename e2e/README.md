# Halo end-to-end tests

Halo's real UI (vite preview) drives the real engine inside a running debug
Halo.app through its dev bridge, on your own Claude Code (Haiku). Each run uses
its own data folder (`e2e/home`), never your real Halo data. Screenshots land
in `e2e/shots`.

```sh
cd crates/halo-app && APPLE_SIGNING_IDENTITY="Apple Development: …" cargo tauri build --debug   # the app under test
cd ui && npx vite preview --port 4173 &           # the UI under test
e2e/restart.sh fresh                              # isolated app, dev bridge on :47615
node e2e/run.mjs                                  # all scenarios (or: node e2e/run.mjs 3 4)
```

Not covered here: pressing the real left ⌘ / ⌘⇧Space (macOS won't let a
script send keys without Accessibility permission). The key logic has unit
tests in `crates/halo-app/src/hotkey.rs`; the windows it toggles are covered
by scenario 11.

Build the app under test **signed with the same identity as your everyday
Halo**. The test instance runs from the same bundle; an ad-hoc build there
changes Halo's signature, and macOS then drops its Input Monitoring and
microphone permissions until you switch Halo off and on again.

`node webkit-visual.mjs` checks the screens in WebKit (Halo's engine): the
thread, lighting a star and its birth, the crawl, and the summon panel.

## The Roadster world (`scene.mjs`)

Runs in WebKit (Halo's engine) against the built UI in demo mode
(`cd ui && npx vite build && npx vite preview --port 4173`); no Halo instance
needed. `?test` exposes the scene as `window.pier`, so the checks read every
car's pose and the scene's state:

- each workspace is drawn as its own arena, and its plates load;
- every car stands on the ground with a sane pose; racing cars stay on the
  circuit and never jump; parked cars stay put;
- terminals are red GTs that race while their command runs, park on Ctrl-C,
  and spin off then park retired when a command fails; hovering one shows its card;
- a new Claude Code agent launches (cutscene, ramp) and joins the race;
- the frame rate in every arena; switching arenas over and over holds no more
  graphics memory (textures, geometries);
- header, tower, map and captions never overlap at 1440, 1024 and 700 wide.

    node scene.mjs            # all checks
    SHOTS=1 node scene.mjs    # also saves frames to shots/scene-*.jpg
