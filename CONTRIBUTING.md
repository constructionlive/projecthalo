# Contributing to Halo

Thanks for helping. Halo is a desktop app (Rust and Tauri, with a React and
three.js UI) that runs the person's own coding agents. Changes are welcome,
from fixes to whole new themes.

## Set up

Follow "Build from source" in the [README](README.md). For the end-to-end
tests and signed builds, put this machine's signing setup in `.halo-dev.env`
at the repository root (git ignores it):

```sh
APPLE_SIGNING_IDENTITY="Apple Development: <you> (<team>)"   # everyday builds
HALO_TEAM_ID=<team>                                          # e2e refuses builds signed otherwise
RELEASE_SIGNING_IDENTITY="Developer ID Application: …"       # releases only
```

## Before you open a pull request

Every pull request runs these in CI; run them first:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p halo-core -p cc-agent
(cd ui && npx tsc --noEmit -p . && npx vite build)
```

For UI or scene changes, also run `node e2e/scene.mjs` (WebKit, no app needed)
and look at the result. For engine changes that touch agents, terminals or
themes, run the real end-to-end suite (`e2e/README.md`); it uses your own
Claude Code with a small model.

## How the code is written

- **Say what it is in the person's words.** Agents (not "stars", which is an
  internal name), workspaces, terminals. Comments explain why, not what.
- **Match the surrounding code**: its naming, its comment density, its idioms.
- **Nothing blocks the thread.** Long work is an agent; the UI never waits on one.
- **"Needs you" is sacred.** An agent waiting on the person must always be
  obvious, in every theme.
- **The person's machine is theirs.** Agents never push, merge, deploy or delete
  outside their job without an explicit OK; themes run sandboxed.
- **Test what you claim.** A behaviour change comes with a test that would have
  caught its absence.

## Themes

The easiest way to contribute is a theme. Make one in the app (Customize, or
the Workshop) or by hand following [`ui/src/kit/KIT.md`](ui/src/kit/KIT.md),
then open a pull request adding it under `ui/src/` with screenshots.

## Reporting a security issue

Please don't open a public issue for a vulnerability (for example a way for a
theme to escape its sandbox). Email dev@construction.live instead.
