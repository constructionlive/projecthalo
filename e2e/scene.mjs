// The Roadster world as it is now: arenas, agent cars and terminal GTs, in
// WebKit (Halo's engine) against the built UI in demo mode. Reads every car's
// pose from the scene (`?test` exposes it as window.pier).
//   cd ui && npx vite build && npx vite preview --port 4173 &
//   node e2e/scene.mjs            (SHOTS=1 to keep frames in e2e/shots;
//                                  WIN=1 as Windows: Ctrl chords, Ctrl+Shift in a terminal)

import { webkit } from './node_modules/playwright/index.mjs';

const UI = 'http://localhost:4173/index.html?test';
const SHOTS = process.env.SHOTS ? new URL('./shots/', import.meta.url).pathname : null;
const WIN = !!process.env.WIN;
/** A ⌘ chord as this run's platform presses it. */
const chord = (k, terminal = false) => (WIN ? k.replace('Meta+', terminal ? 'Control+Shift+' : 'Control+') : k);
const results = [];
let page;
const errors = [];

async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const wait = (ms) => page.waitForTimeout(ms);
const shot = (name) => SHOTS && page.screenshot({ path: `${SHOTS}scene-${name}.jpg`, type: 'jpeg', quality: 80 });
const inspect = () => page.evaluate(() => window.pier.inspect());
const dbg = (id) => page.evaluate((id) => window.pier.debug(id), id);
const ids = () => page.evaluate(() => window.pier.ids());
/** Every car's pose, every frame, for `ms`. */
const sample = (ms) =>
  page.evaluate(
    (ms) =>
      new Promise((res) => {
        const out = [];
        const end = performance.now() + ms;
        const f = (t) => {
          out.push({ t, cars: Object.fromEntries(window.pier.ids().map((id) => [id, window.pier.debug(id)])) });
          if (t < end) requestAnimationFrame(f);
          else res(out);
        };
        requestAnimationFrame(f);
      }),
    ms,
  );
const frames = (ms) =>
  page.evaluate(
    (ms) =>
      new Promise((res) => {
        const t = [];
        let last = performance.now();
        const end = last + ms;
        const f = (n) => {
          t.push(n - last);
          last = n;
          if (n < end) requestAnimationFrame(f);
          else {
            t.sort((a, b) => a - b);
            res({ median: t[t.length >> 1], p95: t[Math.floor(t.length * 0.95)], worst: t[t.length - 1] });
          }
        };
        requestAnimationFrame(f);
      }),
    ms,
  );
const header = () => page.textContent('.pier-top nav');
const flagOf = () => page.textContent('.cockpit-flag');
async function arena(key, name) {
  await page.keyboard.press(chord(key));
  await page.waitForFunction((n) => document.querySelector('.pier-top nav')?.textContent.includes(n), name, { timeout: 5000 });
  await wait(600);
}

const browser = await webkit.launch();
page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
if (WIN) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32' }));
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(UI);
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('halo-theme', 'roadster');
  localStorage.setItem('roadster-tod', 'night');
});
await page.reload();
await wait(3000);
console.log('Roadster scene');

await check('each workspace is drawn as its own arena, plates loaded', async () => {
  for (const [key, name, arenaKey] of [['Meta+1', 'Bay Night', 'bay'], ['Meta+2', 'Mesa Night', 'mesa'], ['Meta+3', 'Porto Quay', 'porto'], ['Meta+4', 'Col de Glace', 'glace']]) {
    await arena(key, name);
    await page.waitForFunction(() => window.pier.inspect().plateLoaded, null, { timeout: 5000 });
    const s = await inspect();
    assert(s.arena === arenaKey && s.plate.startsWith(`${arenaKey}/home/`), `${name}: scene shows ${s.plate}`);
    await shot(arenaKey);
  }
  await arena('Meta+2', 'Mesa Night');
});

await check('every car stands on the ground with a sane pose', async () => {
  const s = await sample(1500);
  for (const f of s)
    for (const [id, c] of Object.entries(f.cars)) {
      assert(c.pos.every(Number.isFinite) && c.up.every(Number.isFinite), `${id} has a NaN pose`);
      const ceiling = c.phase === 'launch' ? 60 : 8;
      assert(c.pos[1] > -0.1 && c.pos[1] < ceiling, `${id} at height ${c.pos[1].toFixed(2)} (${c.phase})`);
    }
});

await check('racing cars stay on the circuit and move smoothly', async () => {
  const s = await sample(3000);
  let racing = 0;
  for (let i = 1; i < s.length; i++)
    for (const [id, c] of Object.entries(s[i].cars)) {
      const p = s[i - 1].cars[id];
      if (!p || c.phase !== 'race' || p.phase !== 'race' || c.view !== p.view) continue;
      racing++;
      assert(c.offTrack < 3, `${id} ${c.offTrack.toFixed(1)} m off the circuit`);
      const step = Math.hypot(c.pos[0] - p.pos[0], c.pos[2] - p.pos[2]);
      // About 100 km/h at most: 28 m/s; a frame can be 100 ms on a slow machine.
      assert(step < 3, `${id} jumped ${step.toFixed(1)} m in one frame`);
    }
  assert(racing > 100, `too few racing samples (${racing})`);
});

await check('parked cars stay parked', async () => {
  const s = await sample(1200);
  const last = s[s.length - 1].cars;
  for (const [id, c] of Object.entries(last)) if (c.state === 'landed' && c.phase === 'drive' && !id.startsWith('t')) assert(c.speed < 3, `${id} parked but moving at ${c.speed.toFixed(1)} km/h`);
});

await check('terminals are red GTs: racing while they run, parked when they rest', async () => {
  const kinds = await page.evaluate(() => Object.fromEntries(['t1', 't2', 't3'].map((id) => [id, window.pier.debug(id)])));
  assert(Object.values(kinds).every((c) => c?.kind === 'rosso'), `kinds: ${JSON.stringify(Object.values(kinds).map((c) => c?.kind))}`);
  assert(kinds.t1.phase === 'race' && kinds.t2.phase === 'race', 'the running ones race');
  assert(kinds.t3.state === 'failed' && kinds.t3.phase === 'drive', `the failed one is retired: ${kinds.t3.state}/${kinds.t3.phase}`);
});

await check('a command started in a terminal sends its GT racing; Ctrl-C parks it', async () => {
  await page.click('.tower-row.term:has-text("T3")');
  await wait(500);
  await page.keyboard.type('npm run dev');
  await page.keyboard.press('Enter');
  await page.keyboard.press(chord('Meta+Enter', true));
  await page.waitForFunction(() => window.pier.debug('t3')?.phase === 'race', null, { timeout: 6000 });
  await wait(1200);
  assert((await dbg('t3')).speed > 20, 'racing at speed');
  await shot('gt-racing');
  await page.click('.tower-row.term:has-text("T3")');
  await wait(400);
  await page.keyboard.press('Control+c');
  await page.keyboard.press(chord('Meta+Enter', true));
  await page.waitForFunction(() => window.pier.debug('t3')?.state === 'landed', null, { timeout: 4000 });
  await page.waitForFunction(() => window.pier.debug('t3')?.speed < 2, null, { timeout: 12000 });
});

await check('a failing command spins its GT off, then it parks retired', async () => {
  await page.click('.tower-row.term:has-text("T3")');
  await wait(400);
  await page.keyboard.type('cargo test');
  await page.keyboard.press('Enter');
  await page.keyboard.press(chord('Meta+Enter', true));
  await page.waitForFunction(() => window.pier.debug('t3')?.phase === 'race', null, { timeout: 4000 });
  await page.waitForFunction(() => window.pier.debug('t3')?.state === 'failed', null, { timeout: 6000 });
  const s = await sample(900);
  const spun = Math.max(...s.map((f) => f.cars.t3?.spinOut ?? 0));
  assert(spun > 1, `it spun ${spun.toFixed(2)} rad`);
  await page.waitForFunction(() => window.pier.debug('t3')?.speed < 2, null, { timeout: 12000 });
});

await check('hovering a GT shows its card', async () => {
  for (let i = 0; i < 60; i++) {
    const at = await page.evaluate(() => window.pier.project('t3', 0.5));
    if (at) {
      await page.mouse.move(at.x, at.y + 8);
      await wait(250);
      if (await page.isVisible('.car-card.term')) break;
    }
    await wait(100);
  }
  assert(await page.isVisible('.car-card.term'), 'no card');
  assert(/T3/.test(await page.textContent('.car-card.term')), 'the card names T3');
  await page.mouse.move(5, 450);
});

await check('a new Claude Code agent launches (cutscene, ramp) and joins the race', async () => {
  const before = await ids();
  await page.click('button:has-text("+ Launch")');
  await page.fill('#ls-goal', 'Write the changelog');
  await page.click('.ls-engine:has-text("Claude Code")');
  await page.click('.ls-go');
  await page.waitForFunction((b) => window.pier.ids().length > b, before.length, { timeout: 5000 });
  const id = (await ids()).find((x) => !before.includes(x));
  assert((await dbg(id)).phase === 'launch', `starts in ${(await dbg(id)).phase}`);
  await page.waitForFunction((id) => window.pier.debug(id)?.phase === 'race', id, { timeout: 15000 });
});

await check('frame rate in every arena', async () => {
  for (const [key, name] of [['Meta+1', 'Bay Night'], ['Meta+2', 'Mesa Night'], ['Meta+3', 'Porto Quay'], ['Meta+4', 'Col de Glace']]) {
    await arena(key, name);
    await wait(800);
    const f = await frames(2000);
    console.log(`       ${name}: median ${f.median.toFixed(1)} ms, p95 ${f.p95.toFixed(1)}, worst ${f.worst.toFixed(1)}`);
    assert(f.median < 20 && f.p95 < 34, `${name} runs slow`);
  }
});

await check('switching arenas over and over holds no more graphics memory', async () => {
  const cycle = async () => {
    for (const [key, name] of [['Meta+1', 'Bay Night'], ['Meta+2', 'Mesa Night'], ['Meta+3', 'Porto Quay'], ['Meta+4', 'Col de Glace']]) await arena(key, name);
  };
  await cycle();
  await wait(1000);
  const a = await inspect();
  for (let i = 0; i < 3; i++) await cycle();
  await wait(1000);
  const b = await inspect();
  console.log(`       plates kept ${a.plates} → ${b.plates}; GPU textures ${a.gpuTextures} → ${b.gpuTextures}; geometries ${a.gpuGeometries} → ${b.gpuGeometries}`);
  assert(b.plates <= 8, `${b.plates} plates kept`);
  assert(b.gpuTextures <= a.gpuTextures + 2, 'textures leak across arenas');
  assert(b.gpuGeometries <= a.gpuGeometries + 40, 'geometries leak across arenas');
});

await check('header, tower, map and captions never overlap (1440, 1024, 700 wide)', async () => {
  for (const [w, h] of [[1440, 900], [1024, 700], [700, 820]]) {
    await page.setViewportSize({ width: w, height: h });
    await wait(700);
    const boxes = await page.evaluate(() =>
      ['.pier-top nav', '.pier-top > div', '.tower', '.track-map, .map', '.captions']
        .map((s) => [s, document.querySelector(s)?.getBoundingClientRect()])
        .filter(([, r]) => r && r.width > 0)
        .map(([s, r]) => [s, { l: r.left, t: r.top, r: r.right, b: r.bottom }]),
    );
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [sa, a] = boxes[i];
        const [sb, b] = boxes[j];
        const overlap = Math.min(a.r, b.r) - Math.max(a.l, b.l) > 2 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 2;
        assert(!overlap, `${w}×${h}: ${sa} overlaps ${sb}`);
      }
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert(!wide, `${w}: page scrolls sideways`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
});

await check('no page errors', async () => {
  assert(errors.length === 0, errors.join(' | '));
});

await browser.close();
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
