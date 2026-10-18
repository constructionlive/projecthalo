// A tiny Chrome DevTools Protocol driver: open pages, run code in them,
// type, click, wait, screenshot. Node 24 (global WebSocket, fetch).

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fresh port each run: a browser left over from a killed run must never be reused.
export async function launch(port = 9300 + Math.floor(Math.random() * 600)) {
  const dir = mkdtempSync(join(tmpdir(), 'halo-e2e-'));
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--hide-scrollbars', '--no-first-run', '--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      await sleep(200);
    }
  }
  return {
    async open(url, width, height) {
      const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT' })).json();
      const page = new Page(t.webSocketDebuggerUrl);
      await page.ready;
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await page.send('Runtime.enable');
      await page.send('Page.enable');
      await page.send('Page.reload');
      await sleep(1500);
      return page;
    },
    close: () => proc.kill(),
  };
}

class Page {
  constructor(ws) {
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.ws = new WebSocket(ws);
    this.ready = new Promise((r) => (this.ws.onopen = r));
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    };
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Runs `fn(arg)` in the page and returns its (JSON) result. */
  async run(fn, arg) {
    const r = await this.send('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  text() {
    return this.run(() => document.body.innerText);
  }

  /** Types into an input the way a person does (React sees it). */
  type(selector, value) {
    return this.run(({ selector, value }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`no ${selector}`);
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, { selector, value });
  }

  submit(selector) {
    return this.run((selector) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`no ${selector}`);
      el.closest('form').requestSubmit();
      return true;
    }, selector);
  }

  /** Clicks the first button/link whose text or aria-label contains `text`. */
  click(text, within = 'button, a') {
    return this.run(({ text, within }) => {
      const el = [...document.querySelectorAll(within)].find((e) => (e.getAttribute('aria-label') ?? '').includes(text) || e.textContent.includes(text));
      if (!el) throw new Error(`nothing to click: ${text}`);
      el.click();
      return el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 60);
    }, { text, within });
  }

  key(key, opts = {}) {
    return this.run(({ key, opts }) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }));
      return true;
    }, { key, opts });
  }

  async shot(path) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(r.data, 'base64'));
  }
}

export async function waitFor(label, fn, timeoutMs = 120_000, every = 700) {
  globalThis.haloLastStep = label;
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out after ${Math.round((Date.now() - t0) / 1000)}s waiting for ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 200)})`);
}

export { sleep };
