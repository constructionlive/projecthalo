//! How a turn runs. [`ChannelRunner`] uses the person's own CLIs; tests use
//! a script. Each slot (Halo, or one star) keeps its own tool host, so stars
//! run side by side without sharing one.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use cc_agent::channel::{self, Access, Channel, ChannelTurn, ToolHost};
use cc_agent::{AgentEvent, ChatSession, Toolbox, TurnHandle};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// The CLI a turn runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
	Claude,
	Codex,
	Opencode,
}

impl Engine {
	pub const ALL: [Engine; 3] = [Engine::Claude, Engine::Codex, Engine::Opencode];

	pub fn channel(self) -> Channel {
		match self {
			Engine::Claude => Channel::ClaudeCode,
			Engine::Codex => Channel::Codex,
			Engine::Opencode => Channel::OpenCode,
		}
	}

	pub fn key(self) -> &'static str {
		self.channel().key()
	}

	pub fn name(self) -> &'static str {
		self.channel().name()
	}

	pub fn from_key(k: &str) -> Option<Self> {
		Self::ALL.into_iter().find(|e| e.key() == k.trim().to_lowercase())
	}
}

/// One turn to run.
pub struct TurnSpec {
	/// "halo" or a star's id: turns in the same slot never overlap.
	pub slot: String,
	pub engine: Engine,
	/// Empty = the CLI's default.
	pub model: String,
	pub session: Arc<Mutex<ChatSession>>,
	pub system: String,
	pub toolbox: Arc<Toolbox>,
	pub text: String,
	/// More for the bracketed line in front of the message (Halo's workspaces).
	pub context: String,
}

pub trait Runner: Send + Sync {
	fn start(&self, spec: TurnSpec) -> TurnHandle;

	/// The slot is done for now (a star landed): free what it holds.
	fn release(&self, _slot: &str) {}
}

/// A turn that ends at once with an error (no CLI, no tool port…).
pub fn failed_turn(message: impl Into<String>) -> TurnHandle {
	let (tx, rx) = crossbeam_channel::unbounded();
	let _ = tx.send(AgentEvent::Error(message.into()));
	let _ = tx.send(AgentEvent::Done { steps: 0 });
	TurnHandle::new(rx, Arc::new(AtomicBool::new(false)))
}

/// Runs turns on Claude Code, Codex or OpenCode, signed in as the person.
pub struct ChannelRunner {
	user: String,
	hosts: Mutex<HashMap<String, Arc<ToolHost>>>,
	exes: Mutex<HashMap<Engine, PathBuf>>,
	access: Mutex<Access>,
}

impl ChannelRunner {
	pub fn new(user: impl Into<String>) -> Self {
		Self { user: user.into(), hosts: Mutex::default(), exes: Mutex::default(), access: Mutex::default() }
	}

	/// How far every turn from now on may reach.
	pub fn set_access(&self, access: Access) {
		*self.access.lock() = access;
	}

	/// The engines whose CLI is on this computer.
	pub fn installed(&self) -> Vec<Engine> {
		Engine::ALL.into_iter().filter(|&e| self.exe(e).is_some()).collect()
	}

	fn exe(&self, engine: Engine) -> Option<PathBuf> {
		if let Some(p) = self.exes.lock().get(&engine) {
			return Some(p.clone());
		}
		let found = channel::find_exe(engine.channel())?;
		self.exes.lock().insert(engine, found.clone());
		Some(found)
	}

	fn host(&self, slot: &str) -> Result<Arc<ToolHost>, String> {
		let mut hosts = self.hosts.lock();
		if let Some(h) = hosts.get(slot) {
			return Ok(h.clone());
		}
		let h = Arc::new(ToolHost::start()?);
		hosts.insert(slot.to_string(), h.clone());
		Ok(h)
	}

	/// Tool ports open right now (one per slot with a turn since its last release).
	pub fn open_ports(&self) -> usize {
		self.hosts.lock().len()
	}
}

impl Runner for ChannelRunner {
	fn release(&self, slot: &str) {
		self.hosts.lock().remove(slot);
	}

	fn start(&self, spec: TurnSpec) -> TurnHandle {
		let Some(exe) = self.exe(spec.engine) else {
			return failed_turn(format!("{} isn't installed on this computer. Install it, or pick another engine in the Garage.", spec.engine.name()));
		};
		let host = match self.host(&spec.slot) {
			Ok(h) => h,
			Err(e) => return failed_turn(e),
		};
		let turn = ChannelTurn {
			channel: spec.engine.channel(),
			exe,
			model: spec.model,
			toolbox: spec.toolbox,
			context_line: if spec.context.is_empty() { format!("[Today {}]", crate::today()) } else { format!("[Today {} · {}]", crate::today(), spec.context) },
			user: self.user.clone(),
			system: Some(spec.system),
			access: *self.access.lock(),
		};
		channel::start_turn(&host, spec.session, turn, spec.text)
	}
}

#[cfg(test)]
pub(crate) mod script {
	//! A runner that plays back canned turns, for tests.

	use std::time::Duration;

	use cc_agent::session::Msg;

	use super::*;

	/// What a scripted turn does: optional wait, then these events, then Done.
	pub struct Play {
		pub wait: Duration,
		pub events: Vec<AgentEvent>,
	}

	type Script = dyn Fn(&TurnSpec) -> Play + Send + Sync;

	/// What one turn was started with.
	#[derive(Debug, Clone)]
	pub struct Seen {
		pub slot: String,
		pub cwd: PathBuf,
		pub system: String,
		pub context: String,
	}

	pub struct ScriptRunner {
		script: Box<Script>,
		pub seen: Mutex<Vec<(String, String)>>,
		pub specs: Mutex<Vec<Seen>>,
	}

	impl ScriptRunner {
		pub fn new(f: impl Fn(&TurnSpec) -> Play + Send + Sync + 'static) -> Arc<Self> {
			Arc::new(Self { script: Box::new(f), seen: Mutex::default(), specs: Mutex::default() })
		}
	}

	pub fn says(text: &str) -> Play {
		Play { wait: Duration::ZERO, events: vec![AgentEvent::TextDelta(text.into())] }
	}

	impl Runner for ScriptRunner {
		fn start(&self, spec: TurnSpec) -> TurnHandle {
			self.seen.lock().push((spec.slot.clone(), spec.text.clone()));
			self.specs.lock().push(Seen { slot: spec.slot.clone(), cwd: spec.toolbox.workspace.clone(), system: spec.system.clone(), context: spec.context.clone() });
			let play = (self.script)(&spec);
			let (tx, rx) = crossbeam_channel::unbounded();
			let cancel = Arc::new(AtomicBool::new(false));
			let c2 = cancel.clone();
			let session = spec.session.clone();
			let text = spec.text.clone();
			std::thread::spawn(move || {
				session.lock().messages.push(Msg::User { text, context: None });
				let step = Duration::from_millis(10);
				let mut waited = Duration::ZERO;
				while waited < play.wait && !c2.load(std::sync::atomic::Ordering::Relaxed) {
					std::thread::sleep(step);
					waited += step;
				}
				let mut said = String::new();
				for e in play.events {
					if let AgentEvent::TextDelta(d) = &e {
						said.push_str(d);
					}
					let _ = tx.send(e);
				}
				session.lock().messages.push(Msg::Assistant { text: said, reasoning: String::new(), tool_calls: vec![] });
				let _ = tx.send(AgentEvent::Done { steps: 1 });
			});
			TurnHandle::new(rx, cancel)
		}
	}
}
