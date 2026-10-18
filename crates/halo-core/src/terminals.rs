//! Terminals: the person's real shells, each in a workspace's folder. The UI
//! draws them; Halo can read them. What a shell is doing (at a prompt, running
//! a command, how that command ended) comes from shell integration: hooks
//! added after the person's own config that print the semantic prompt marks
//! terminals use (OSC 133, as VS Code and iTerm do), and the command line
//! (OSC 633;E). Ports a terminal's processes listen on are looked up now and
//! then.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use crossbeam_channel::Sender;
use parking_lot::Mutex;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};

use crate::workspaces::Workspace;
use crate::{HaloEvent, now_ms};

/// Output kept per terminal, for a view that opens late and for Halo to read.
const SCROLLBACK: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TermStatus {
	/// At a prompt (or a shell without integration: we can't tell).
	Idle,
	/// Running a command.
	Running,
	/// The shell itself has ended.
	Exited,
}

/// How a command ended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
	pub command: String,
	pub exit: i32,
	pub ms: u64,
	pub ended: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermSnapshot {
	pub id: String,
	/// The workspace it was opened in, if any.
	pub workspace: Option<String>,
	/// Where the shell is now (it follows `cd`).
	pub cwd: PathBuf,
	/// "zsh", "bash"…
	pub shell: String,
	pub status: TermStatus,
	/// The command running now.
	pub command: Option<String>,
	/// When it started.
	pub started: Option<u64>,
	pub last: Option<LastRun>,
	/// Commands run so far (laps).
	pub runs: u32,
	/// TCP ports its processes listen on.
	pub ports: Vec<u16>,
	/// The shell reports its commands (else status stays Idle).
	pub integrated: bool,
	/// The shell's exit code, once it has ended.
	pub exit: Option<i32>,
	pub created: u64,
}

pub struct TermConfig {
	/// The shell to run (default: the person's `$SHELL`).
	pub shell: Option<PathBuf>,
	/// Load the person's own shell config (tests turn it off).
	pub user_config: bool,
	/// How often ports are looked up.
	pub port_every: Duration,
}

impl Default for TermConfig {
	fn default() -> Self {
		Self { shell: None, user_config: true, port_every: Duration::from_secs(3) }
	}
}

/// Where output goes as it arrives (the app forwards it to the window): the
/// terminal, where this chunk starts in its whole output, and the bytes.
pub type TermSink = Arc<dyn Fn(&str, u64, &[u8]) + Send + Sync>;

struct Term {
	snap: TermSnapshot,
	master: Box<dyn MasterPty + Send>,
	writer: Box<dyn Write + Send>,
	child: Box<dyn Child + Send + Sync>,
	pid: Option<u32>,
	scroll: Vec<u8>,
	/// Bytes it has printed in all (the scrollback keeps only the end).
	total: u64,
}

struct Inner {
	cfg: TermConfig,
	/// Where the integration scripts live.
	dir: PathBuf,
	terms: Mutex<BTreeMap<String, Term>>,
	events: Sender<HaloEvent>,
	sink: Mutex<Option<TermSink>>,
	seq: AtomicU64,
}

#[derive(Clone)]
pub struct Terminals {
	inner: Arc<Inner>,
}

impl Terminals {
	/// `dir`: a folder of Halo's own for the shell integration scripts.
	pub fn new(dir: PathBuf, cfg: TermConfig, events: Sender<HaloEvent>) -> Self {
		if let Err(e) = write_integration(&dir) {
			log::warn!("could not write shell integration: {e}");
		}
		let every = cfg.port_every;
		let t = Self { inner: Arc::new(Inner { cfg, dir, terms: Mutex::default(), events, sink: Mutex::default(), seq: AtomicU64::new(0) }) };
		let weak: Weak<Inner> = Arc::downgrade(&t.inner);
		let _ = std::thread::Builder::new().name("halo-ports".into()).spawn(move || {
			loop {
				std::thread::sleep(every);
				let Some(inner) = weak.upgrade() else { break };
				Terminals { inner }.scan_ports();
			}
		});
		t
	}

	pub fn set_sink(&self, sink: TermSink) {
		*self.inner.sink.lock() = Some(sink);
	}

	/// Opens a shell in the workspace's folder (or the home folder).
	pub fn open(&self, workspace: Option<&Workspace>, cols: u16, rows: u16) -> Result<TermSnapshot, String> {
		let cwd = workspace.map(|w| w.path.clone()).or_else(dirs::home_dir).unwrap_or_else(|| PathBuf::from("/"));
		let shell = self.inner.cfg.shell.clone().or_else(|| std::env::var_os("SHELL").map(PathBuf::from)).unwrap_or_else(|| PathBuf::from("/bin/zsh"));
		let name = shell.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "sh".into());
		let pair = native_pty_system().openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }).map_err(|e| format!("couldn't open a terminal: {e}"))?;
		let mut cmd = CommandBuilder::new(&shell);
		cmd.cwd(&cwd);
		cmd.env("TERM", "xterm-256color");
		cmd.env("COLORTERM", "truecolor");
		cmd.env("TERM_PROGRAM", "Halo");
		let user_home = if self.inner.cfg.user_config { std::env::var_os("ZDOTDIR").map(PathBuf::from).or_else(dirs::home_dir) } else { Some(self.inner.dir.join("empty")) };
		let integrated = match name.as_str() {
			"zsh" => {
				cmd.arg("-l");
				cmd.env("ZDOTDIR", self.inner.dir.join("zsh"));
				if let Some(h) = &user_home {
					cmd.env("HALO_USER_ZDOTDIR", h);
				}
				true
			}
			"bash" => {
				cmd.args(["--rcfile".as_ref(), self.inner.dir.join("bash/rc.sh").as_os_str(), "-i".as_ref()]);
				cmd.env("HALO_LOAD_USER", if self.inner.cfg.user_config { "1" } else { "0" });
				true
			}
			_ => {
				cmd.arg("-l");
				false
			}
		};
		let child = pair.slave.spawn_command(cmd).map_err(|e| format!("couldn't start {name}: {e}"))?;
		drop(pair.slave);
		let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
		let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
		let id = format!("t{}{}", crate::stars::base36(now_ms() / 1000), crate::stars::base36(self.inner.seq.fetch_add(1, Ordering::Relaxed)));
		let snap =
			TermSnapshot { id: id.clone(), workspace: workspace.map(|w| w.id.clone()), cwd, shell: name, status: TermStatus::Idle, command: None, started: None, last: None, runs: 0, ports: Vec::new(), integrated, exit: None, created: now_ms() };
		let pid = child.process_id();
		self.inner.terms.lock().insert(id.clone(), Term { snap: snap.clone(), master: pair.master, writer, child, pid, scroll: Vec::new(), total: 0 });
		self.emit(&snap);
		let me = self.clone();
		let rid = id.clone();
		let _ = std::thread::Builder::new().name(format!("term-{id}")).spawn(move || me.pump(&rid, reader));
		Ok(snap)
	}

	/// Reads the shell's output until it ends: to the window, into the scrollback, and through the marks.
	fn pump(&self, id: &str, mut reader: Box<dyn Read + Send>) {
		let mut buf = vec![0u8; 64 * 1024];
		let mut marks = MarkScanner::default();
		loop {
			let n = match reader.read(&mut buf) {
				Ok(0) | Err(_) => break,
				Ok(n) => n,
			};
			let chunk = &buf[..n];
			let found = marks.feed(chunk);
			let (changed, at) = {
				let mut terms = self.inner.terms.lock();
				let Some(t) = terms.get_mut(id) else { break };
				let at = t.total;
				t.total += n as u64;
				t.scroll.extend_from_slice(chunk);
				if t.scroll.len() > SCROLLBACK {
					let cut = t.scroll.len() - SCROLLBACK;
					t.scroll.drain(..cut);
				}
				let mut changed = false;
				for m in found {
					changed |= apply(&mut t.snap, m);
				}
				(changed.then(|| t.snap.clone()), at)
			};
			if let Some(sink) = self.inner.sink.lock().clone() {
				sink(id, at, chunk);
			}
			if let Some(s) = changed {
				self.emit(&s);
			}
		}
		let snap = {
			let mut terms = self.inner.terms.lock();
			let Some(t) = terms.get_mut(id) else { return };
			let code = t.child.wait().ok().map(|s| s.exit_code() as i32);
			t.snap.status = TermStatus::Exited;
			t.snap.command = None;
			t.snap.started = None;
			t.snap.ports.clear();
			t.snap.exit = code;
			t.snap.clone()
		};
		self.emit(&snap);
	}

	/// What the person typed (or pasted), as is.
	pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
		let mut terms = self.inner.terms.lock();
		let t = terms.get_mut(id).ok_or_else(|| format!("there is no terminal {id}"))?;
		t.writer.write_all(data).and_then(|_| t.writer.flush()).map_err(|e| e.to_string())
	}

	pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
		let terms = self.inner.terms.lock();
		let t = terms.get(id).ok_or_else(|| format!("there is no terminal {id}"))?;
		t.master.resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
	}

	/// Ends the shell and everything it started.
	pub fn close(&self, id: &str) -> Result<(), String> {
		let mut t = self.inner.terms.lock().remove(id).ok_or_else(|| format!("there is no terminal {id}"))?;
		if let Some(pid) = t.pid {
			// Everything it started goes too: each job has its own process group,
			// so a dev server would outlive a signal to the shell's alone.
			let family: Vec<String> = process_tree().map(|tree| descendants(&tree, pid)).unwrap_or_default().into_iter().map(|p| p.to_string()).collect();
			if !family.is_empty() {
				let _ = Command::new("kill").arg("-HUP").args(&family).status();
			}
		}
		let _ = t.child.kill();
		let _ = self.inner.events.send(HaloEvent::TerminalClosed { id: id.to_string() });
		Ok(())
	}

	pub fn list(&self) -> Vec<TermSnapshot> {
		let mut v: Vec<TermSnapshot> = self.inner.terms.lock().values().map(|t| t.snap.clone()).collect();
		v.sort_by_key(|t| t.created);
		v
	}

	pub fn get(&self, id: &str) -> Option<TermSnapshot> {
		self.inner.terms.lock().get(id).map(|t| t.snap.clone())
	}

	/// Everything kept of its output, as the terminal drew it (escape codes and
	/// all), and where it ends in the whole output: a view that then follows the
	/// sink skips what it already has.
	pub fn replay(&self, id: &str) -> Option<(u64, Vec<u8>)> {
		self.inner.terms.lock().get(id).map(|t| (t.total, t.scroll.clone()))
	}

	/// The last `lines` lines as plain text: what Halo reads.
	pub fn read(&self, id: &str, lines: usize) -> Option<String> {
		let (_, raw) = self.replay(id)?;
		let text = plain_text(&raw);
		let all: Vec<&str> = text.lines().collect();
		Some(all[all.len().saturating_sub(lines)..].join("\n"))
	}

	/// Ends every shell (Halo quitting).
	pub fn shutdown(&self) {
		let ids: Vec<String> = self.inner.terms.lock().keys().cloned().collect();
		for id in ids {
			let _ = self.close(&id);
		}
	}

	/// For the line in front of Halo's turns: what the terminals are doing.
	pub fn context(&self) -> String {
		let list = self.list();
		if list.is_empty() {
			return String::new();
		}
		let parts: Vec<String> = list.iter().map(describe).collect();
		format!("terminals: {}", parts.join("; "))
	}

	fn emit(&self, snap: &TermSnapshot) {
		let _ = self.inner.events.send(HaloEvent::Terminal { terminal: Box::new(snap.clone()) });
	}

	/// Which ports each terminal's processes listen on.
	fn scan_ports(&self) {
		let shells: Vec<(String, u32)> = self.inner.terms.lock().values().filter(|t| t.snap.status != TermStatus::Exited).filter_map(|t| t.pid.map(|p| (t.snap.id.clone(), p))).collect();
		if shells.is_empty() {
			return;
		}
		let (Some(tree), Some(listening)) = (process_tree(), listening_ports()) else { return };
		let mut changed = Vec::new();
		{
			let mut terms = self.inner.terms.lock();
			for (id, root) in shells {
				let family = descendants(&tree, root);
				let mut ports: Vec<u16> = listening.iter().filter(|(pid, _)| family.contains(pid)).map(|(_, port)| *port).collect();
				ports.sort_unstable();
				ports.dedup();
				if let Some(t) = terms.get_mut(&id)
					&& t.snap.ports != ports
				{
					t.snap.ports = ports;
					changed.push(t.snap.clone());
				}
			}
		}
		for s in changed {
			self.emit(&s);
		}
	}
}

/// One line about a terminal, for Halo.
pub fn describe(t: &TermSnapshot) -> String {
	let ports = if t.ports.is_empty() { String::new() } else { format!(" on {}", t.ports.iter().map(|p| format!(":{p}")).collect::<Vec<_>>().join(" ")) };
	let what = match (&t.status, &t.command, &t.last) {
		(TermStatus::Exited, ..) => "shell ended".to_string(),
		(TermStatus::Running, Some(c), _) => format!("running `{c}`{ports}"),
		(_, _, Some(l)) => format!("idle; last `{}` exited {}", l.command, l.exit),
		_ => "idle".to_string(),
	};
	format!("{} {} in {}: {what}", t.id, t.shell, crate::workspaces::tilde(&t.cwd))
}

/// A mark the shell printed.
#[derive(Debug, Clone, PartialEq)]
enum Mark {
	/// OSC 133;A: a prompt is showing.
	Prompt,
	/// OSC 633;E: the command line about to run.
	CommandLine(String),
	/// OSC 133;C: it started.
	Started,
	/// OSC 133;D;n: it ended with this code.
	Finished(i32),
	/// OSC 7: the working directory.
	Cwd(PathBuf),
}

fn apply(s: &mut TermSnapshot, m: Mark) -> bool {
	let now = now_ms();
	match m {
		Mark::CommandLine(c) => {
			s.command = Some(c);
			false
		}
		Mark::Started => {
			s.status = TermStatus::Running;
			s.started = Some(now);
			s.runs += 1;
			true
		}
		Mark::Finished(exit) => {
			if s.status != TermStatus::Running {
				return false;
			}
			let command = s.command.take().unwrap_or_default();
			let ms = s.started.take().map(|t| now.saturating_sub(t)).unwrap_or(0);
			s.status = TermStatus::Idle;
			s.last = Some(LastRun { command, exit, ms, ended: now });
			true
		}
		Mark::Prompt => {
			// A prompt with no end mark before it (Ctrl-C at a prompt…): it's idle.
			let was = s.status == TermStatus::Running;
			if was {
				s.status = TermStatus::Idle;
				s.command = None;
				s.started = None;
			}
			was
		}
		Mark::Cwd(p) => {
			let changed = s.cwd != p;
			s.cwd = p;
			changed
		}
	}
}

/// Finds OSC marks in output that arrives in pieces (a mark may span reads).
#[derive(Default)]
struct MarkScanner {
	state: ScanState,
	osc: Vec<u8>,
}

#[derive(Default, PartialEq)]
enum ScanState {
	#[default]
	Text,
	Esc,
	Osc,
	OscEsc,
}

impl MarkScanner {
	fn feed(&mut self, bytes: &[u8]) -> Vec<Mark> {
		let mut out = Vec::new();
		for &b in bytes {
			self.state = match (&self.state, b) {
				(ScanState::Text, 0x1b) => ScanState::Esc,
				(ScanState::Text, _) => ScanState::Text,
				(ScanState::Esc, b']') => {
					self.osc.clear();
					ScanState::Osc
				}
				(ScanState::Esc, 0x1b) => ScanState::Esc,
				(ScanState::Esc, _) => ScanState::Text,
				(ScanState::Osc, 0x07) => {
					out.extend(parse_mark(&self.osc));
					ScanState::Text
				}
				(ScanState::Osc, 0x1b) => ScanState::OscEsc,
				(ScanState::Osc, _) => {
					// Ours are short; anything huge (an image) isn't worth keeping.
					if self.osc.len() < 8192 {
						self.osc.push(b);
					}
					ScanState::Osc
				}
				(ScanState::OscEsc, b'\\') => {
					out.extend(parse_mark(&self.osc));
					ScanState::Text
				}
				(ScanState::OscEsc, _) => ScanState::Text,
			};
		}
		out
	}
}

fn parse_mark(osc: &[u8]) -> Option<Mark> {
	let s = String::from_utf8_lossy(osc);
	if let Some(rest) = s.strip_prefix("133;") {
		let mut parts = rest.split(';');
		return match parts.next()? {
			"A" => Some(Mark::Prompt),
			"C" => Some(Mark::Started),
			"D" => Some(Mark::Finished(parts.next().and_then(|c| c.trim().parse().ok()).unwrap_or(0))),
			_ => None,
		};
	}
	if let Some(cmd) = s.strip_prefix("633;E;") {
		return Some(Mark::CommandLine(cmd.trim().to_string()));
	}
	if let Some(url) = s.strip_prefix("7;file://") {
		// file://host/path: the path starts at the first slash after the host.
		let path = url.find('/').map(|i| &url[i..]).unwrap_or("/");
		return Some(Mark::Cwd(PathBuf::from(percent_decode(path))));
	}
	None
}

fn percent_decode(s: &str) -> String {
	let b = s.as_bytes();
	let mut out = Vec::with_capacity(b.len());
	let mut i = 0;
	while i < b.len() {
		if b[i] == b'%'
			&& i + 2 < b.len()
			&& let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
		{
			out.push(v);
			i += 3;
			continue;
		}
		out.push(b[i]);
		i += 1;
	}
	String::from_utf8_lossy(&out).into_owned()
}

/// Terminal output as plain text, as the screen showed it: escape codes gone,
/// and the cursor followed (carriage returns, backspaces, moves along the line,
/// erasing), so a line a shell or a progress bar redrew reads as it was left.
pub fn plain_text(raw: &[u8]) -> String {
	let s = String::from_utf8_lossy(raw);
	let mut lines: Vec<Vec<char>> = vec![Vec::new()];
	let (mut row, mut col) = (0usize, 0usize);
	let mut it = s.chars().peekable();
	while let Some(c) = it.next() {
		match c {
			'\x1b' => match it.next() {
				Some('[') => {
					// CSI: parameters, then one final byte in @..~.
					let mut params = String::new();
					let mut fin = None;
					for c in it.by_ref() {
						if ('@'..='~').contains(&c) {
							fin = Some(c);
							break;
						}
						params.push(c);
					}
					let nums: Vec<usize> = params.trim_start_matches('?').split(';').map(|n| n.parse().unwrap_or(0)).collect();
					let n = nums.first().copied().unwrap_or(0).max(1);
					let line = &mut lines[row];
					match fin {
						Some('D') => col = col.saturating_sub(n),
						Some('C') => col += n,
						Some('G') => col = n - 1,
						Some('K') => match nums.first().copied().unwrap_or(0) {
							0 => line.truncate(col),
							1 => line.iter_mut().take(col + 1).for_each(|ch| *ch = ' '),
							_ => line.clear(),
						},
						Some('A') => row = row.saturating_sub(n),
						Some('B') => row = (row + n).min(lines.len() - 1),
						Some('J') if nums.first().copied().unwrap_or(0) >= 2 => {
							lines = vec![Vec::new()];
							(row, col) = (0, 0);
						}
						_ => {}
					}
				}
				Some(']') => {
					// OSC: up to BEL or ESC \.
					while let Some(c) = it.next() {
						if c == '\x07' {
							break;
						}
						if c == '\x1b' {
							it.next();
							break;
						}
					}
				}
				_ => {}
			},
			'\r' => col = 0,
			'\n' => {
				row += 1;
				col = 0;
				if row == lines.len() {
					lines.push(Vec::new());
				}
			}
			'\x08' => col = col.saturating_sub(1),
			'\t' => col = (col / 8 + 1) * 8,
			c if c.is_control() => {}
			c => {
				let line = &mut lines[row];
				if line.len() < col {
					line.resize(col, ' ');
				}
				if col < line.len() {
					line[col] = c;
				} else {
					line.push(c);
				}
				col += 1;
			}
		}
	}
	lines.iter().map(|l| l.iter().collect::<String>().trim_end().to_string()).collect::<Vec<_>>().join("\n")
}

/// pid → parent pid, for every process.
fn process_tree() -> Option<HashMap<u32, u32>> {
	let out = Command::new("ps").args(["-A", "-o", "pid=,ppid="]).output().ok()?;
	Some(
		String::from_utf8_lossy(&out.stdout)
			.lines()
			.filter_map(|l| {
				let mut it = l.split_whitespace();
				Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
			})
			.collect(),
	)
}

fn descendants(tree: &HashMap<u32, u32>, root: u32) -> HashSet<u32> {
	let mut family = HashSet::from([root]);
	loop {
		let before = family.len();
		for (&pid, ppid) in tree {
			if family.contains(ppid) {
				family.insert(pid);
			}
		}
		if family.len() == before {
			return family;
		}
	}
}

/// (pid, port) for every listening TCP socket.
fn listening_ports() -> Option<Vec<(u32, u16)>> {
	let out = Command::new("lsof").args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]).output().ok()?;
	let mut v = Vec::new();
	let mut pid = 0u32;
	for line in String::from_utf8_lossy(&out.stdout).lines() {
		if let Some(p) = line.strip_prefix('p') {
			pid = p.parse().unwrap_or(0);
		} else if let Some(n) = line.strip_prefix('n')
			&& let Some(port) = n.rsplit(':').next().and_then(|p| p.parse().ok())
		{
			v.push((pid, port));
		}
	}
	Some(v)
}

/// The hooks, beside the person's own config: zsh loads ours from ZDOTDIR,
/// which loads theirs, then adds the marks; bash takes ours as its rc file.
fn write_integration(dir: &Path) -> std::io::Result<()> {
	std::fs::create_dir_all(dir.join("zsh"))?;
	std::fs::create_dir_all(dir.join("bash"))?;
	std::fs::create_dir_all(dir.join("empty"))?;
	// Each of zsh's startup files runs the person's own, with ZDOTDIR theirs while it does.
	let pass = |file: &str| {
		format!(
			"# Halo: run your own {file}, then carry on.\n\
			HALO_ZDOTDIR=\"$ZDOTDIR\"\n\
			ZDOTDIR=\"${{HALO_USER_ZDOTDIR:-$HOME}}\"\n\
			[ -f \"$ZDOTDIR/{file}\" ] && . \"$ZDOTDIR/{file}\"\n\
			HALO_USER_ZDOTDIR=\"$ZDOTDIR\"\n\
			ZDOTDIR=\"$HALO_ZDOTDIR\"\n"
		)
	};
	std::fs::write(dir.join("zsh/.zshenv"), pass(".zshenv"))?;
	std::fs::write(dir.join("zsh/.zprofile"), pass(".zprofile"))?;
	std::fs::write(
		dir.join("zsh/.zshrc"),
		pass(".zshrc")
			+ r#"
# Halo: mark prompts and commands so the app can see what this terminal is doing.
if [[ -z "$HALO_HOOKED" ]]; then
  HALO_HOOKED=1
  typeset -g __halo_ran=0
  __halo_precmd() {
    local e=$?
    (( __halo_ran )) && printf '\e]133;D;%s\a' "$e"
    __halo_ran=0
    printf '\e]7;file://%s%s\a' "${HOST}" "${PWD}"
    printf '\e]133;A\a'
  }
  __halo_preexec() {
    __halo_ran=1
    printf '\e]633;E;%s\a' "${1//[$'\a\e\n']/ }"
    printf '\e]133;C\a'
  }
  precmd_functions=(__halo_precmd $precmd_functions)
  preexec_functions+=(__halo_preexec)
fi
"#,
	)?;
	// Last of the login files: ZDOTDIR is the person's again for everything after.
	std::fs::write(dir.join("zsh/.zlogin"), pass(".zlogin") + "ZDOTDIR=\"$HALO_USER_ZDOTDIR\"\n")?;
	std::fs::write(
		dir.join("bash/rc.sh"),
		r#"# Halo: your own bash config, then marks for prompts and commands.
if [ "$HALO_LOAD_USER" = 1 ]; then
  if [ -f ~/.bash_profile ]; then . ~/.bash_profile; elif [ -f ~/.bashrc ]; then . ~/.bashrc; fi
fi
__halo_ran=0
__halo_at_prompt=0
__halo_precmd() {
  ((__halo_ran)) && printf '\e]133;D;%s\a' "$__halo_status"
  __halo_ran=0
  printf '\e]7;file://%s%s\a' "$HOSTNAME" "$PWD"
  printf '\e]133;A\a'
  __halo_at_prompt=1
}
__halo_preexec() {
  [ "$__halo_at_prompt" = 1 ] || return
  [ -n "$COMP_LINE" ] && return
  __halo_at_prompt=0
  __halo_ran=1
  local c
  c=$(HISTTIMEFORMAT= history 1 | sed 's/^ *[0-9]* *//')
  printf '\e]633;E;%s\a' "$c"
  printf '\e]133;C\a'
}
trap '__halo_preexec' DEBUG
PROMPT_COMMAND="__halo_status=\$?; ${PROMPT_COMMAND:+$PROMPT_COMMAND; }__halo_precmd"
"#,
	)?;
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::time::Instant;

	use crossbeam_channel::{Receiver, unbounded};

	use super::*;

	fn terminals(shell: &str) -> (Terminals, Receiver<HaloEvent>, tempfile::TempDir) {
		let dir = tempfile::tempdir().unwrap();
		let (tx, rx) = unbounded();
		let cfg = TermConfig { shell: Some(PathBuf::from(shell)), user_config: false, port_every: Duration::from_millis(400) };
		(Terminals::new(dir.path().join("shell"), cfg, tx), rx, dir)
	}

	fn wait(what: &str, secs: u64, f: impl Fn() -> bool) {
		let t = Instant::now();
		while !f() {
			assert!(t.elapsed() < Duration::from_secs(secs), "timed out waiting for {what}");
			std::thread::sleep(Duration::from_millis(20));
		}
	}

	fn workspace(dir: &Path) -> Workspace {
		Workspace { id: "w1".into(), name: "repo".into(), path: std::fs::canonicalize(dir).unwrap(), arena: "bay".into(), created: 0, last_used: 0 }
	}

	#[test]
	fn the_scanner_finds_marks_split_across_reads() {
		let mut s = MarkScanner::default();
		let mut all = Vec::new();
		let stream = b"hi \x1b]633;E;cargo test\x07\x1b]133;C\x07out\x1b[31mred\x1b]133;D;101\x1b\\\x1b]7;file://mac/Users/me/my%20code\x07";
		for piece in stream.chunks(3) {
			all.extend(s.feed(piece));
		}
		assert_eq!(all, vec![Mark::CommandLine("cargo test".into()), Mark::Started, Mark::Finished(101), Mark::Cwd(PathBuf::from("/Users/me/my code"))]);
	}

	#[test]
	fn plain_text_drops_escapes_and_keeps_redrawn_lines_last_state() {
		let raw = b"\x1b[1mbold\x1b[0m line\r\n 10%\r 55%\r100% done\n\x1b]133;A\x07$ ";
		assert_eq!(plain_text(raw), "bold line\n100% done\n$");
		// A line editor redrawing what was typed ahead: the screen shows it once.
		assert_eq!(plain_text(b"\xe2\x9d\xaf cat x\r\x1b[K\xe2\x9d\xaf cat x\r\n"), "\u{276f} cat x\n");
		assert_eq!(plain_text(b"helo\x08\x08llo"), "hello");
		assert_eq!(plain_text(b"abc\x1b[2Dz\x1b[Kq"), "azq");
		assert_eq!(plain_text(b"old\x1b[2J\x1b[Hnew"), "new");
	}

	fn runs_commands_in(shell: &str) {
		let (t, rx, dir) = terminals(shell);
		let repo = dir.path().join("repo");
		std::fs::create_dir_all(&repo).unwrap();
		let w = workspace(&repo);
		let s = t.open(Some(&w), 100, 30).unwrap();
		assert!(s.integrated && s.workspace.as_deref() == Some("w1"));
		let id = s.id.clone();
		std::thread::sleep(Duration::from_millis(600));
		t.write(&id, b"echo halo-says-hi\n").unwrap();
		wait("echo to finish", 10, || t.get(&id).unwrap().last.is_some());
		let last = t.get(&id).unwrap().last.unwrap();
		assert_eq!((last.command.as_str(), last.exit), ("echo halo-says-hi", 0));
		assert!(t.read(&id, 50).unwrap().contains("halo-says-hi"));

		t.write(&id, b"sleep 0.6; exit_code_7() { return 7; }; exit_code_7\n").unwrap();
		wait("it to be running", 5, || t.get(&id).unwrap().status == TermStatus::Running);
		assert!(t.get(&id).unwrap().command.unwrap().starts_with("sleep 0.6"));
		wait("it to end", 10, || t.get(&id).unwrap().status == TermStatus::Idle);
		let s = t.get(&id).unwrap();
		assert_eq!(s.last.as_ref().unwrap().exit, 7, "{s:?}");
		assert!(s.last.unwrap().ms >= 500);
		assert_eq!(s.runs, 2);

		t.write(&id, b"mkdir -p sub && cd sub\n").unwrap();
		wait("the cwd to follow cd", 5, || t.get(&id).unwrap().cwd.ends_with("repo/sub"));
		assert!(rx.try_iter().any(|e| matches!(e, HaloEvent::Terminal { ref terminal } if terminal.status == TermStatus::Running)));
		t.close(&id).unwrap();
		assert!(t.get(&id).is_none());
	}

	#[test]
	fn replay_and_live_output_join_without_gaps_or_repeats() {
		let (t, _rx, dir) = terminals("/bin/zsh");
		type Chunks = Mutex<Vec<(u64, Vec<u8>)>>;
		let got: Arc<Chunks> = Arc::default();
		let g = got.clone();
		t.set_sink(Arc::new(move |_, at, b| g.lock().push((at, b.to_vec()))));
		let s = t.open(Some(&workspace(dir.path())), 80, 24).unwrap();
		std::thread::sleep(Duration::from_millis(500));
		t.write(&s.id, b"for i in 1 2 3 4 5; do echo line-$i; sleep 0.05; done\n").unwrap();
		std::thread::sleep(Duration::from_millis(80));
		// A view opening mid-stream: the replay, then whatever comes after it.
		let (end, mut seen) = t.replay(&s.id).unwrap();
		wait("the loop to finish", 10, || t.get(&s.id).unwrap().last.is_some());
		std::thread::sleep(Duration::from_millis(100));
		for (at, b) in got.lock().iter() {
			let at_end = at + b.len() as u64;
			if at_end <= end {
				continue;
			}
			let skip = end.saturating_sub(*at) as usize;
			seen.extend_from_slice(&b[skip..]);
		}
		let (_, all) = t.replay(&s.id).unwrap();
		assert_eq!(String::from_utf8_lossy(&seen), String::from_utf8_lossy(&all));
	}

	/// A keystroke's round trip (write → the shell's echo back through the
	/// reader): what typing feels like. Prints the numbers.
	#[test]
	fn keystrokes_echo_back_fast() {
		let (t, _rx, dir) = terminals("/bin/zsh");
		let (tx, rx) = crossbeam_channel::unbounded::<Vec<u8>>();
		t.set_sink(Arc::new(move |_, _, b| {
			let _ = tx.send(b.to_vec());
		}));
		let s = t.open(Some(&workspace(dir.path())), 80, 24).unwrap();
		std::thread::sleep(Duration::from_millis(700));
		while rx.try_recv().is_ok() {}
		let mut times = Vec::new();
		for c in b"abcdefghijklmnopqrst" {
			let t0 = Instant::now();
			t.write(&s.id, &[*c]).unwrap();
			loop {
				let got = rx.recv_timeout(Duration::from_secs(2)).expect("no echo");
				if got.contains(c) {
					break;
				}
			}
			times.push(t0.elapsed());
		}
		times.sort();
		let (median, worst) = (times[times.len() / 2], times[times.len() - 1]);
		println!("keystroke echo: median {median:?}, worst {worst:?}");
		assert!(median < Duration::from_millis(15) && worst < Duration::from_millis(60), "median {median:?}, worst {worst:?}");
	}

	#[test]
	fn zsh_reports_commands_exit_codes_and_cwd() {
		runs_commands_in("/bin/zsh");
	}

	#[test]
	fn bash_reports_commands_exit_codes_and_cwd() {
		runs_commands_in("/bin/bash");
	}

	#[test]
	fn a_server_it_starts_shows_its_port_and_dies_with_it() {
		let (t, _rx, dir) = terminals("/bin/zsh");
		let s = t.open(Some(&workspace(dir.path())), 80, 24).unwrap();
		std::thread::sleep(Duration::from_millis(600));
		let port = 47000 + (std::process::id() % 900) as u16;
		t.write(&s.id, format!("python3 -m http.server {port} --bind 127.0.0.1\n").as_bytes()).unwrap();
		wait("the port to show", 15, || t.get(&s.id).unwrap().ports.contains(&port));
		assert_eq!(t.get(&s.id).unwrap().status, TermStatus::Running);
		assert!(t.context().contains(&format!(":{port}")), "{}", t.context());
		t.write(&s.id, b"\x03").unwrap();
		wait("Ctrl-C to stop it", 10, || {
			let s = t.get(&s.id).unwrap();
			s.status == TermStatus::Idle && s.ports.is_empty()
		});
		let s2 = t.open(None, 80, 24).unwrap();
		std::thread::sleep(Duration::from_millis(600));
		t.write(&s2.id, format!("python3 -m http.server {} --bind 127.0.0.1\n", port + 1).as_bytes()).unwrap();
		wait("the second port", 15, || t.get(&s2.id).unwrap().ports.contains(&(port + 1)));
		t.close(&s2.id).unwrap();
		wait("closing to stop its server", 10, || std::net::TcpStream::connect(("127.0.0.1", port + 1)).is_err());
	}

	/// With the person's real config (plugins, prompt themes…): run by hand,
	/// `cargo test -p halo-core hooks_survive -- --ignored`.
	#[test]
	#[ignore]
	fn hooks_survive_the_persons_own_zsh_config() {
		let dir = tempfile::tempdir().unwrap();
		let (tx, _rx) = unbounded();
		let t = Terminals::new(dir.path().join("shell"), TermConfig { shell: Some("/bin/zsh".into()), ..Default::default() }, tx);
		let s = t.open(None, 100, 30).unwrap();
		std::thread::sleep(Duration::from_secs(2));
		t.write(&s.id, b"false\n").unwrap();
		wait("false to finish", 15, || t.get(&s.id).unwrap().last.is_some());
		let last = t.get(&s.id).unwrap().last.unwrap();
		assert_eq!((last.command.as_str(), last.exit), ("false", 1));
		t.close(&s.id).unwrap();
	}

	#[test]
	fn halo_reads_typed_ahead_input_as_the_screen_shows_it() {
		let (t, _rx, dir) = terminals("/bin/zsh");
		let s = t.open(Some(&workspace(dir.path())), 100, 24).unwrap();
		std::thread::sleep(Duration::from_millis(600));
		t.write(&s.id, b"sleep 5\n").unwrap();
		wait("sleep to start", 5, || t.get(&s.id).unwrap().status == TermStatus::Running);
		// Ctrl-C and the next command at once, before the prompt is back.
		t.write(&s.id, b"\x03cat no-such-file.txt\n").unwrap();
		wait("cat to fail", 10, || t.get(&s.id).unwrap().last.as_ref().is_some_and(|l| l.command.starts_with("cat")));
		std::thread::sleep(Duration::from_millis(200));
		let text = t.read(&s.id, 30).unwrap();
		assert!(!text.contains("ccat") && text.contains("cat no-such-file.txt") && text.contains("No such file"), "{text}");
	}

	#[test]
	fn exiting_the_shell_is_reported() {
		let (t, _rx, dir) = terminals("/bin/zsh");
		let s = t.open(Some(&workspace(dir.path())), 80, 24).unwrap();
		std::thread::sleep(Duration::from_millis(500));
		t.write(&s.id, b"exit 3\n").unwrap();
		wait("the shell to end", 10, || t.get(&s.id).unwrap().status == TermStatus::Exited);
		assert_eq!(t.get(&s.id).unwrap().exit, Some(3));
	}
}
