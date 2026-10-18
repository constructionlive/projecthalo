// WebKit (the engine Halo's windows use) against the running test instance:
// the thread, the galaxy, a star's birth, and the crawl while Halo streams.
import { webkit } from 'playwright';

const B = 'http://127.0.0.1:47615';
const UI = 'http://localhost:4173';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
const post = async (p, body = {}) => (await (await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()).ok;
const state = async () => (await (await fetch(B + '/state')).json()).ok;
const results = [];
const TITLE = `Birth ${Date.now() % 10000}`;
const check = (name, ok, detail = '') => (results.push({ name, ok }), console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`));

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1320, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${UI}/index.html?bridge=${B}`);
await page.waitForTimeout(1500);

// 1. Thread: every line visible or reachable by scrolling.
await page.getByRole('button', { name: 'Open the whole thread' }).click();
await page.waitForTimeout(1000);
const t = await page.evaluate(() => {
  const d = document.querySelector('.threadview');
  const rows = [...d.querySelectorAll('.tv-you, .tv-halo, .tv-wake')];
  return { rows: rows.length, tallEnough: d.clientHeight > 500, scrollable: d.scrollHeight >= d.clientHeight, firstVisible: rows[0]?.getBoundingClientRect().top < innerHeight };
});
const lines = (await state()).lines.length;
check('thread shows every line', t.rows === lines && t.tallEnough && (lines === 0 || t.firstVisible), JSON.stringify({ ...t, lines }));
await page.screenshot({ path: SHOTS + 'wk-thread.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// 2. Light a star yourself: the composer, then its birth.
await page.getByRole('button', { name: '+ Light a star' }).click();
await page.waitForTimeout(300);
await page.fill('#ls-goal', 'Write a file named birth.txt containing the word born, then reply done.');
await page.fill('#ls-title', TITLE);
await page.screenshot({ path: SHOTS + 'wk-compose.png' });
await page.getByRole('button', { name: /Light it/ }).click();
for (const [ms, name] of [[250, 'a'], [700, 'b'], [1600, 'c'], [3200, 'd']]) {
  await page.waitForTimeout(ms === 250 ? 250 : ms - [250, 700, 1600, 3200][[250, 700, 1600, 3200].indexOf(ms) - 1]);
  await page.screenshot({ path: SHOTS + `wk-birth-${name}.png` });
}
const born = (await state()).stars.find((s) => s.title === TITLE);
check('lighting a star yourself works', !!born, born ? born.status : 'no star');
const onScreen = await page.evaluate((title) => [...document.querySelectorAll('.star.orbiting')].some((b) => b.getAttribute('aria-label')?.startsWith(title)), TITLE);
check('the new star is in the galaxy', onScreen);

// 2b. Dive into the star and back out.
const view = () => page.evaluate(() => document.querySelector('[data-view]').dataset.view);
await page.hover('.galaxy');
await page.waitForTimeout(900); // the orbit slows to a stop under the pointer
await page.locator('.star.orbiting', { hasText: TITLE }).click();
await page.waitForTimeout(350);
await page.screenshot({ path: SHOTS + 'wk-dive-mid.png' });
await page.waitForTimeout(700);
await page.screenshot({ path: SHOTS + 'wk-star-view.png' });
check('clicking a star dives into it', (await view()) === 'star' && (await page.locator('.starview h1').innerText()).toUpperCase().includes(TITLE.toUpperCase()));
await page.fill('#ask', 'thanks');
check('the ask line talks to the star', (await page.getAttribute('#ask', 'placeholder'))?.startsWith('Tell '));
await page.fill('#ask', '');
await page.keyboard.press('Escape');
await page.waitForTimeout(900);
check('esc zooms back out to the galaxy', (await view()) === 'galaxy');

// 3. The crawl while Halo streams.
await page.fill('#ask', 'In three short sentences, describe a concrete pour at dawn. Answer directly, no star.');
await page.press('#ask', 'Enter');
let shots = 0;
for (let i = 0; i < 40 && shots < 3; i++) {
  await page.waitForTimeout(500);
  const live = await page.evaluate(() => document.querySelectorAll('.crawl .chunk').length);
  if (live > 8) {
    await page.screenshot({ path: SHOTS + `wk-crawl-${++shots}.png` });
    await page.waitForTimeout(700);
  }
}
check('the reply streams into the crawl', shots > 0);
for (let i = 0; i < 60 && (await state()).busy; i++) await page.waitForTimeout(500);
await page.waitForTimeout(800);
await page.screenshot({ path: SHOTS + 'wk-crawl-done.png' });
const jump = await page.evaluate(() => document.querySelector('.crawl-mover').getBoundingClientRect().height);
check('crawl settles after the reply', jump > 0);

// 4. Summon panel in WebKit.
const s = await browser.newPage({ viewport: { width: 860, height: 600 } });
s.on('pageerror', (e) => errors.push(e.message));
await s.goto(`${UI}/summon.html?bridge=${B}`);
await s.waitForTimeout(1200);
await s.screenshot({ path: SHOTS + 'wk-summon.png' });
check('summon has the mic', (await s.locator('.mic').count()) === 1);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
