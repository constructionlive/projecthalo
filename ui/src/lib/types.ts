// Mirrors halo-core's serialized types (serde camelCase).

export type Engine = 'claude' | 'codex' | 'opencode';
export type StarStatus = 'forming' | 'working' | 'needsYou' | 'landed' | 'failed' | 'stopped';
export type LogKind = 'said' | 'tool' | 'toolFailed' | 'you' | 'error' | 'note';
export type LineRole = 'you' | 'halo' | 'wake';

export interface LogEntry {
  ts: number;
  kind: LogKind;
  text: string;
}

export interface Star {
  id: string;
  title: string;
  goal: string;
  engine: Engine;
  model: string;
  status: StarStatus;
  created: number;
  updated: number;
  lastActivity: number;
  stalled: boolean;
  now: string;
  question: string | null;
  result: string | null;
  error: string | null;
  turns: number;
  log: LogEntry[];
  /** The workspace it was lit in (null: a folder of its own). */
  workspace?: string | null;
  /** Where it runs: that workspace's folder. */
  cwd?: string | null;
}

/** The scenery a workspace is drawn as. */
export type ArenaKey = 'bay' | 'mesa' | 'porto' | 'glace';

/** A folder the person works in (usually a repository), with git's view of it now. */
export interface Workspace {
  id: string;
  name: string;
  path: string;
  arena: ArenaKey;
  created: number;
  lastUsed: number;
  /** The checked-out branch; null when it isn't a git repository. */
  branch: string | null;
  /** Files with uncommitted changes. */
  dirty: number;
  /** The folder is gone. */
  missing: boolean;
}

export interface Line {
  role: LineRole;
  text: string;
  ts: number;
}

export type TermStatus = 'idle' | 'running' | 'exited';

/** How a terminal's last command ended. */
export interface LastRun {
  command: string;
  exit: number;
  ms: number;
  ended: number;
}

/** One of the person's shells, and what it is doing. */
export interface Terminal {
  id: string;
  workspace: string | null;
  /** Where the shell is now (it follows cd). */
  cwd: string;
  shell: string;
  status: TermStatus;
  /** The command running now. */
  command: string | null;
  started: number | null;
  last: LastRun | null;
  /** Commands run so far. */
  runs: number;
  ports: number[];
  /** The shell reports its commands (else it always reads idle). */
  integrated: boolean;
  /** The shell's own exit code, once it has ended. */
  exit: number | null;
  created: number;
}

/** A theme the person made (or is making): web code built against the kit. */
export interface ThemeInfo {
  id: string;
  name: string;
  description: string;
  kit: number;
  /** What Halo lets it do (its theme.json). */
  permissions: string[];
  /** The built-in it started from. */
  from: string | null;
  /** Good builds so far. */
  version: number;
  built: number | null;
  /** The last build's errors (the previous good build still shows). */
  error: string | null;
  ms: number;
  dir: string;
}

export interface HaloState {
  busy: boolean;
  engine: Engine;
  lines: Line[];
  stars: Star[];
  workspaces: Workspace[];
  /** The workspace in front of the person. */
  current: string | null;
  terminals: Terminal[];
  themes: ThemeInfo[];
}

export type HaloEvent =
  | { type: 'turnStarted'; reason: LineRole; text: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; callId: string; name: string; done: boolean; ok: boolean; summary: string }
  | { type: 'turnDone' }
  | { type: 'error'; message: string }
  | { type: 'star'; star: Star }
  | { type: 'workspaces'; workspaces: Workspace[]; current: string | null }
  | { type: 'terminal'; terminal: Terminal }
  | { type: 'terminalClosed'; id: string }
  | { type: 'theme'; theme: ThemeInfo }
  | { type: 'themeRemoved'; id: string };

export const ENGINE_NAME: Record<Engine, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

/** How far an engine may reach without asking (turns run headless). */
export type Access = 'workspace' | 'full';

/** The Garage: what everything runs on, set once. */
export interface Garage {
  engine: Engine;
  access: Access;
  installed: Engine[];
}

export type SummonKey = 'rightCommand' | 'leftCommand';

export interface HotkeyStatus {
  key: SummonKey;
  label: string;
  allowed: boolean;
  listening: boolean;
}

/** A newer Halo, from the update feed. */
export interface UpdateInfo {
  version: string;
  current: string;
  date: string | null;
  notes: string;
  /** Can't be skipped or put off. */
  critical: boolean;
}

/** A model an engine's CLI offers ("" = its own default). */
export interface ModelChoice {
  id: string;
  label: string;
  note: string;
}

export interface StarFile {
  name: string;
  size: number;
  modified: number;
}
