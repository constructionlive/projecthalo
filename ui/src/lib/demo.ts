// A browser-only stand-in for the engine: same state and events, scripted.
// Never used inside the app.

import { makeShells } from './demoShell';
import type { ArenaKey, Engine, HaloEvent, HaloState, LogEntry, ModelChoice, Star, StarStatus, Terminal, Workspace } from './types';

const t0 = Date.now();
const min = (m: number) => t0 - m * 60_000;

function star(id: string, title: string, status: StarStatus, now: string, extra: Partial<Star> = {}): Star {
  return {
    id, title, goal: title, engine: 'claude', model: '', status, created: min(30), updated: min(1), lastActivity: min(1),
    stalled: false, now, question: null, result: null, error: null, turns: 1, log: [], ...extra,
  };
}

const log = (kind: LogEntry['kind'], text: string, m: number): LogEntry => ({ kind, text, ts: min(m) });

const ARENAS: ArenaKey[] = ['bay', 'mesa', 'porto', 'glace'];

function ws(id: string, name: string, path: string, arena: ArenaKey, branch: string | null, dirty: number, used: number): Workspace {
  return { id, name, path, arena, created: min(90_000), lastUsed: min(used), branch, dirty, missing: false };
}

/** Which workspace each demo star works in. */
const HOME: Record<string, string> = {
  s1: 'w2', s2: 'w2', s4: 'w2', s3: 'w2', s10: 'w2', s14: 'w2', s15: 'w2',
  s5: 'w3', s7: 'w3', s11: 'w3', s13: 'w3',
  s0: 'w1', s6: 'w1', s12: 'w1', s9: 'w1',
  s8: 'w4',
};

const state: HaloState = {
  busy: false,
  engine: 'claude',
  lines: [
    { role: 'you', text: 'Ship the billing v2 webhooks this week. Stripe retries are double-charging some accounts.', ts: min(40) },
    { role: 'halo', text: 'On it. I launched three agents: an idempotency fix for the webhook handler, a migration for the events table, and a review of open PR #482. Nothing gets pushed without your OK.', ts: min(39) },
    { role: 'wake', text: '[AGENT NEEDS YOU] s4 "Events table migration" asks: Run the backfill against staging now? It locks the table for about 40 s.', ts: min(3) },
    { role: 'halo', text: 'The migration is ready but the backfill locks events for about 40 s on staging, so it’s waiting for your go. The idempotency fix is past halfway and 212 of 214 tests pass.', ts: min(3) },
  ],
  stars: [
    star('s1', 'Webhook idempotency', 'working', 'Running cargo test billing::webhooks, 212 of 214 pass', {
      created: min(38), turns: 1,
      goal: 'In ~/code/billing on a new branch fix/webhook-idempotency: Stripe retries the same event and we charge twice. Key handling on event.id, add a test that replays an event, run the billing tests.',
      log: [log('tool', 'git switch -c fix/webhook-idempotency', 37), log('tool', 'rg "fn handle_event" src/', 36), log('said', 'The handler commits the charge before it records the event id, so a retry inside 2 s charges again.', 33), log('tool', 'edit src/webhooks/stripe.rs', 30), log('said', 'Recording the event id in the same transaction now, with a unique index.', 29), log('tool', 'cargo test billing::webhooks', 2)],
    }),
    star('s2', 'Review PR #482', 'working', 'Reading the diff: 14 files, +612 −90', { engine: 'opencode', created: min(37) }),
    star('s4', 'Events table migration', 'needsYou', 'Run the backfill on staging?', { question: 'The migration and backfill are ready. Run the backfill against staging now? It locks the events table for about 40 s.', created: min(36) }),
    star('s3', 'Flaky auth test', 'landed', 'Fixed: a clock race in token expiry', { engine: 'codex', result: 'test_refresh_expired was racing the clock; it now uses a fixed clock. 50 runs green on branch fix/auth-flake.', created: min(200), updated: min(190) }),
    star('s5', 'Upgrade to React 19', 'working', 'Fixing 9 type errors in ui/src/forms', { created: min(20) }),
    star('s0', 'Arena calendar design', 'working', 'Season board: 2 boards to go', { created: min(14) }),
    star('s15', 'Retry backoff docs', 'working', 'Writing docs/webhooks.md', { engine: 'codex', created: min(9) }),
    // Older, finished: cooling, then remnants.
    star('s6', 'Bump tokio to 1.48', 'landed', 'All crates build, tests green', { result: 'Bumped tokio to 1.48 across 6 crates; tests green on chore/tokio-1.48.', created: min(900), updated: min(840) }),
    star('s7', 'Profile slow /search', 'landed', 'p95 1.8 s → 240 ms', { engine: 'codex', result: 'An N+1 on tags; one join brings p95 from 1.8 s to 240 ms. Branch perf/search-tags.', created: min(4400), updated: min(4300) }),
    star('s8', 'Fix CI on arm64', 'failed', 'Runner image has no protoc', { error: 'The arm64 runner image has no protoc and I can’t change the runner settings.', created: min(7300), updated: min(7200) }),
    star('s10', 'API docs for /v2/invoices', 'landed', 'OpenAPI spec and examples written', { result: 'OpenAPI spec for /v2/invoices with 6 examples; docs build passes.', created: min(3800), updated: min(3700) }),
    star('s11', 'Dependabot sweep', 'landed', '11 PRs merged locally, 2 held', { engine: 'opencode', result: '11 updates pass; 2 (serde_yaml, openssl) held for breaking changes.', created: min(19000), updated: min(18800) }),
    star('s12', 'Rewrite the CLI parser', 'stopped', 'Stopped by you', { created: min(23000), updated: min(22900) }),
    star('s13', 'Dark mode for settings', 'landed', '48 components themed', { result: 'All 48 settings components use the theme tokens; screenshots in shots/.', created: min(52000), updated: min(51000) }),
    star('s14', 'Error tracking triage', 'landed', 'Top 14 errors grouped', { engine: 'codex', result: 'The top 14 Sentry errors come from 3 causes; fixes drafted for 2.', created: min(88000), updated: min(86000) }),
    star('s9', 'Clean up feature flags', 'landed', '31 stale flags removed', { result: '31 flags fully rolled out for 90+ days removed; tests green.', created: min(13000), updated: min(12960) }),
  ],
  workspaces: [
    ws('w1', 'command-center', '~/Documents/command-center', 'bay', 'developers', 2, 30),
    ws('w2', 'billing', '~/code/billing', 'mesa', 'fix/webhook-idempotency', 4, 1),
    ws('w3', 'web', '~/code/web', 'porto', 'chore/react-19', 9, 60),
    ws('w4', 'infra', '~/code/infra', 'glace', 'main', 0, 600),
  ],
  current: 'w2',
  terminals: [],
  themes: [],
};
for (const s of state.stars) {
  s.workspace = HOME[s.id] ?? null;
  s.cwd = state.workspaces.find((w) => w.id === s.workspace)?.path ?? null;
}

let listeners: ((e: HaloEvent) => void)[] = [];
const emit = (e: HaloEvent) => listeners.forEach((l) => l(e));
const later = (ms: number, f: () => void) => setTimeout(f, ms);

// The demo's shells: a few already open, as on a working afternoon.
const shells = makeShells(emit, () => state.terminals, (t) => (state.terminals = t));
function term(id: string, workspace: string, extra: Partial<Terminal>): Terminal {
  const w = state.workspaces.find((x) => x.id === workspace)!;
  return { id, workspace, cwd: w.path, shell: 'zsh', status: 'idle', command: null, started: null, last: null, runs: 1, ports: [], integrated: true, exit: null, created: min(120), ...extra };
}
const FAILED_TEST = 'cargo test billing::webhooks\r\n\x1b[32m    Finished\x1b[0m `test` profile in 6.12s\r\ntest webhooks::records_event_id_in_same_tx ... \x1b[32mok\x1b[0m\r\ntest webhooks::retries_after_timeout ... \x1b[31mFAILED\x1b[0m\r\n\r\nthread \'webhooks::retries_after_timeout\' panicked at src/webhooks/stripe.rs:212:9:\r\nassertion `left == right` failed: retry fired before the 2 s backoff\r\n\r\ntest result: \x1b[31mFAILED\x1b[0m. 212 passed; 2 failed; finished in 1.84s\r\n';
for (const [t, branch, history] of [
  [term('t1', 'w2', { status: 'running', command: 'cargo watch -x test', started: min(50), runs: 14 }), 'fix/webhook-idempotency', '\x1b[32m[Running \'cargo test\']\x1b[0m\r\ntest result: ok. 212 passed; 2 failed\r\n\x1b[32m[Finished running. Exit status: 101]\x1b[0m\r\n'],
  [term('t2', 'w2', { status: 'running', command: 'npm run dev', started: min(124), ports: [4000] }), 'fix/webhook-idempotency', '\r\n  \x1b[1mbilling-api\x1b[0m listening on http://localhost:4000\r\n  POST /webhooks/stripe 200 41ms\r\n  POST /webhooks/stripe 200 38ms\r\n'],
  [term('t3', 'w2', { runs: 3, last: { command: 'cargo test billing::webhooks', exit: 101, ms: 7960, ended: min(2) } }), 'fix/webhook-idempotency', FAILED_TEST],
  [term('t4', 'w3', { status: 'running', command: 'npm run dev', started: min(200), ports: [3000] }), 'chore/react-19', '\r\n  \x1b[1mnext\x1b[0m ready on http://localhost:3000\r\n'],
  [term('t5', 'w3', { status: 'running', command: 'npm run storybook', started: min(190), ports: [6006] }), 'chore/react-19', '\r\nStorybook 9.1 started on http://localhost:6006\r\n'],
  [term('t6', 'w4', { runs: 1, last: { command: 'cargo build --release', exit: 101, ms: 41_200, ended: min(25) } }), 'main', 'error: failed to run custom build command for `proto-gen`\r\n  Could not find `protoc`. If `protoc` is installed, try setting the `PROTOC` environment variable.\r\n'],
  [term('t7', 'w1', { status: 'running', command: 'npx vite preview --port 4173', started: min(80), ports: [4173] }), 'developers', '\r\n  ➜  Local:   http://localhost:4173/\r\n'],
] as [Terminal, string, string][]) {
  state.terminals.push(t);
  shells.seed(t, branch, history);
}
const upsert = (s: Star) => {
  const i = state.stars.findIndex((x) => x.id === s.id);
  if (i >= 0) state.stars[i] = s;
  else state.stars.push(s);
  emit({ type: 'star', star: { ...s } });
};

function stream(text: string, done: () => void) {
  const words = text.split(/(?<= )/);
  let i = 0;
  const tick = () => {
    if (i >= words.length) return done();
    emit({ type: 'text', delta: words[i++] });
    later(45, tick);
  };
  tick();
}

function haloTurn(reason: 'you' | 'wake', input: string, reply: string, after?: () => void) {
  state.busy = true;
  emit({ type: 'turnStarted', reason, text: input });
  later(500, () =>
    stream(reply, () => {
      state.lines.push({ role: 'halo', text: reply, ts: Date.now() });
      state.busy = false;
      emit({ type: 'turnDone' });
      after?.();
    }),
  );
}

let seq = 16;

const m = (id: string, label: string, note: string): ModelChoice => ({ id, label, note });
const DEMO_MODELS: Record<Engine, ModelChoice[]> = {
  claude: [m('', 'Default', 'Whatever your plan uses by default'), m('fable', 'Fable', 'Largest model'), m('opus', 'Opus', 'Strongest for careful work'), m('sonnet', 'Sonnet', 'Fast and capable'), m('haiku', 'Haiku', 'Fastest, lightest')],
  codex: [m('', 'Default', 'The model set in your Codex config'), m('gpt-5.5-codex', 'GPT-5.5 Codex', 'Tuned for agentic coding'), m('gpt-5.5', 'GPT-5.5', 'General reasoning'), m('gpt-5.5-mini', 'GPT-5.5 mini', 'Faster, cheaper')],
  opencode: [m('opencode/big-pickle', 'Big Pickle', 'Free'), m('opencode/grok-code', 'Grok Code Fast', 'Free'), m('anthropic/claude-sonnet-5-5', 'Claude Sonnet 5.5', 'via anthropic'), m('openai/gpt-5.5', 'GPT-5.5', 'via openai')],
};

const emitWorkspaces = () => emit({ type: 'workspaces', workspaces: state.workspaces.map((w) => ({ ...w })), current: state.current });

/** Where a new star goes: the workspace asked for, else the one in front. */
function placeOf(workspace?: string): Pick<Star, 'workspace' | 'cwd'> {
  const id = workspace === 'none' ? null : workspace ?? state.current;
  return { workspace: id, cwd: state.workspaces.find((w) => w.id === id)?.path ?? null };
}

function openFolder(path: string): Workspace {
  const have = state.workspaces.find((w) => w.path === path);
  if (have) return have;
  const used = state.workspaces.map((w) => w.arena);
  const arena = ARENAS.find((a) => !used.includes(a)) ?? ARENAS[state.workspaces.length % ARENAS.length];
  const w: Workspace = { id: `w${seq++}`, name: path.split('/').filter(Boolean).pop() ?? path, path, arena, created: Date.now(), lastUsed: Date.now(), branch: 'main', dirty: 0, missing: false };
  state.workspaces.push(w);
  state.current = w.id;
  emitWorkspaces();
  return w;
}

export const demo = {
  state: async (): Promise<HaloState> => JSON.parse(JSON.stringify(state)),
  on(cb: (e: HaloEvent) => void) {
    listeners.push(cb);
    return () => {
      listeners = listeners.filter((l) => l !== cb);
    };
  },
  async ask(text: string) {
    state.lines.push({ role: 'you', text, ts: Date.now() });
    const title = text.length > 28 ? `${text.slice(0, 27)}…` : text;
    haloTurn('you', text, 'On it. I launched an agent for that and I’ll tell you when it’s done.', () => {
      const s = star(`s${seq++}`, title, 'working', 'Starting', { created: Date.now(), lastActivity: Date.now(), ...placeOf() });
      upsert(s);
      later(2500, () => upsert({ ...s, now: 'Reading the code', lastActivity: Date.now(), log: [log('tool', 'rg --files', 0)] }));
      later(12000, () => {
        upsert({ ...s, status: 'landed', now: 'Done: summary written to summary.md', result: 'Done. The summary is in summary.md.', updated: Date.now() });
        const wake = `[AGENT DONE] ${s.id} "${s.title}"\nDone. The summary is in summary.md.`;
        state.lines.push({ role: 'wake', text: wake, ts: Date.now() });
        haloTurn('wake', wake, `“${s.title}” is done. The summary is in summary.md.`);
      });
    });
  },
  async models(engine: Engine): Promise<ModelChoice[]> {
    await new Promise((r) => setTimeout(r, engine === 'claude' ? 0 : 700));
    return DEMO_MODELS[engine];
  },
  async spawn(goal: string, title?: string, engine?: Star['engine'], workspace?: string, model?: string) {
    const s = star(`s${seq++}`, title || goal.split(' ').slice(0, 4).join(' '), 'working', 'Starting', { goal, engine: engine ?? 'claude', model: model ?? '', created: Date.now(), lastActivity: Date.now(), ...placeOf(workspace) });
    upsert(s);
    later(6000, () => upsert({ ...s, status: 'landed', now: 'Done', result: 'Done.', updated: Date.now() }));
    return s;
  },
  async tell(id: string, text: string) {
    const s = state.stars.find((x) => x.id === id);
    if (!s) throw new Error(`there is no star ${id}`);
    upsert({ ...s, status: 'working', question: null, now: 'Picking it back up', log: [...s.log, log('you', text, 0)] });
    return `Sent to ${id}`;
  },
  async pickWorkspace(): Promise<Workspace | null> {
    const names = ['docs', 'mobile', 'api', 'data'];
    const name = names.find((n) => !state.workspaces.some((w) => w.name === n)) ?? `repo-${seq}`;
    return openFolder(`~/code/${name}`);
  },
  async openWorkspace(path: string) {
    return openFolder(path);
  },
  async closeWorkspace(id: string) {
    state.workspaces = state.workspaces.filter((w) => w.id !== id);
    if (state.current === id) state.current = [...state.workspaces].sort((a, b) => b.lastUsed - a.lastUsed)[0]?.id ?? null;
    emitWorkspaces();
  },
  async frontWorkspace(id: string | null) {
    const w = state.workspaces.find((x) => x.id === id);
    if (id && !w) throw new Error(`there is no workspace ${id}`);
    if (w) w.lastUsed = Date.now();
    state.current = id;
    emitWorkspaces();
  },
  async terminalOpen(_cols: number, _rows: number, workspace?: string) {
    const id = workspace === 'none' ? null : workspace ?? state.current;
    const w = state.workspaces.find((x) => x.id === id);
    return shells.open(w?.path ?? '~', w?.id ?? null, w?.branch ?? 'main');
  },
  async terminalWrite(id: string, data: string) {
    shells.write(id, data);
  },
  async terminalClose(id: string) {
    shells.close(id);
  },
  terminalReplay(id: string) {
    return shells.replay(id);
  },
  onTerminalData(cb: (id: string, at: number, data: Uint8Array) => void) {
    return shells.on(cb);
  },
  async stop(id: string) {
    const s = state.stars.find((x) => x.id === id);
    if (s) upsert({ ...s, status: 'stopped', now: 'Stopped' });
    return `Stopping ${id}`;
  },
};
