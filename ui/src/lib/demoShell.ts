// A browser-only stand-in for real shells: same state and events as the
// engine's terminals, with a few scripted commands. Never used inside the app.

import type { HaloEvent, Terminal } from './types';

const enc = new TextEncoder();
const ESC = '\x1b';
const dim = (s: string) => `${ESC}[38;5;245m${s}${ESC}[0m`;
const violet = (s: string) => `${ESC}[38;5;141m${s}${ESC}[0m`;
const amber = (s: string) => `${ESC}[38;5;214m${s}${ESC}[0m`;
const green = (s: string) => `${ESC}[32m${s}${ESC}[0m`;
const red = (s: string) => `${ESC}[31m${s}${ESC}[0m`;
const bold = (s: string) => `${ESC}[1m${s}${ESC}[0m`;

interface Shell {
  t: Terminal;
  branch: string;
  scroll: string;
  /** Bytes printed in all. */
  total: number;
  line: string;
  /** Stops what is running (Ctrl-C). */
  stop: (() => void) | null;
}

type Script = { out: [number, string][]; exit?: number; port?: number };

/** What the scripted commands print, line by line with delays (ms). */
function script(cmd: string, sh: Shell): Script | null {
  const [name, ...rest] = cmd.trim().split(/\s+/);
  const arg = rest.join(' ');
  if (/^npm run (dev|start)$|^pnpm dev$|^vite$/.test(cmd.trim())) {
    return { out: [[300, `\r\n  ${bold('VITE')} v6.4.1  ready in ${green('412 ms')}\r\n\r\n`], [80, `  ${green('➜')}  ${bold('Local')}:   http://localhost:${amber('5173')}/\r\n  ${dim('➜  Network: use --host to expose')}\r\n`]], port: 5173 };
  }
  if (/^cargo test/.test(cmd.trim())) {
    return {
      out: [
        [400, `${green('   Compiling')} billing v0.4.2 (${sh.t.cwd})\r\n`],
        [900, `${green('    Finished')} \`test\` profile [unoptimized + debuginfo] target(s) in 6.12s\r\n${green('     Running')} unittests src/lib.rs\r\n\r\nrunning 214 tests\r\n`],
        [300, `test webhooks::records_event_id_in_same_tx ... ${green('ok')}\r\ntest webhooks::replays_same_event_once ... ${green('ok')}\r\ntest webhooks::retries_after_timeout ... ${red('FAILED')}\r\n`],
        [200, `\r\nfailures:\r\n\r\n---- webhooks::retries_after_timeout stdout ----\r\nthread 'webhooks::retries_after_timeout' panicked at src/webhooks/stripe.rs:212:9:\r\nassertion \`left == right\` failed: retry fired before the 2 s backoff\r\n  left: 1\r\n right: 0\r\n\r\ntest result: ${red('FAILED')}. 212 passed; 2 failed; 0 ignored; finished in 1.84s\r\n\r\n${red('error')}: test failed, to rerun pass \`--lib\`\r\n`],
      ],
      exit: 101,
    };
  }
  if (name === 'ls') return { out: [[20, `${violet('src')}  ${violet('tests')}  Cargo.toml  Cargo.lock  README.md  ${violet('migrations')}\r\n`]], exit: 0 };
  if (name === 'pwd') return { out: [[10, `${sh.t.cwd}\r\n`]], exit: 0 };
  if (name === 'echo') return { out: [[10, `${arg}\r\n`]], exit: 0 };
  if (cmd.trim() === 'git status') return { out: [[60, `On branch ${sh.branch}\r\nChanges not staged for commit:\r\n\t${red('modified:   src/webhooks/stripe.rs')}\r\n\t${red('modified:   tests/replay.rs')}\r\n`]], exit: 0 };
  if (name === 'sleep') return { out: [[Math.min(10, Number(arg) || 1) * 1000, '']], exit: 0 };
  if (name === 'false') return { out: [[10, '']], exit: 1 };
  if (name === 'true' || !name) return { out: [[0, '']], exit: 0 };
  return { out: [[30, `zsh: command not found: ${name}\r\n`]], exit: 127 };
}

export function makeShells(emit: (e: HaloEvent) => void, list: () => Terminal[], setList: (t: Terminal[]) => void) {
  const shells = new Map<string, Shell>();
  let listeners: ((id: string, at: number, data: Uint8Array) => void)[] = [];
  let seq = 1;

  const prompt = (sh: Shell) => `\r\n${dim(sh.t.cwd)} ${violet(sh.branch)}\r\n${amber('❯')} `;
  const out = (sh: Shell, s: string) => {
    sh.scroll += s;
    if (sh.scroll.length > 200_000) sh.scroll = sh.scroll.slice(-200_000);
    const bytes = enc.encode(s);
    const at = sh.total;
    sh.total += bytes.length;
    listeners.forEach((l) => l(sh.t.id, at, bytes));
  };
  const publish = (sh: Shell) => {
    const t = { ...sh.t, ports: [...sh.t.ports] };
    setList(list().some((x) => x.id === t.id) ? list().map((x) => (x.id === t.id ? t : x)) : [...list(), t]);
    emit({ type: 'terminal', terminal: t });
  };

  const run = (sh: Shell, cmd: string) => {
    if (cmd.trim() === 'clear') {
      out(sh, `${ESC}[2J${ESC}[H${amber('❯')} `);
      return;
    }
    if (cmd.trim() === 'exit') {
      sh.t = { ...sh.t, status: 'exited', exit: 0 };
      publish(sh);
      return;
    }
    const s = script(cmd, sh);
    if (!s) return;
    sh.t = { ...sh.t, status: 'running', command: cmd.trim(), started: Date.now(), runs: sh.t.runs + 1 };
    publish(sh);
    let i = 0;
    let timer = 0;
    const finish = (exit: number) => {
      const started = sh.t.started ?? Date.now();
      sh.t = { ...sh.t, status: 'idle', command: null, started: null, ports: [], last: { command: cmd.trim(), exit, ms: Date.now() - started, ended: Date.now() } };
      sh.stop = null;
      out(sh, prompt(sh));
      publish(sh);
    };
    const step = () => {
      if (i >= s.out.length) {
        if (s.port) {
          sh.t = { ...sh.t, ports: [s.port] };
          publish(sh);
          return;
        }
        return finish(s.exit ?? 0);
      }
      const [delay, text] = s.out[i++];
      timer = window.setTimeout(() => (out(sh, text), step()), delay);
    };
    sh.stop = () => {
      clearTimeout(timer);
      out(sh, '^C');
      finish(130);
    };
    step();
  };

  const open = (t: Terminal, branch: string, history = ''): Terminal => {
    const sh: Shell = { t, branch, scroll: '', total: 0, line: '', stop: null };
    shells.set(t.id, sh);
    out(sh, history + prompt(sh));
    return t;
  };

  return {
    /** A shell as the demo starts with it (already part of the state). */
    seed(t: Terminal, branch: string, history: string) {
      open(t, branch, history);
    },
    open(cwd: string, workspace: string | null, branch: string): Terminal {
      const t: Terminal = { id: `t${seq++}demo`, workspace, cwd, shell: 'zsh', status: 'idle', command: null, started: null, last: null, runs: 0, ports: [], integrated: true, exit: null, created: Date.now() };
      open(t, branch);
      publish(shells.get(t.id)!);
      return t;
    },
    write(id: string, data: string) {
      const sh = shells.get(id);
      if (!sh || sh.t.status === 'exited') return;
      for (const ch of data) {
        if (ch === '\x03') {
          if (sh.stop) sh.stop();
          else {
            sh.line = '';
            out(sh, `^C${prompt(sh)}`);
          }
        } else if (sh.t.status === 'running') {
          continue;
        } else if (ch === '\r') {
          const cmd = sh.line;
          sh.line = '';
          out(sh, '\r\n');
          if (cmd.trim()) run(sh, cmd);
          else out(sh, prompt(sh));
        } else if (ch === '\x7f') {
          if (sh.line) {
            sh.line = sh.line.slice(0, -1);
            out(sh, '\b \b');
          }
        } else if (ch >= ' ') {
          sh.line += ch;
          out(sh, ch);
        }
      }
    },
    close(id: string) {
      shells.get(id)?.stop?.();
      shells.delete(id);
      setList(list().filter((t) => t.id !== id));
      emit({ type: 'terminalClosed', id });
    },
    replay(id: string): { at: number; data: Uint8Array } {
      const sh = shells.get(id);
      // The scroll keeps whole strings: its bytes end exactly at the total.
      const data = enc.encode(sh?.scroll ?? '');
      return { at: sh?.total ?? 0, data: data.slice(Math.max(0, data.length - (sh?.total ?? 0))) };
    },
    on(cb: (id: string, at: number, data: Uint8Array) => void) {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    },
  };
}
