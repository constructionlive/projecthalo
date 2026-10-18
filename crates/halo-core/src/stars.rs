//! Stars: background agents. Each is its own CLI session in its own folder.
//! Halo lights one and moves on; the star reports back through a [`Wake`]
//! when it lands, needs the person, fails, or goes quiet too long.

use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use cc_agent::session::Msg;
use cc_agent::{AgentEvent, ChatSession, Toolbox, TurnHandle};
use crossbeam_channel::Sender;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::runner::{Engine, Runner, TurnSpec};
use crate::store::Store;
use crate::workspaces::Workspace;
use crate::{HaloEvent, now_ms, prompt};

/// Builds a star's tools for its folder (the app adds voice…).
pub type ToolboxFor = Arc<dyn Fn(PathBuf) -> Toolbox + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StarStatus {
	/// Waiting for a free slot.
	Forming,
	Working,
	NeedsYou,
	Landed,
	Failed,
	Stopped,
}

impl StarStatus {
	pub fn label(self) -> &'static str {
		match self {
			StarStatus::Forming => "forming",
			StarStatus::Working => "working",
			StarStatus::NeedsYou => "needs you",
			StarStatus::Landed => "landed",
			StarStatus::Failed => "failed",
			StarStatus::Stopped => "stopped",
		}
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LogKind {
	/// The star said something.
	Said,
	Tool,
	ToolFailed,
	/// The person (or Halo on their behalf) told it something.
	You,
	Error,
	Note,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogEntry {
	pub ts: u64,
	pub kind: LogKind,
	pub text: String,
}

/// Everything the UI and Halo see of a star.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarSnapshot {
	pub id: String,
	pub title: String,
	pub goal: String,
	pub engine: Engine,
	#[serde(default)]
	pub model: String,
	pub status: StarStatus,
	pub created: u64,
	pub updated: u64,
	pub last_activity: u64,
	/// Quiet longer than the stall limit while working.
	#[serde(default)]
	pub stalled: bool,
	/// One line: what it is doing right now.
	pub now: String,
	pub question: Option<String>,
	pub result: Option<String>,
	pub error: Option<String>,
	pub turns: u32,
	/// The most recent entries (the whole history is in the event log).
	pub log: Vec<LogEntry>,
	/// The workspace it was lit in, if any…
	#[serde(default)]
	pub workspace: Option<String>,
	/// …and that workspace's folder, where it runs (else its own folder).
	#[serde(default)]
	pub cwd: Option<PathBuf>,
}

const LOG_KEEP: usize = 80;
const RESULT_MAX: usize = 6000;

/// A star reporting back to Halo.
#[derive(Debug, Clone, PartialEq)]
pub enum Wake {
	Landed { id: String, title: String, result: String },
	NeedsYou { id: String, title: String, question: String },
	Failed { id: String, title: String, error: String },
	Stalled { id: String, title: String, now: String, minutes: u64 },
}

impl Wake {
	pub fn id(&self) -> &str {
		match self {
			Wake::Landed { id, .. } | Wake::NeedsYou { id, .. } | Wake::Failed { id, .. } | Wake::Stalled { id, .. } => id,
		}
	}

	/// The message Halo wakes up to.
	pub fn render(&self) -> String {
		match self {
			Wake::Landed { id, title, result } => format!("[AGENT DONE] {id} \"{title}\"\n{result}"),
			Wake::NeedsYou { id, title, question } => format!("[AGENT NEEDS YOU] {id} \"{title}\" asks: {question}"),
			Wake::Failed { id, title, error } => format!("[AGENT FAILED] {id} \"{title}\": {error}"),
			Wake::Stalled { id, title, now, minutes } => {
				format!("[AGENT STALLED] {id} \"{title}\" has been quiet for {minutes} min. Last seen: {now}. Peek at it, tell it something, or stop it.")
			}
		}
	}
}

pub struct StarConfig {
	pub engine: Engine,
	pub model: String,
	/// Quiet this long while working = stalled (Halo is woken once).
	pub stall_after: Duration,
	/// Stars running at once; the rest wait as `Forming`.
	pub max_running: usize,
	/// How often the watchdog looks.
	pub watch_every: Duration,
}

impl Default for StarConfig {
	fn default() -> Self {
		Self { engine: Engine::Claude, model: String::new(), stall_after: Duration::from_secs(6 * 60), max_running: 4, watch_every: Duration::from_secs(15) }
	}
}

struct Slot {
	snap: StarSnapshot,
	session: Arc<Mutex<ChatSession>>,
	running: bool,
	cancel: Option<Arc<AtomicBool>>,
	stop_asked: bool,
	/// Messages for the star's next turn (it was busy, or waiting for a slot).
	inbox: VecDeque<String>,
}

struct Inner {
	runner: Arc<dyn Runner>,
	store: Arc<Store>,
	toolbox_for: ToolboxFor,
	cfg: StarConfig,
	/// New stars run on this unless told otherwise (starts as `cfg.engine`).
	engine: Mutex<(Engine, String)>,
	slots: Mutex<BTreeMap<String, Slot>>,
	events: Sender<HaloEvent>,
	wakes: Sender<Wake>,
	seq: AtomicU64,
}

#[derive(Clone)]
pub struct StarRuntime {
	inner: Arc<Inner>,
}

impl StarRuntime {
	pub fn new(runner: Arc<dyn Runner>, store: Arc<Store>, toolbox_for: ToolboxFor, cfg: StarConfig, events: Sender<HaloEvent>, wakes: Sender<Wake>) -> Self {
		let every = cfg.watch_every;
		let rt = Self { inner: Arc::new(Inner { runner, store, toolbox_for, engine: Mutex::new((cfg.engine, cfg.model.clone())), cfg, slots: Mutex::default(), events, wakes, seq: AtomicU64::new(0) }) };
		rt.load();
		let weak: Weak<Inner> = Arc::downgrade(&rt.inner);
		let _ = std::thread::Builder::new().name("halo-watchdog".into()).spawn(move || {
			loop {
				std::thread::sleep(every);
				let Some(inner) = weak.upgrade() else { break };
				StarRuntime { inner }.watch();
			}
		});
		rt
	}

	/// Stars from earlier runs. Ones that were mid-turn are marked stopped: the
	/// person can tell them to carry on (their session resumes).
	fn load(&self) {
		let store = &self.inner.store;
		let mut slots = self.inner.slots.lock();
		for id in store.star_ids() {
			let dir = store.star_dir(&id);
			let Some(mut snap) = store.load::<StarSnapshot>(&dir.join("star.json")) else { continue };
			let session = store.load::<ChatSession>(&dir.join("session.json")).unwrap_or_default();
			if matches!(snap.status, StarStatus::Working | StarStatus::Forming) {
				snap.status = StarStatus::Stopped;
				snap.now = "Interrupted when Halo closed. Tell it to carry on.".into();
				push_log(&mut snap, LogKind::Note, "Interrupted when Halo closed");
			}
			slots.insert(id, Slot { snap, session: Arc::new(Mutex::new(session)), running: false, cancel: None, stop_asked: false, inbox: VecDeque::new() });
		}
	}

	fn new_id(&self) -> String {
		let n = self.inner.seq.fetch_add(1, Ordering::Relaxed);
		format!("s{}{}", base36(now_ms() / 1000), base36(n))
	}

	/// Lights a star in its own folder and returns at once; it works in the background.
	pub fn spawn(&self, title: &str, goal: &str, engine: Option<Engine>, model: Option<String>) -> StarSnapshot {
		self.spawn_in(title, goal, engine, model, None)
	}

	/// Lights a star that works in a workspace's folder, beside any others there.
	pub fn spawn_in(&self, title: &str, goal: &str, engine: Option<Engine>, model: Option<String>, workspace: Option<&Workspace>) -> StarSnapshot {
		let id = self.new_id();
		let now = now_ms();
		let snap = StarSnapshot {
			id: id.clone(),
			title: clip(title.trim(), 80),
			goal: goal.trim().to_string(),
			engine: engine.unwrap_or_else(|| self.inner.engine.lock().0),
			model: model.unwrap_or_else(|| self.inner.engine.lock().1.clone()),
			status: StarStatus::Forming,
			created: now,
			updated: now,
			last_activity: now,
			stalled: false,
			now: "Getting ready".into(),
			question: None,
			result: None,
			error: None,
			turns: 0,
			log: Vec::new(),
			workspace: workspace.map(|w| w.id.clone()),
			cwd: workspace.map(|w| w.path.clone()),
		};
		self.inner.store.record("lit", Some(&id), &format!("{}: {}", snap.title, snap.goal));
		self.inner.slots.lock().insert(id.clone(), Slot { snap, session: Arc::default(), running: false, cancel: None, stop_asked: false, inbox: VecDeque::new() });
		self.save(&id);
		self.start_or_queue(&id, goal.trim().to_string());
		self.get(&id).expect("just inserted")
	}

	/// What new stars run on from now on; ones already lit keep theirs.
	pub fn set_engine(&self, engine: Engine, model: String) {
		*self.inner.engine.lock() = (engine, model);
	}

	fn running(&self) -> usize {
		self.inner.slots.lock().values().filter(|s| s.running).count()
	}

	fn start_or_queue(&self, id: &str, text: String) {
		if self.running() >= self.inner.cfg.max_running.max(1) {
			let snap = {
				let mut slots = self.inner.slots.lock();
				let Some(slot) = slots.get_mut(id) else { return };
				slot.inbox.push_back(text);
				slot.snap.status = StarStatus::Forming;
				slot.snap.now = "Waiting for a free slot".into();
				slot.snap.updated = now_ms();
				slot.snap.clone()
			};
			self.emit(snap);
			return;
		}
		self.run(id, text);
	}

	fn run(&self, id: &str, text: String) {
		let (spec, snap) = {
			let mut slots = self.inner.slots.lock();
			let Some(slot) = slots.get_mut(id) else { return };
			slot.running = true;
			slot.stop_asked = false;
			let s = &mut slot.snap;
			s.status = StarStatus::Working;
			s.stalled = false;
			s.question = None;
			s.error = None;
			s.turns += 1;
			s.now = if s.turns == 1 { "Starting".into() } else { "Picking it back up".into() };
			s.last_activity = now_ms();
			s.updated = s.last_activity;
			let dir = s.cwd.clone().unwrap_or_else(|| self.inner.store.star_dir(id).join("work"));
			let toolbox = Arc::new((self.inner.toolbox_for)(dir));
			let system = prompt::star(&s.title, &s.goal, s.cwd.as_deref());
			let spec = TurnSpec { slot: id.to_string(), engine: s.engine, model: s.model.clone(), session: slot.session.clone(), system, toolbox, text, context: String::new() };
			(spec, s.clone())
		};
		self.save(id);
		self.emit(snap);
		let handle = self.inner.runner.start(spec);
		let me = self.clone();
		let id = id.to_string();
		let _ = std::thread::Builder::new().name(format!("star-{id}")).spawn(move || me.drive(&id, handle));
	}

	/// Follows one turn's events until it ends.
	fn drive(&self, id: &str, handle: TurnHandle) {
		{
			let mut slots = self.inner.slots.lock();
			if let Some(slot) = slots.get_mut(id) {
				let flag = handle.cancel_flag();
				if slot.stop_asked {
					flag.store(true, Ordering::Relaxed);
				}
				slot.cancel = Some(flag);
			}
		}
		let mut buf = String::new();
		let mut error = None;
		let mut last_emit = Instant::now();
		for ev in handle.events.iter() {
			let mut entries = Vec::new();
			let mut force = false;
			match ev {
				AgentEvent::TextDelta(d) => buf.push_str(&d),
				AgentEvent::ToolStarted { name, .. } => {
					let said = std::mem::take(&mut buf);
					if !said.trim().is_empty() {
						entries.push((LogKind::Said, clip(said.trim(), 400)));
					}
					entries.push((LogKind::Tool, pretty_tool(&name)));
					force = true;
				}
				AgentEvent::ToolFinished { name, ok: false, summary, .. } => {
					entries.push((LogKind::ToolFailed, format!("{}: {}", pretty_tool(&name), clip(&summary, 200))));
					force = true;
				}
				AgentEvent::Error(e) => error = Some(e),
				AgentEvent::Done { .. } => break,
				AgentEvent::ReasoningDelta(_) | AgentEvent::ToolFinished { .. } | AgentEvent::Usage { .. } => {}
			}
			let line = entries.iter().rev().find(|(k, _)| *k == LogKind::Tool).map(|(_, t)| format!("Using {t}")).or_else(|| now_line(&buf));
			let emit = force || last_emit.elapsed() > Duration::from_millis(250);
			if let Some(snap) = self.touch(id, line, entries, emit) {
				self.emit(snap);
				last_emit = Instant::now();
			}
		}
		self.finish(id, buf, error);
	}

	/// Marks activity; returns a snapshot when it should be shown.
	fn touch(&self, id: &str, now_line: Option<String>, entries: Vec<(LogKind, String)>, emit: bool) -> Option<StarSnapshot> {
		let mut slots = self.inner.slots.lock();
		let slot = slots.get_mut(id)?;
		let s = &mut slot.snap;
		s.last_activity = now_ms();
		let was_stalled = std::mem::take(&mut s.stalled);
		if let Some(l) = now_line {
			s.now = l;
		}
		for (k, t) in entries {
			push_log(s, k, &t);
		}
		(emit || was_stalled).then(|| {
			s.updated = s.last_activity;
			s.clone()
		})
	}

	fn finish(&self, id: &str, buf: String, error: Option<String>) {
		let mut wake = None;
		let mut next = None;
		let snap = {
			let mut slots = self.inner.slots.lock();
			let Some(slot) = slots.get_mut(id) else { return };
			slot.running = false;
			slot.cancel = None;
			let last = final_text(&slot.session.lock()).unwrap_or_else(|| buf.trim().to_string());
			let s = &mut slot.snap;
			let (title, sid) = (s.title.clone(), s.id.clone());
			if !last.is_empty() {
				push_log(s, LogKind::Said, &clip(&last, 400));
			}
			if slot.stop_asked {
				slot.inbox.clear();
				s.status = StarStatus::Stopped;
				s.now = "Stopped".into();
				push_log(s, LogKind::Note, "Stopped");
			} else if !slot.inbox.is_empty() {
				next = Some(slot.inbox.drain(..).collect::<Vec<_>>().join("\n\n"));
			} else if let Some(e) = error.clone().filter(|_| last.is_empty()) {
				s.status = StarStatus::Failed;
				s.error = Some(e.clone());
				s.now = clip(&e, 140);
				wake = Some(Wake::Failed { id: sid, title, error: e });
			} else if let Some(q) = needs_you(&last) {
				s.status = StarStatus::NeedsYou;
				s.question = Some(q.clone());
				s.result = Some(clip(&last, RESULT_MAX));
				s.now = clip(&q, 140);
				wake = Some(Wake::NeedsYou { id: sid, title, question: q });
			} else {
				let result = clip(&last, RESULT_MAX);
				s.status = StarStatus::Landed;
				s.result = Some(result.clone());
				s.now = now_line(&result).unwrap_or_else(|| "Done".into());
				wake = Some(Wake::Landed { id: sid, title, result });
			}
			if let (Some(e), false) = (&error, s.status == StarStatus::Failed) {
				push_log(s, LogKind::Error, &clip(e, 300));
			}
			s.updated = now_ms();
			s.clone()
		};
		self.save(id);
		self.inner.store.record(snap.status.label(), Some(id), snap.result.as_deref().or(snap.error.as_deref()).unwrap_or(&snap.now));
		self.emit(snap);
		if let Some(t) = next {
			self.run(id, t);
			return;
		}
		self.inner.runner.release(id);
		if let Some(w) = wake {
			let _ = self.inner.wakes.send(w);
		}
		self.start_next_queued();
	}

	fn start_next_queued(&self) {
		let pick = {
			let mut slots = self.inner.slots.lock();
			if slots.values().filter(|s| s.running).count() >= self.inner.cfg.max_running.max(1) {
				return;
			}
			let id = slots.values().filter(|s| s.snap.status == StarStatus::Forming && !s.running && !s.inbox.is_empty()).min_by_key(|s| s.snap.created).map(|s| s.snap.id.clone());
			id.and_then(|id| slots.get_mut(&id).map(|s| (id.clone(), s.inbox.drain(..).collect::<Vec<_>>().join("\n\n"))))
		};
		if let Some((id, text)) = pick {
			self.run(&id, text);
		}
	}

	/// Passes a message on. A busy star gets it when its current turn ends.
	pub fn tell(&self, id: &str, message: &str) -> Result<String, String> {
		let busy = {
			let mut slots = self.inner.slots.lock();
			let slot = slots.get_mut(id).ok_or_else(|| format!("there is no agent {id}"))?;
			push_log(&mut slot.snap, LogKind::You, &clip(message, 400));
			let busy = slot.running || slot.snap.status == StarStatus::Forming;
			if busy {
				slot.inbox.push_back(message.to_string());
			}
			busy
		};
		self.inner.store.record("told", Some(id), message);
		if busy {
			if let Some(s) = self.get(id) {
				self.emit(s);
			}
			return Ok(format!("Queued for {id}: it gets this as soon as its current step ends."));
		}
		self.start_or_queue(id, message.to_string());
		Ok(format!("Sent to {id}; it's working on it."))
	}

	pub fn stop(&self, id: &str) -> Result<String, String> {
		let snap = {
			let mut slots = self.inner.slots.lock();
			let slot = slots.get_mut(id).ok_or_else(|| format!("there is no agent {id}"))?;
			slot.stop_asked = true;
			slot.inbox.clear();
			match &slot.cancel {
				Some(c) => {
					c.store(true, Ordering::Relaxed);
					None
				}
				None if !slot.running => {
					slot.snap.status = StarStatus::Stopped;
					slot.snap.now = "Stopped".into();
					slot.snap.updated = now_ms();
					Some(slot.snap.clone())
				}
				None => None,
			}
		};
		if let Some(s) = snap {
			self.save(id);
			self.emit(s);
		}
		Ok(format!("Stopping {id}."))
	}

	pub fn get(&self, id: &str) -> Option<StarSnapshot> {
		self.inner.slots.lock().get(id).map(|s| s.snap.clone())
	}

	/// Oldest first.
	pub fn list(&self) -> Vec<StarSnapshot> {
		let mut v: Vec<StarSnapshot> = self.inner.slots.lock().values().map(|s| s.snap.clone()).collect();
		v.sort_by_key(|s| s.created);
		v
	}

	/// Stops everything (app quitting).
	pub fn shutdown(&self) {
		for slot in self.inner.slots.lock().values_mut() {
			if let Some(c) = &slot.cancel {
				slot.stop_asked = true;
				c.store(true, Ordering::Relaxed);
			}
		}
	}

	/// Wakes Halo once for each star that went quiet too long.
	fn watch(&self) {
		let limit = self.inner.cfg.stall_after.as_millis() as u64;
		let now = now_ms();
		let mut out = Vec::new();
		{
			let mut slots = self.inner.slots.lock();
			for slot in slots.values_mut().filter(|s| s.running) {
				let s = &mut slot.snap;
				if !s.stalled && now.saturating_sub(s.last_activity) > limit {
					s.stalled = true;
					s.updated = now;
					let minutes = now.saturating_sub(s.last_activity) / 60_000;
					out.push((s.clone(), Wake::Stalled { id: s.id.clone(), title: s.title.clone(), now: s.now.clone(), minutes: minutes.max(1) }));
				}
			}
		}
		for (snap, wake) in out {
			self.emit(snap);
			let _ = self.inner.wakes.send(wake);
		}
	}

	fn save(&self, id: &str) {
		let slots = self.inner.slots.lock();
		if let Some(slot) = slots.get(id) {
			let dir = self.inner.store.star_dir(id);
			self.inner.store.save(&dir.join("star.json"), &slot.snap);
			self.inner.store.save(&dir.join("session.json"), &*slot.session.lock());
		}
	}

	fn emit(&self, star: StarSnapshot) {
		let _ = self.inner.events.send(HaloEvent::Star { star: Box::new(star) });
	}
}

fn push_log(s: &mut StarSnapshot, kind: LogKind, text: &str) {
	s.log.push(LogEntry { ts: now_ms(), kind, text: text.to_string() });
	if s.log.len() > LOG_KEEP {
		let cut = s.log.len() - LOG_KEEP;
		s.log.drain(..cut);
	}
}

/// What the star said in its latest turn (after the last message to it).
fn final_text(session: &ChatSession) -> Option<String> {
	let mut parts = Vec::new();
	for m in session.messages.iter().rev() {
		match m {
			Msg::User { .. } => break,
			Msg::Assistant { text, .. } if !text.trim().is_empty() => parts.push(text.trim().to_string()),
			_ => {}
		}
	}
	parts.reverse();
	let t = parts.join("\n\n");
	(!t.is_empty()).then_some(t)
}

/// The question after a `NEEDS YOU:` line, if the star asked one.
pub fn needs_you(text: &str) -> Option<String> {
	let lines: Vec<&str> = text.lines().collect();
	for (i, line) in lines.iter().enumerate() {
		let l = line.trim().trim_start_matches(['*', '#', '>', '-', ' ', '_']);
		if l.get(..10).is_some_and(|h| h.eq_ignore_ascii_case("needs you:")) {
			let mut q = l[10..].trim().trim_matches(['*', '_']).trim().to_string();
			for rest in &lines[i + 1..] {
				if !rest.trim().is_empty() {
					q.push(' ');
					q.push_str(rest.trim());
				}
			}
			return (!q.is_empty()).then_some(q);
		}
	}
	None
}

/// The last thing said, as one short line.
fn now_line(text: &str) -> Option<String> {
	let l = text.lines().rev().map(|l| l.trim().trim_start_matches(['*', '#', '>', '-', ' '])).find(|l| !l.is_empty())?;
	Some(clip(l, 140))
}

fn pretty_tool(name: &str) -> String {
	let n = name.trim_start_matches("mcp__desk__").trim_start_matches("desk_");
	n.replace("__", " · ").replace('_', " ")
}

fn clip(s: &str, max: usize) -> String {
	if s.chars().count() <= max {
		return s.to_string();
	}
	format!("{}…", s.chars().take(max).collect::<String>().trim_end())
}

pub(crate) fn base36(mut n: u64) -> String {
	const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
	if n == 0 {
		return "0".into();
	}
	let mut out = Vec::new();
	while n > 0 {
		out.push(D[(n % 36) as usize]);
		n /= 36;
	}
	out.reverse();
	String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use crossbeam_channel::{Receiver, unbounded};

	use super::*;
	use crate::runner::script::{Play, ScriptRunner, says};

	fn runtime(runner: Arc<ScriptRunner>, cfg: StarConfig) -> (StarRuntime, Receiver<Wake>, Receiver<HaloEvent>, tempfile::TempDir) {
		let dir = tempfile::tempdir().unwrap();
		let store = Arc::new(Store::new(dir.path()));
		let (etx, erx) = unbounded();
		let (wtx, wrx) = unbounded();
		let tb: ToolboxFor = Arc::new(|p| Toolbox::new(p, None));
		(StarRuntime::new(runner, store, tb, cfg, etx, wtx), wrx, erx, dir)
	}

	fn quick() -> StarConfig {
		StarConfig { watch_every: Duration::from_millis(40), ..Default::default() }
	}

	const WAIT: Duration = Duration::from_secs(3);

	#[test]
	fn a_star_lands_and_wakes_halo() {
		let r = ScriptRunner::new(|_| says("Fixed: test_refresh_expired raced the clock."));
		let (rt, wakes, _e, _d) = runtime(r, quick());
		let s = rt.spawn("Flaky auth test", "Fix test_refresh_expired", None, None);
		let w = wakes.recv_timeout(WAIT).unwrap();
		assert_eq!(w, Wake::Landed { id: s.id.clone(), title: "Flaky auth test".into(), result: "Fixed: test_refresh_expired raced the clock.".into() });
		let snap = rt.get(&s.id).unwrap();
		assert_eq!(snap.status, StarStatus::Landed);
		assert!(w.render().starts_with("[AGENT DONE]"));
	}

	#[test]
	fn a_star_in_a_workspace_works_in_its_folder_and_shares_it_carefully() {
		let r = ScriptRunner::new(|_| says("done"));
		let (rt, wakes, _e, dir) = runtime(r.clone(), quick());
		let repo = dir.path().join("billing");
		std::fs::create_dir_all(&repo).unwrap();
		let w = Workspace { id: "w1".into(), name: "billing".into(), path: repo.clone(), arena: "mesa".into(), created: 0, last_used: 0 };
		let a = rt.spawn_in("Webhook fix", "fix it", None, None, Some(&w));
		let b = rt.spawn("Research", "read up", None, None);
		wakes.recv_timeout(WAIT).unwrap();
		wakes.recv_timeout(WAIT).unwrap();
		let specs = r.specs.lock().clone();
		let of = |id: &str| specs.iter().find(|s| s.slot == id).unwrap().clone();
		let (sa, sb) = (of(&a.id), of(&b.id));
		assert_eq!(sa.cwd, repo);
		assert!(sa.system.contains("same checkout") && sa.system.contains("never switch branches"), "{}", sa.system);
		assert_eq!(sb.cwd, dir.path().join("stars").join(&b.id).join("work"));
		assert!(sb.system.contains("your own folder"), "{}", sb.system);
		let snap = rt.get(&a.id).unwrap();
		assert_eq!((snap.workspace.as_deref(), snap.cwd.as_deref()), (Some("w1"), Some(repo.as_path())));
		assert_eq!(rt.get(&b.id).unwrap().workspace, None);
	}

	#[test]
	fn spawning_returns_before_the_work_is_done() {
		let r = ScriptRunner::new(|_| Play { wait: Duration::from_millis(400), events: vec![AgentEvent::TextDelta("done".into())] });
		let (rt, wakes, _e, _d) = runtime(r, quick());
		let t = Instant::now();
		let s = rt.spawn("Slow job", "take a while", None, None);
		assert!(t.elapsed() < Duration::from_millis(100), "spawn blocked for {:?}", t.elapsed());
		assert_eq!(s.status, StarStatus::Working);
		assert!(matches!(wakes.recv_timeout(WAIT).unwrap(), Wake::Landed { .. }));
	}

	#[test]
	fn a_question_becomes_needs_you_and_an_answer_resumes_it() {
		let r = ScriptRunner::new(|spec| if spec.text.contains("Yes") { says("Signed and submitted.") } else { says("Filled 11 of 12 fields.\n\n**NEEDS YOU:** Sign page 3 as the applicant?") });
		let (rt, wakes, _e, _d) = runtime(r.clone(), quick());
		let s = rt.spawn("Permit portal", "fill the permit form", None, None);
		match wakes.recv_timeout(WAIT).unwrap() {
			Wake::NeedsYou { question, .. } => assert_eq!(question, "Sign page 3 as the applicant?"),
			other => panic!("{other:?}"),
		}
		assert_eq!(rt.get(&s.id).unwrap().status, StarStatus::NeedsYou);
		rt.tell(&s.id, "Yes, sign it").unwrap();
		assert!(matches!(wakes.recv_timeout(WAIT).unwrap(), Wake::Landed { .. }));
		let snap = rt.get(&s.id).unwrap();
		assert_eq!(snap.turns, 2);
		assert!(snap.log.iter().any(|l| l.kind == LogKind::You && l.text == "Yes, sign it"));
	}

	#[test]
	fn a_message_to_a_busy_star_waits_for_its_turn_to_end() {
		let r = ScriptRunner::new(|spec| if spec.text.contains("arm64") { says("Also green on arm64: 12 runs.") } else { Play { wait: Duration::from_millis(250), events: vec![AgentEvent::TextDelta("Green on x86".into())] } });
		let (rt, wakes, _e, _d) = runtime(r.clone(), quick());
		let s = rt.spawn("Auth test", "fix the test", None, None);
		assert!(rt.tell(&s.id, "check arm64 too").unwrap().starts_with("Queued"));
		match wakes.recv_timeout(WAIT).unwrap() {
			Wake::Landed { result, .. } => assert!(result.contains("12"), "{result}"),
			other => panic!("{other:?}"),
		}
		assert_eq!(r.seen.lock().len(), 2, "one wake for both turns");
	}

	#[test]
	fn quiet_stars_are_reported_once_as_stalled() {
		let r = ScriptRunner::new(|_| Play { wait: Duration::from_millis(500), events: vec![AgentEvent::TextDelta("finally".into())] });
		let (rt, wakes, _e, _d) = runtime(r, StarConfig { stall_after: Duration::from_millis(120), ..quick() });
		let s = rt.spawn("Slow", "wait", None, None);
		assert!(matches!(wakes.recv_timeout(WAIT).unwrap(), Wake::Stalled { .. }));
		assert!(rt.get(&s.id).unwrap().stalled);
		assert!(matches!(wakes.recv_timeout(WAIT).unwrap(), Wake::Landed { .. }), "no second stall wake");
	}

	#[test]
	fn extra_stars_wait_for_a_free_slot() {
		let r = ScriptRunner::new(|_| Play { wait: Duration::from_millis(150), events: vec![AgentEvent::TextDelta("ok".into())] });
		let (rt, wakes, _e, _d) = runtime(r, StarConfig { max_running: 1, ..quick() });
		let a = rt.spawn("A", "a", None, None);
		let b = rt.spawn("B", "b", None, None);
		assert_eq!(a.status, StarStatus::Working);
		assert_eq!(b.status, StarStatus::Forming);
		let first = wakes.recv_timeout(WAIT).unwrap();
		let second = wakes.recv_timeout(WAIT).unwrap();
		assert_eq!((first.id(), second.id()), (a.id.as_str(), b.id.as_str()));
	}

	#[test]
	fn stopping_ends_the_turn_without_waking_halo() {
		let r = ScriptRunner::new(|_| Play { wait: Duration::from_secs(5), events: vec![] });
		let (rt, wakes, _e, _d) = runtime(r, quick());
		let s = rt.spawn("Long", "forever", None, None);
		std::thread::sleep(Duration::from_millis(50));
		rt.stop(&s.id).unwrap();
		std::thread::sleep(Duration::from_millis(200));
		assert_eq!(rt.get(&s.id).unwrap().status, StarStatus::Stopped);
		assert!(wakes.try_recv().is_err());
	}

	#[test]
	fn stars_survive_a_restart_as_stopped() {
		let r = ScriptRunner::new(|_| Play { wait: Duration::from_secs(5), events: vec![] });
		let dir = tempfile::tempdir().unwrap();
		let store = Arc::new(Store::new(dir.path()));
		let tb: ToolboxFor = Arc::new(|p| Toolbox::new(p, None));
		let id = {
			let (etx, _erx) = unbounded();
			let (wtx, _wrx) = unbounded();
			let rt = StarRuntime::new(r.clone(), store.clone(), tb.clone(), quick(), etx, wtx);
			rt.spawn("Mid-run", "x", None, None).id
		};
		let (etx, _erx) = unbounded();
		let (wtx, _wrx) = unbounded();
		let rt = StarRuntime::new(r, store, tb, quick(), etx, wtx);
		let s = rt.get(&id).unwrap();
		assert_eq!(s.status, StarStatus::Stopped);
		assert!(s.now.contains("Interrupted"));
	}

	#[test]
	fn needs_you_parsing() {
		assert_eq!(needs_you("Done.\nNEEDS YOU: Approve $4,200?").as_deref(), Some("Approve $4,200?"));
		assert_eq!(needs_you("- **Needs you:** which sheet?\nA-201 or A-204").as_deref(), Some("which sheet? A-201 or A-204"));
		assert_eq!(needs_you("All done, nothing needed."), None);
	}
}
