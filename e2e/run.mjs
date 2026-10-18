// End-to-end tests: Halo's real UI (served by vite preview) driving the real
// engine in the running debug app (dev bridge), on real Claude Code.
//   node run.mjs [scenario-number ...]

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launch, sleep, waitFor } from './cdp.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const HOME = join(HERE, 'home');
const SHOTS = join(HERE, 'shots');
const B = 'http://127.0.0.1:47615';
const SCENARIO_LIMIT = 6 * 60_000;
/** What the running scenario last waited for, for the hang report. */
let lastStep = 'start';
const UI = 'http://localhost:4173';

// Every request to the app has a limit: a reply that never comes is an error, not a hang.
const get = async (p) => (await (await fetch(B + p, { signal: AbortSignal.timeout(60_000) })).json()).ok;
const post = async (p, body = {}) => {
  globalThis.haloLastStep = `POST ${p}`;
  const j = await (await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) })).json();
  if (j.error !== undefined) throw new Error(j.error);
  return j.ok;
};
const state = () => get('/state');
const star = async (title) => (await state()).stars.find((s) => s.title.toLowerCase().includes(title.toLowerCase()));
const haloLines = async () => (await state()).lines.filter((l) => l.role === 'halo');
const file = (id, name) => {
  const p = join(HOME, 'stars', id, 'work', name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const idle = () => waitFor('Halo idle', async () => !(await state()).busy, 180_000);

let browser, sky, summon;
const notes = [];
const note = (s) => (notes.push(s), console.log(`      · ${s}`));

/** Back to the galaxy first: while a star is open, the ask line talks to that star. */
async function askInSky(text) {
  if ((await sky.run(() => document.querySelector('[data-view]').dataset.view)) !== 'galaxy') {
    await sky.key('Escape');
    await waitFor('the galaxy', async () => (await sky.run(() => document.querySelector('[data-view]').dataset.view)) === 'galaxy', 5_000);
    await sleep(800);
  }
  const before = (await state()).lines.length;
  await sky.type('#ask', text);
  await sky.submit('#ask');
  await waitFor('the question in the thread', async () => (await state()).lines.length > before, 10_000);
}

const scenarios = [
  ['Sky loads against the live engine', async () => {
    const t = await sky.text();
    assert(t.includes('HALO'), 'no wordmark');
    assert(t.includes('Halo. Tell me what'), 'no greeting on an empty thread');
    assert(t.includes('0 WORKING'), 'status line missing');
    await sky.shot(join(SHOTS, '01-sky-empty.png'));
  }],

  ['A quick question is answered directly, no star', async () => {
    await askInSky('What is 17 times 23? Answer directly in one short sentence. Do not light a star.');
    await waitFor('the answer', async () => (await haloLines()).some((l) => l.text.includes('391')));
    assert((await state()).stars.length === 0, 'lit a star for a quick question');
    await waitFor('the answer on screen', async () => (await sky.text()).includes('391'), 10_000);
    await sky.shot(join(SHOTS, '02-direct-answer.png'));
  }],

  ['Long work goes to a star; Halo answers first, wakes when it lands', async () => {
    const n = (await haloLines()).length;
    await askInSky('Light a star titled "Haiku" whose goal is: write a three-line haiku about pouring concrete into haiku.txt in your folder, then reply with the haiku. Do not write it yourself.');
    const s = await waitFor('the star', () => star('Haiku'), 90_000);
    await waitFor('Halo’s first reply', async () => (await haloLines()).length > n, 90_000);
    const atReply = (await star('Haiku')).status;
    note(`star was "${atReply}" when Halo replied`);
    await sky.shot(join(SHOTS, '03a-star-working.png'));
    await waitFor('the star to land', async () => (await star('Haiku')).status === 'landed', 180_000);
    await waitFor('the wake turn', async () => {
      const st = await state();
      const wake = st.lines.findIndex((l) => l.role === 'wake' && l.text.includes('Haiku'));
      return wake >= 0 && st.lines.slice(wake + 1).some((l) => l.role === 'halo');
    }, 120_000);
    const haiku = file(s.id, 'haiku.txt');
    assert(haiku && haiku.trim().split('\n').length >= 3, `haiku.txt: ${JSON.stringify(haiku)}`);
    note(`haiku.txt: ${haiku.trim().replace(/\n/g, ' / ')}`);
    await idle();
    const files = await post('/star-files', { id: s.id });
    assert(files.some((f) => f.name === 'haiku.txt'), `star files: ${JSON.stringify(files)}`);
    await sky.click('Haiku, Landed');
    await waitFor('the star view', async () => (await sky.run(() => document.querySelector('[data-view]').dataset.view)) === 'star', 5_000);
    await waitFor('its files in the star view', async () => (await sky.text()).includes('haiku.txt') && (await sky.text()).includes('MADE'), 5_000);
    await sleep(700); // let the panel finish fading in
    await sky.shot(join(SHOTS, '03b-star-landed-readout.png'));
  }],

  ['A star that needs the person: question, inline answer, resume', async () => {
    await askInSky('Light a star titled "Paint" whose goal is: ask the person which colour to paint the site office (end with a NEEDS YOU line), then write their answer into colour.txt and reply done.');
    await waitFor('the question', async () => (await star('Paint'))?.status === 'needsYou', 180_000);
    const s = await star('Paint');
    note(`question: ${s.question}`);
    await waitFor('"Waiting on you" on screen', async () => (await sky.text()).includes('WAITING ON YOU'), 10_000);
    await waitFor('Halo relaying it', async () => {
      const st = await state();
      const w = st.lines.findIndex((l) => l.role === 'wake' && l.text.includes('NEEDS YOU'));
      return w >= 0 && st.lines.slice(w + 1).some((l) => l.role === 'halo');
    }, 120_000);
    await sky.shot(join(SHOTS, '04a-needs-you.png'));
    await sky.type(`#ans-${s.id}`, 'Safety orange, please');
    await sky.submit(`#ans-${s.id}`);
    await waitFor('the star to land', async () => (await star('Paint')).status === 'landed', 180_000);
    const c = file(s.id, 'colour.txt') ?? file(s.id, 'color.txt');
    assert(c && /orange/i.test(c), `colour.txt: ${JSON.stringify(c)}`);
    assert((await star('Paint')).turns === 2, 'expected the answer to resume the same star');
    await idle();
    await sky.shot(join(SHOTS, '04b-answered-landed.png'));
  }],

  ['Stopping a working star from its readout', async () => {
    await askInSky('Light a star titled "Slow count" whose goal is: run the shell command `sleep 120`, then reply finished.');
    await waitFor('it to work', async () => (await star('Slow count'))?.status === 'working', 90_000);
    await sleep(6000);
    await sky.key('Escape');
    await sleep(900);
    await sky.click('Slow count, ');
    await waitFor('the star view', async () => (await sky.text()).includes('SLOW COUNT'), 5_000);
    await sky.shot(join(SHOTS, '05a-working-readout.png'));
    await sky.click('Stop this star', '.starview-side button');
    await waitFor('it to stop', async () => (await star('Slow count')).status === 'stopped', 30_000);
    await sleep(3000);
    const woke = (await state()).lines.some((l) => l.role === 'wake' && l.text.includes('Slow count'));
    assert(!woke, 'a stopped star woke Halo');
    await sky.shot(join(SHOTS, '05b-stopped.png'));
  }],

  ['A quiet star is reported as stalled, then lands', async () => {
    await idle();
    await askInSky('Light a star titled "Quiet" whose goal is: run python3 -c "import time; time.sleep(45)" as one shell command (nothing else), then reply ok.');
    await waitFor('the stall report', async () => (await state()).lines.some((l) => l.role === 'wake' && l.text.includes('STALLED') && l.text.includes('Quiet')), 150_000);
    note(`stalled flag on screen: ${(await sky.text()).includes('QUIET A WHILE')}`);
    await sky.shot(join(SHOTS, '06-stalled.png'));
    await waitFor('it to land anyway', async () => (await star('Quiet')).status === 'landed', 150_000);
  }],

  ['Three stars at once, in parallel', async () => {
    await idle();
    await askInSky('Light three stars at once: "Alpha" writes a.txt containing A, "Beta" writes b.txt containing B, "Gamma" writes c.txt containing C. Each replies with its file name.');
    let maxParallel = 0;
    await waitFor('all three to land', async () => {
      const ss = (await state()).stars.filter((s) => ['Alpha', 'Beta', 'Gamma'].includes(s.title));
      maxParallel = Math.max(maxParallel, ss.filter((s) => s.status === 'working').length);
      return ss.length === 3 && ss.every((s) => s.status === 'landed');
    }, 240_000, 400);
    note(`most running at the same moment: ${maxParallel}`);
    assert(maxParallel >= 2, 'stars did not run in parallel');
    for (const [t, f, c] of [['Alpha', 'a.txt', 'A'], ['Beta', 'b.txt', 'B'], ['Gamma', 'c.txt', 'C']]) {
      const s = await star(t);
      assert(file(s.id, f)?.includes(c), `${f} missing or wrong`);
    }
    await idle();
    await sky.shot(join(SHOTS, '07-three-landed.png'));
  }],

  ['Halo passes a follow-up to an existing agent (tell_agent)', async () => {
    const s = await star('Haiku');
    await askInSky('Tell the Haiku star to put a title line "Pour" at the very top of haiku.txt.');
    await waitFor('the star to take a second turn and land', async () => {
      const x = await star('Haiku');
      return x.turns >= 2 && x.status === 'landed';
    }, 240_000);
    const h = file(s.id, 'haiku.txt');
    assert(/^\s*pour/i.test(h ?? ''), `haiku.txt: ${JSON.stringify(h)}`);
    await idle();
  }],

  ['Summon panel: chips, ask, "thinking" until the new reply', async () => {
    summon = await browser.open(`${UI}/summon.html?bridge=${B}`, 860, 600);
    const t = await summon.text();
    assert(t.includes('Haiku') || t.includes('Paint'), 'no star chips');
    await summon.shot(join(SHOTS, '09a-summon.png'));
    await summon.type('#summon-ask', 'In one short sentence: how many stars have landed so far?');
    await summon.submit('#summon-ask');
    await sleep(400);
    const early = await summon.text();
    assert(early.toLowerCase().includes('thinking') || early.toLowerCase().includes('using'), 'showed an old reply as if it were the answer');
    await waitFor('the fresh reply', async () => !(await state()).busy && !(await summon.text()).toLowerCase().includes('thinking'), 120_000);
    await summon.shot(join(SHOTS, '09b-summon-answered.png'));
  }],

  ['Thread overlay opens and closes with Esc', async () => {
    await sky.key('Escape');
    await sleep(900);
    await sky.click('Open the whole thread', '[role=button]');
    const view = () => sky.run(() => document.querySelector('[data-view]').dataset.view);
    await waitFor('the thread', async () => (await view()) === 'thread', 5_000);
    await sleep(900);
    await sky.shot(join(SHOTS, '10-thread.png'));
    await sky.key('Escape');
    await waitFor('back to the galaxy', async () => (await view()) === 'galaxy', 5_000);
  }],

  ['Windows: summon shows centred near the top, toggles, hides; Sky reopens', async () => {
    await post('/toggle-summon');
    await sleep(800);
    let w = await get('/windows');
    assert(w.summon.visible, 'summon did not show');
    const m = w.summon.monitor;
    const dx = Math.abs(w.summon.x + w.summon.width / 2 - (m.x + m.width / 2));
    const dy = Math.abs(w.summon.y - (m.y + m.height * 0.12));
    note(`summon at ${w.summon.x},${w.summon.y} size ${w.summon.width}x${w.summon.height}, focused=${w.summon.focused}; off-centre by ${dx}px, ${dy}px`);
    assert(dx <= 4 && dy <= 4, 'summon not where it should be');
    assert(w.summon.height < 1200, 'summon window not fitted to its panel');
    await post('/toggle-summon');
    await sleep(800);
    w = await get('/windows');
    note(`after second toggle: visible=${w.summon.visible}`);
    if (w.summon.visible) {
      await post('/hide-summon');
      await sleep(500);
      w = await get('/windows');
    }
    assert(!w.summon.visible, 'summon would not hide');
    await post('/open-sky');
    await sleep(500);
    assert((await get('/windows')).sky.visible, 'sky not visible');
  }],

  ['A star on a missing engine fails clearly and Halo says so', async () => {
    await idle();
    await askInSky('Light a star titled "Opencode check" with engine opencode, whose goal is: reply hello.');
    await waitFor('it to fail', async () => (await star('Opencode check'))?.status === 'failed', 120_000);
    note(`error: ${(await star('Opencode check')).error}`);
    await waitFor('Halo to explain', async () => {
      const st = await state();
      const w = st.lines.findIndex((l) => l.role === 'wake' && l.text.includes('FAILED'));
      return w >= 0 && st.lines.slice(w + 1).some((l) => l.role === 'halo');
    }, 120_000);
    await idle();
    await sky.shot(join(SHOTS, '12-failed.png'));
  }],

  ['Odd input: empty, Hindi, very long', async () => {
    const n = (await state()).lines.length;
    await post('/ask', { text: '   ' });
    await sleep(800);
    assert((await state()).lines.length === n, 'an empty message was sent');
    await post('/ask', { text: 'नमस्ते! Reply with just the word ok.' });
    await waitFor('a reply', async () => !(await state()).busy && (await state()).lines.length >= n + 2, 120_000);
    await post('/ask', { text: `Reply with just the word received. ${'filler '.repeat(900)}` });
    await waitFor('a reply to the long one', async () => !(await state()).busy && (await state()).lines.length >= n + 4, 120_000);
    await sky.click('Open the whole thread', '[role=button]');
    await waitFor('Hindi in the thread', async () => (await sky.text()).includes('नमस्ते'), 5_000);
    await sky.shot(join(SHOTS, '13-hindi-thread.png'));
    await sky.key('Escape');
  }],

  ['Quit mid-work and relaunch: thread, stars and memory survive', async () => {
    await idle();
    await post('/ask', { text: 'Light a star titled "Long haul" whose goal is: run python3 -c "import time; time.sleep(90)" as one shell command, then write haul.txt containing done and reply finished.' });
    await waitFor('it to work', async () => (await star('Long haul'))?.status === 'working', 120_000);
    await sleep(5000);
    const before = await state();
    execSync(join(HERE, 'restart.sh'));
    await sleep(1500);
    const after = await state();
    note(`lines ${before.lines.length} → ${after.lines.length}, stars ${before.stars.length} → ${after.stars.length}`);
    assert(after.lines.length >= before.lines.length - 1, 'the thread was lost');
    assert(after.stars.length === before.stars.length, 'a star was lost');
    const s = await star('Long haul');
    assert(s.status === 'stopped' && /interrupted/i.test(s.now), `expected an interrupted star, got ${s.status}: ${s.now}`);
    await sky.send('Page.reload');
    await sleep(2000);
    await sky.shot(join(SHOTS, '15a-after-restart.png'));
    await post('/tell', { id: s.id, text: 'Carry on, but skip the wait: just write haul.txt containing done and reply finished.' });
    await waitFor('it to resume and land', async () => (await star('Long haul')).status === 'landed', 180_000);
    assert(file(s.id, 'haul.txt')?.includes('done'), 'haul.txt missing');
    await idle();
    const n = (await haloLines()).length;
    await post('/ask', { text: 'What was the title of the very first star we lit? Reply with just the title.' });
    await waitFor('Halo to remember', async () => (await haloLines()).length > n, 120_000);
    const reply = (await haloLines()).at(-1).text;
    note(`Halo remembers: ${reply}`);
    assert(/haiku/i.test(reply), 'Halo lost its memory across the restart');
  }],

  ['Summon key: right ⌘ by default, switchable, and an Allow button until macOS permits it', async () => {
    let hk = await get('/hotkey');
    assert(hk.key === 'rightCommand' && hk.label === 'right ⌘', `default key: ${JSON.stringify(hk)}`);
    note(`input monitoring allowed: ${hk.allowed}, listening: ${hk.listening}`);
    const t = await sky.text();
    if (!hk.listening) assert(t.includes('ALLOW RIGHT ⌘'), 'no Allow button while the shortcut cannot work');
    else assert(t.includes('TAP RIGHT ⌘'), 'no key hint');
    await sky.shot(join(SHOTS, '15-hotkey-chip.png'));
    await post('/summon-key', { key: 'leftCommand' });
    await sleep(500);
    hk = await get('/hotkey');
    assert(hk.key === 'leftCommand', 'could not switch to left ⌘');
    await post('/summon-key', { key: 'rightCommand' });
    await sleep(500);
    assert((await get('/hotkey')).key === 'rightCommand', 'could not switch back');
  }],

  ['Cancelling Halo mid-turn', async () => {
    await idle();
    await post('/ask', { text: 'Write a 400-word essay about rebar, directly, no star.' });
    await waitFor('the turn to start', async () => (await state()).busy, 30_000);
    await sleep(2500);
    await post('/cancel');
    await waitFor('the turn to end', async () => !(await state()).busy, 30_000);
  }],
  ['Workspaces: a star lit in one works in that repository; Halo routes by name', async () => {
    await idle();
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'halo-ws-')));
    const name = repo.split('/').pop();
    execSync('git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: repo });
    const w = await post('/workspace-open', { path: repo });
    assert(w.path === repo && w.branch === 'main' && w.dirty === 0, `opened: ${JSON.stringify(w)}`);
    assert((await state()).current === w.id, 'the opened workspace is in front');

    const models = await post('/models', { engine: 'claude' });
    assert(models.some((m) => m.id === 'haiku') && models[0].id === '', `Claude Code's models: ${models.map((m) => m.label)}`);
    const lit = await post('/spawn', { engine: 'claude', model: 'haiku', title: 'Hello file', goal: 'Create a file named HELLO.txt in the current directory containing exactly: hi from halo. Touch nothing else. Reply with one line.', workspace: w.id });
    assert(lit.cwd === repo && lit.workspace === w.id, `star placed: ${lit.cwd}`);
    assert(lit.engine === 'claude' && lit.model === 'haiku', `engine and model kept: ${lit.engine} ${lit.model}`);
    await waitFor('the star to land', async () => ['landed', 'failed'].includes((await star('Hello file'))?.status), 180_000);
    const s = await star('Hello file');
    assert(s.status === 'landed', `star ${s.status}: ${s.error}`);
    assert(existsSync(join(repo, 'HELLO.txt')) && readFileSync(join(repo, 'HELLO.txt'), 'utf8').includes('hi from halo'), 'HELLO.txt is in the repository');
    assert(!file(s.id, 'HELLO.txt'), 'and not in the star\'s own folder');
    assert(execSync('git rev-parse --abbrev-ref HEAD', { cwd: repo }).toString().trim() === 'main', 'the branch was left alone');
    await waitFor('the change count to reach the UI', async () => (await state()).workspaces.find((x) => x.id === w.id)?.dirty === 1, 15_000);
    note(`star ${s.id} ran in ${repo}; dirty count updated live`);

    await post('/workspace-front', { id: null });
    await post('/ask', { text: `Light a star in the ${name} workspace: create a file named ROUTED.txt there containing exactly: ok. Nothing else.` });
    await waitFor('ROUTED.txt in the repository', async () => existsSync(join(repo, 'ROUTED.txt')), 240_000);
    const routed = (await state()).stars.find((x) => x.cwd === repo && x.id !== s.id);
    assert(routed, 'Halo lit the star in the named workspace');
    note(`Halo routed "${routed.title}" to ${name}`);
    await idle();
    await post('/workspace-close', { id: w.id });
    assert(!(await state()).workspaces.some((x) => x.id === w.id), 'closed');
    assert(existsSync(join(repo, 'HELLO.txt')), 'closing leaves the folder as it is');
  }],
  ['Terminals: a real shell in a workspace, drawn live, ports, flood, Halo reads it', async () => {
    await idle();
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'halo-term-')));
    execSync('git init -q -b main', { cwd: repo });
    const w = await post('/workspace-open', { path: repo });
    const t = await post('/term-open', { workspace: w.id });
    assert(t.cwd === repo && t.integrated && t.workspace === w.id, `opened in ${t.cwd}`);
    // In front: a tab left in the background (the summon scenarios open another) doesn't draw.
    await sky.send('Page.bringToFront');
    // The Roadster theme, with the scene exposed, onboard this terminal.
    await sky.run(() => localStorage.setItem('halo-theme', 'roadster'));
    await sky.send('Page.navigate', { url: `${UI}/index.html?test&bridge=${B}` });
    await sleep(2500);
    await sky.click(`Terminal T`, '.tower-row.term');
    await waitFor('the cockpit', () => sky.run(() => !!window.xterm), 5_000);
    const screen = () => sky.run(() => { const b = window.xterm.buffer.active; const out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? ''); return out.join('\n'); });
    await post('/term-write', { id: t.id, data: 'echo e2e-$((6*7))\r' });
    await waitFor('the answer on screen', async () => (await screen()).includes('e2e-42'), 10_000);
    await waitFor('the run in the state', async () => (await state()).terminals.find((x) => x.id === t.id)?.last?.exit === 0, 10_000);
    assert(/Chequered/.test(await sky.run(() => document.querySelector('.cockpit-flag').textContent)), 'the cockpit shows a clean finish');

    // A flood: 200,000 lines while the window keeps drawing.
    const frames = sky.run(() => new Promise((res, no) => { setTimeout(() => no(new Error('no frames drawn: is the page in the background?')), 15000); const t = []; let last = performance.now(); const end = last + 4000; const f = (n) => { t.push(n - last); last = n; if (n < end) requestAnimationFrame(f); else { t.sort((a, b) => a - b); res({ n: t.length, median: t[t.length >> 1], p95: t[Math.floor(t.length * 0.95)], worst: t[t.length - 1] }); } }; requestAnimationFrame(f); }));
    const t0 = Date.now();
    await post('/term-write', { id: t.id, data: 'seq 1 200000\r' });
    await waitFor('the last line drawn', async () => (await screen()).includes('200000'), 60_000);
    const drawn = Date.now() - t0;
    const f = await frames;
    note(`200,000 lines drawn in ${drawn} ms; frames during the flood: median ${f.median.toFixed(1)} ms, p95 ${f.p95.toFixed(1)} ms, worst ${f.worst.toFixed(1)} ms`);
    assert(drawn < 15_000, `flood took ${drawn} ms`);
    assert(f.p95 < 50, `the window stuttered: p95 frame ${f.p95.toFixed(1)} ms`);

    // A real server: its port shows up, and closing the terminal ends it.
    const port = 47800 + (process.pid % 150);
    await post('/term-write', { id: t.id, data: `python3 -m http.server ${port} --bind 127.0.0.1\r` });
    await waitFor('the port on the car', async () => (await state()).terminals.find((x) => x.id === t.id)?.ports.includes(port), 15_000);
    await waitFor('the cockpit to show it', () => sky.run((p) => document.querySelector('.cockpit-flag').textContent.includes(`:${p}`), port), 5_000);
    note(`port :${port} on the car`);
    await post('/term-write', { id: t.id, data: '\x03' });
    await waitFor('Ctrl-C to stop it', async () => (await state()).terminals.find((x) => x.id === t.id)?.status === 'idle', 10_000);

    // Halo reads it.
    await post('/term-write', { id: t.id, data: 'cat no-such-file.txt\r' });
    await waitFor('the failure', async () => (await state()).terminals.find((x) => x.id === t.id)?.last?.exit === 1, 10_000);
    const before = (await haloLines()).length;
    await post('/ask', { text: `Why did the last command in my terminal ${t.id} fail? One sentence.` });
    await waitFor('Halo\'s answer', async () => (await haloLines()).length > before && !(await state()).busy, 120_000);
    const answer = (await haloLines()).at(-1).text;
    note(`Halo: ${answer.slice(0, 160)}`);
    assert(/no-such-file|no such file|doesn.t exist|does not exist|not found/i.test(answer), 'Halo read the terminal');

    await post('/term-write', { id: t.id, data: `python3 -m http.server ${port + 1} --bind 127.0.0.1\r` });
    await waitFor('the second server', async () => (await state()).terminals.find((x) => x.id === t.id)?.ports.includes(port + 1), 15_000);
    await post('/term-close', { id: t.id });
    await waitFor('the server to end with it', async () => { try { await fetch(`http://127.0.0.1:${port + 1}/`); return false; } catch { return true; } }, 10_000);
    assert(!(await state()).terminals.some((x) => x.id === t.id), 'closed');
    await post('/workspace-close', { id: w.id });
    await sky.run(() => localStorage.setItem('halo-theme', 'galaxy'));
  }],
  ['Customize: a real agent changes a theme live; undo; the sandbox keeps a theme in', async () => {
    await idle();
    // A new theme from the blank start: built, served, shown in the window.
    const th = await post('/theme-create', { name: 'E2E Studio', from: 'blank' });
    assert(th.version === 1 && !th.error, `made: v${th.version} ${th.error ?? ''}`);
    const js = async () => (await fetch(`${B}/theme/${th.id}/theme.js`, { signal: AbortSignal.timeout(10_000) })).text();
    assert((await js()).length > 1000, 'its build is served');
    await sky.send('Page.bringToFront');
    await sky.run((id) => localStorage.setItem('halo-theme', `custom:${id}`), th.id);
    await sky.send('Page.navigate', { url: `${UI}/index.html?test&bridge=${B}` });
    await waitFor('the theme to start in its frame', () => sky.run(() => !!document.querySelector('.theme-frame[data-ready]')), 20_000);
    note(`theme ${th.id} started in its sandboxed frame`);

    // A real agent changes it; Halo rebuilds as it saves.
    const agent = await post('/theme-customize', { id: th.id, request: 'Change the big title text at the top from "Halo" to "E2E STUDIO". Nothing else.', engine: 'claude', model: 'haiku' });
    assert(agent.workspace === `theme:${th.id}` && agent.cwd === th.dir, `the agent works in the theme folder: ${agent.cwd}`);
    await waitFor('the change to build', async () => (await js()).includes('E2E STUDIO'), 240_000);
    await waitFor('the new version', async () => ((await state()).themes.find((t) => t.id === th.id)?.version ?? 0) >= 2, 10_000);
    const changed = (await state()).themes.find((t) => t.id === th.id);
    assert(changed.version >= 2 && !changed.error, `v${changed.version} ${changed.error ?? ''}`);
    await waitFor('the window to reload the new version', () => sky.run((v) => document.querySelector('.theme-frame')?.dataset.version === String(v) && !!document.querySelector('.theme-frame[data-ready]'), changed.version), 15_000);
    await waitFor('its agent to finish', async () => ['landed', 'failed'].includes((await state()).stars.find((s) => s.id === agent.id)?.status), 120_000);
    note(`agent changed it: v${changed.version}`);

    // Undo goes back to the version before.
    const undone = await post('/theme-undo', { id: th.id });
    assert(!undone.error && !(await js()).includes('E2E STUDIO'), 'undo restored the title');

    // A probe theme tries every way out of the sandbox.
    const probe = await post('/theme-create', { name: 'Probe', from: 'blank' });
    writeFileSync(join(probe.dir, 'src/index.tsx'), readFileSync(join(HERE, 'fixtures/probe-theme.tsx'), 'utf8'));
    await waitFor('the probe to build', async () => ((await state()).themes.find((t) => t.id === probe.id)?.version ?? 0) >= 2, 20_000);
    await sky.run((id) => localStorage.setItem('halo-theme', `custom:${id}`), probe.id);
    await sky.send('Page.navigate', { url: `${UI}/index.html?test&bridge=${B}` });
    await sleep(1500);
    await sky.run(() => window.addEventListener('message', (e) => e.data?.t === 'probe' && (window.__probe = e.data.r)));
    const r = await waitFor('the probe report', () => sky.run(() => window.__probe ?? null), 20_000);
    note(`sandbox: ${Object.entries(r).map(([k, v]) => `${k}=${v.split(':')[0]}`).join(', ')}`);
    for (const k of ['parentDocument', 'localStorage', 'tauriInternals', 'tauriIpc', 'internet', 'otherRoute', 'openTerminal', 'notACall']) assert(r[k]?.startsWith('blocked'), `${k} got out: ${r[k]}`);
    for (const k of ['ownBuild', 'readState']) assert(r[k]?.startsWith('allowed'), `${k} should work: ${r[k]}`);
    assert(/terminals/.test(r.openTerminal), `the refusal says which permission: ${r.openTerminal}`);

    // A theme event that leaves the build as it is (here a failed build) must not cut the theme off
    // from Halo: it keeps hearing what happens, and nothing says it failed to start.
    await sky.run(() => { window.__ws = []; window.addEventListener('message', (e) => e.data?.t === 'probe-ws' && window.__ws.push(e.data.n)); });
    const src = join(probe.dir, 'src/index.tsx');
    const good = readFileSync(src, 'utf8');
    writeFileSync(src, `${good}\nthis is not typescript(`);
    await waitFor('the failed build to be reported', async () => !!(await state()).themes.find((t) => t.id === probe.id)?.error, 15_000);
    await sleep(800);
    const before = (await state()).workspaces.length;
    const scratch = mkdtempSync(join(tmpdir(), 'halo-probe-ws-'));
    const opened = await post('/workspace-open', { path: scratch });
    await waitFor('the theme to hear of the new workspace', () => sky.run((n) => (window.__ws ?? []).includes(n), before + 1), 5_000);
    await sleep(10_500);
    assert(!(await sky.run(() => document.querySelector('.theme-trouble')?.textContent ?? null)), 'a working theme was reported as not starting');
    await post('/workspace-close', { id: opened.id });
    writeFileSync(src, good);
    note('after a failed build the theme still hears every change, and no false alarm');

    await post('/theme-delete', { id: th.id });
    await post('/theme-delete', { id: probe.id });
    await sky.run(() => localStorage.setItem('halo-theme', 'galaxy'));
  }],
  ['The sandbox holds in the real window (WKWebView): no Tauri, no network, permissions enforced', async () => {
    const probe = await post('/theme-create', { name: 'Probe', from: 'blank' });
    writeFileSync(join(probe.dir, 'src/index.tsx'), readFileSync(join(HERE, 'fixtures/probe-theme.tsx'), 'utf8'));
    await waitFor('the probe to build', async () => ((await state()).themes.find((t) => t.id === probe.id)?.version ?? 0) >= 2, 20_000);
    await post('/sky-eval', { js: `localStorage.setItem('halo-theme','custom:${probe.id}'); location.reload();` });
    await sleep(3000);
    // The window (not the theme) relays the probe's report to a note the test can read.
    await post('/sky-eval', { js: `window.addEventListener('message', (e) => { if (e.data && e.data.t === 'probe') window.__TAURI_INTERNALS__.invoke('debug_note', { key: 'probe-${probe.id}', value: JSON.stringify(e.data.r) }); });` });
    const raw = await waitFor('the probe report', async () => (await get('/debug-notes'))?.[`probe-${probe.id}`], 20_000);
    const r = JSON.parse(raw);
    note(`real window: ${Object.entries(r).map(([k, v]) => `${k}=${v.split(':')[0]}`).join(', ')}`);
    for (const k of ['parentDocument', 'localStorage', 'tauriInternals', 'tauriIpc', 'internet', 'otherRoute', 'openTerminal', 'notACall']) assert(r[k]?.startsWith('blocked'), `${k} got out in the real window: ${r[k]}`);
    for (const k of ['ownBuild', 'readState']) assert(r[k]?.startsWith('allowed'), `${k} should work: ${r[k]}`);
    await post('/sky-eval', { js: `localStorage.setItem('halo-theme','galaxy'); location.reload();` });
    await post('/theme-delete', { id: probe.id });
  }],
];

async function main() {
  const only = process.argv.slice(2).map(Number);
  browser = await launch();
  sky = await browser.open(`${UI}/index.html?bridge=${B}`, 1320, 860);
  // These scenarios are about the galaxy: make sure that's the theme showing.
  await sky.run(() => localStorage.setItem('halo-theme', 'galaxy'));
  await sky.send('Page.reload');
  await sleep(1500);
  const results = [];
  for (const [i, [name, fn]] of scenarios.entries()) {
    const num = i + 1;
    if (only.length && !only.includes(num)) continue;
    const t0 = Date.now();
    process.stdout.write(`${String(num).padStart(2)} ${name} … `);
    try {
      // A hang is a failure, not a stuck run: every scenario gets a hard limit.
      let timer;
      await Promise.race([fn(), new Promise((_, no) => (timer = setTimeout(() => no(new Error(`hung for ${SCENARIO_LIMIT / 1000}s; last step: ${globalThis.haloLastStep ?? lastStep}`)), SCENARIO_LIMIT)))]).finally(() => clearTimeout(timer));
      results.push({ num, name, ok: true, secs: Math.round((Date.now() - t0) / 1000) });
      console.log(`ok (${Math.round((Date.now() - t0) / 1000)}s)`);
    } catch (e) {
      results.push({ num, name, ok: false, secs: Math.round((Date.now() - t0) / 1000), error: e.message });
      console.log(`FAILED: ${e.message}`);
      await sky.shot(join(SHOTS, `fail-${num}.png`)).catch(() => {});
    }
  }
  const pageErrors = [...sky.errors, ...(summon?.errors ?? [])];
  console.log(`\npage errors: ${pageErrors.length ? pageErrors.join('\n') : 'none'}`);
  writeFileSync(join(HERE, 'results.json'), JSON.stringify({ results, notes, pageErrors }, null, 2));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
  browser.close();
  // The browser's child process would keep node alive; the exit code is the verdict.
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  browser?.close();
  process.exit(1);
});
