//! The one thread the person talks to. It runs one turn at a time, for what
//! the person says or for what stars report, and stars never hold it up.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use cc_agent::{AgentEvent, ChatSession, Toolbox};
use crossbeam_channel::{Receiver, Sender, unbounded};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::runner::{Engine, Runner, TurnSpec};
use crate::stars::{StarConfig, StarRuntime, StarSnapshot, ToolboxFor, Wake};
use crate::store::Store;
use crate::terminals::{TermConfig, TermSnapshot, Terminals};
use crate::themes::{ThemeInfo, Themes};
use crate::tools::HaloTools;
use crate::workspaces::{WorkspaceInfo, Workspaces};
use crate::{HaloEvent, now_ms, prompt};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineRole {
	You,
	Halo,
	/// A star reporting back.
	Wake,
}

/// One line of the conversation as the person sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Line {
	pub role: LineRole,
	pub text: String,
	pub ts: u64,
}

pub struct HaloConfig {
	pub engine: Engine,
	pub model: String,
	/// The person's name.
	pub user: String,
	pub stars: StarConfig,
	pub terminals: TermConfig,
	/// The theme kit (None: themes can't be built in this copy).
	pub kit: Option<std::path::PathBuf>,
	/// This program, which a theme's agent runs to build it (`--theme-build`).
	pub exe: Option<std::path::PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HaloState {
	pub busy: bool,
	pub engine: Engine,
	pub lines: Vec<Line>,
	pub stars: Vec<StarSnapshot>,
	pub workspaces: Vec<WorkspaceInfo>,
	/// The workspace in front of the person.
	pub current: Option<String>,
	pub terminals: Vec<TermSnapshot>,
	pub themes: Vec<ThemeInfo>,
}

enum Input {
	You(String),
	Wake(Wake),
}

const LINES_KEEP: usize = 400;
const WORKSPACE_WATCH: Duration = Duration::from_secs(4);

struct Inner {
	stars: StarRuntime,
	workspaces: Arc<Workspaces>,
	terminals: Terminals,
	themes: Arc<Themes>,
	exe: Option<std::path::PathBuf>,
	store: Arc<Store>,
	events: Sender<HaloEvent>,
	lines: Mutex<Vec<Line>>,
	busy: AtomicBool,
	inputs: Sender<Input>,
	cancel: Mutex<Option<Arc<AtomicBool>>>,
	engine: Mutex<(Engine, String)>,
}

#[derive(Clone)]
pub struct Halo {
	inner: Arc<Inner>,
}

impl Halo {
	pub fn start(cfg: HaloConfig, runner: Arc<dyn Runner>, store: Arc<Store>, toolbox_for: ToolboxFor, events: Sender<HaloEvent>) -> Self {
		let (wake_tx, wake_rx) = unbounded::<Wake>();
		let (in_tx, in_rx) = unbounded::<Input>();
		let stars = StarRuntime::new(runner.clone(), store.clone(), toolbox_for.clone(), cfg.stars, events.clone(), wake_tx);
		let fwd = in_tx.clone();
		let _ = std::thread::Builder::new().name("halo-wakes".into()).spawn(move || {
			for w in wake_rx {
				if fwd.send(Input::Wake(w)).is_err() {
					break;
				}
			}
		});
		let dir = store.halo_dir();
		let lines: Vec<Line> = store.load(&dir.join("transcript.json")).unwrap_or_default();
		let session: ChatSession = store.load(&dir.join("session.json")).unwrap_or_default();
		let workspaces = Arc::new(Workspaces::load(store.clone()));
		let terminals = Terminals::new(store.root().join("shell"), cfg.terminals, events.clone());
		let themes = Themes::new(store.root().join("themes"), cfg.kit, events.clone());
		let exe = cfg.exe;
		let toolbox: Toolbox = toolbox_for(dir.join("work")).with_tools(Arc::new(HaloTools { stars: stars.clone(), workspaces: workspaces.clone(), terminals: terminals.clone() }));
		let halo = Self {
			inner: Arc::new(Inner {
				stars,
				workspaces,
				terminals,
				themes,
				exe,
				store,
				events: events.clone(),
				lines: Mutex::new(lines),
				busy: AtomicBool::new(false),
				inputs: in_tx,
				cancel: Mutex::default(),
				engine: Mutex::new((cfg.engine, cfg.model)),
			}),
		};
		halo.watch_workspaces();
		let me = halo.clone();
		let system = prompt::halo(&cfg.user);
		let _ = std::thread::Builder::new().name("halo-main".into()).spawn(move || me.main_loop(in_rx, runner, Arc::new(Mutex::new(session)), Arc::new(toolbox), system, events));
		halo
	}

	fn main_loop(&self, inputs: Receiver<Input>, runner: Arc<dyn Runner>, session: Arc<Mutex<ChatSession>>, toolbox: Arc<Toolbox>, system: String, events: Sender<HaloEvent>) {
		while let Ok(first) = inputs.recv() {
			// Stars that land together wake Halo once.
			std::thread::sleep(Duration::from_millis(60));
			let mut batch = vec![first];
			batch.extend(inputs.try_iter());
			let (reason, text) = self.compose(batch);
			self.inner.busy.store(true, Ordering::Relaxed);
			let _ = events.send(HaloEvent::TurnStarted { reason, text: text.clone() });
			let (engine, model) = self.inner.engine.lock().clone();
			let context = [self.inner.workspaces.context(), self.inner.terminals.context()].into_iter().filter(|c| !c.is_empty()).collect::<Vec<_>>().join(" · ");
			let handle = runner.start(TurnSpec { slot: "halo".into(), engine, model, session: session.clone(), system: system.clone(), toolbox: toolbox.clone(), text, context });
			*self.inner.cancel.lock() = Some(handle.cancel_flag());
			let mut said = String::new();
			for ev in handle.events.iter() {
				match ev {
					AgentEvent::TextDelta(d) => {
						said.push_str(&d);
						let _ = events.send(HaloEvent::Text { delta: d });
					}
					AgentEvent::ToolStarted { call_id, name, .. } => {
						if !said.trim().is_empty() && !said.ends_with("\n\n") {
							said.push_str("\n\n");
							let _ = events.send(HaloEvent::Text { delta: "\n\n".into() });
						}
						let _ = events.send(HaloEvent::Tool { call_id, name, done: false, ok: true, summary: String::new() });
					}
					AgentEvent::ToolFinished { call_id, name, ok, summary } => {
						let _ = events.send(HaloEvent::Tool { call_id, name, done: true, ok, summary });
					}
					AgentEvent::Error(message) => {
						let _ = events.send(HaloEvent::Error { message });
					}
					AgentEvent::Done { .. } => break,
					AgentEvent::ReasoningDelta(_) | AgentEvent::Usage { .. } => {}
				}
			}
			*self.inner.cancel.lock() = None;
			let said = said.trim().to_string();
			if !said.is_empty() {
				self.push(LineRole::Halo, &said);
				self.inner.store.record("halo", None, &said);
			}
			self.inner.store.save(&self.inner.store.halo_dir().join("session.json"), &*session.lock());
			self.inner.busy.store(false, Ordering::Relaxed);
			let _ = events.send(HaloEvent::TurnDone);
		}
	}

	/// One message for a batch of inputs: star reports first, then the person.
	fn compose(&self, batch: Vec<Input>) -> (LineRole, String) {
		let mut wakes = Vec::new();
		let mut said = Vec::new();
		for i in batch {
			match i {
				Input::Wake(w) => {
					let text = w.render();
					self.push(LineRole::Wake, &text);
					wakes.push(text);
				}
				Input::You(t) => said.push(t),
			}
		}
		let reason = if said.is_empty() { LineRole::Wake } else { LineRole::You };
		let mut parts = wakes;
		parts.extend(said);
		(reason, parts.join("\n\n"))
	}

	fn push(&self, role: LineRole, text: &str) {
		let mut lines = self.inner.lines.lock();
		lines.push(Line { role, text: text.to_string(), ts: now_ms() });
		if lines.len() > LINES_KEEP {
			let cut = lines.len() - LINES_KEEP;
			lines.drain(..cut);
		}
		self.inner.store.save(&self.inner.store.halo_dir().join("transcript.json"), &*lines);
	}

	/// The person said something. Returns at once; the reply streams as events.
	pub fn ask(&self, text: &str) {
		let text = text.trim();
		if text.is_empty() {
			return;
		}
		self.push(LineRole::You, text);
		self.inner.store.record("you", None, text);
		let _ = self.inner.inputs.send(Input::You(text.to_string()));
	}

	pub fn stars(&self) -> &StarRuntime {
		&self.inner.stars
	}

	pub fn state(&self) -> HaloState {
		HaloState {
			busy: self.inner.busy.load(Ordering::Relaxed),
			engine: self.inner.engine.lock().0,
			lines: self.inner.lines.lock().clone(),
			stars: self.inner.stars.list(),
			workspaces: self.inner.workspaces.infos(),
			current: self.inner.workspaces.current_id(),
			terminals: self.inner.terminals.list(),
			themes: self.inner.themes.list(),
		}
	}

	pub fn themes(&self) -> &Arc<Themes> {
		&self.inner.themes
	}

	/// An agent that changes a theme as the person asks, in the theme's folder;
	/// the theme rebuilds (and the window reloads it) as the agent saves.
	pub fn customize_theme(&self, id: &str, request: &str, engine: Option<Engine>, model: Option<String>) -> Result<StarSnapshot, String> {
		let info = self.inner.themes.info(id).ok_or_else(|| format!("there is no theme {id}"))?;
		let exe = self.inner.exe.clone().or_else(|| std::env::current_exe().ok()).ok_or("can't find Halo's own program")?;
		let goal = self.inner.themes.agent_goal(id, request.trim(), &exe)?;
		// The theme's folder as its workspace (a theme's, so no arena shows it).
		let place = crate::workspaces::Workspace { id: format!("theme:{id}"), name: info.manifest.name.clone(), path: info.dir.clone(), arena: "bay".into(), created: now_ms(), last_used: now_ms() };
		let title: String = request.trim().chars().take(60).collect();
		Ok(self.inner.stars.spawn_in(&format!("{}: {title}", info.manifest.name), &goal, engine, model, Some(&place)))
	}

	pub fn terminals(&self) -> &Terminals {
		&self.inner.terminals
	}

	pub fn workspaces(&self) -> &Arc<Workspaces> {
		&self.inner.workspaces
	}

	/// Opens a folder as a workspace and brings it to the front.
	pub fn open_workspace(&self, path: &std::path::Path) -> Result<WorkspaceInfo, String> {
		let w = self.inner.workspaces.add(path)?;
		self.inner.workspaces.set_current(Some(&w.id))?;
		self.emit_workspaces();
		Ok(crate::workspaces::info(w))
	}

	pub fn close_workspace(&self, id: &str) -> Result<(), String> {
		self.inner.workspaces.remove(id)?;
		self.emit_workspaces();
		Ok(())
	}

	pub fn front_workspace(&self, id: Option<&str>) -> Result<(), String> {
		self.inner.workspaces.set_current(id)?;
		self.emit_workspaces();
		Ok(())
	}

	/// Keeps the UI's branches and change counts current, whoever changes the
	/// repositories (stars, the person, a terminal): looks every few seconds and
	/// speaks only when something differs.
	fn watch_workspaces(&self) {
		let weak = Arc::downgrade(&self.inner);
		let _ = std::thread::Builder::new().name("halo-workspaces".into()).spawn(move || {
			let mut last = None;
			loop {
				std::thread::sleep(WORKSPACE_WATCH);
				let Some(inner) = weak.upgrade() else { break };
				let now = (inner.workspaces.infos(), inner.workspaces.current_id());
				if last.as_ref() != Some(&now) {
					if last.is_some() {
						let _ = inner.events.send(HaloEvent::Workspaces { workspaces: now.0.clone(), current: now.1.clone() });
					}
					last = Some(now);
				}
			}
		});
	}

	/// Tells the UI (fresh git state too: call it when something may have changed).
	pub fn emit_workspaces(&self) {
		let ws = &self.inner.workspaces;
		let _ = self.inner.events.send(HaloEvent::Workspaces { workspaces: ws.infos(), current: ws.current_id() });
	}

	/// Which CLI Halo and the stars it lights from now on run on (lit ones keep theirs).
	pub fn set_engine(&self, engine: Engine, model: String) {
		self.inner.stars.set_engine(engine, model.clone());
		*self.inner.engine.lock() = (engine, model);
	}

	/// Stops Halo's current turn (stars keep going).
	pub fn cancel(&self) {
		if let Some(c) = &*self.inner.cancel.lock() {
			c.store(true, Ordering::Relaxed);
		}
	}

	pub fn shutdown(&self) {
		self.cancel();
		self.inner.stars.shutdown();
		self.inner.terminals.shutdown();
	}
}

#[cfg(test)]
mod tests {
	use std::time::Instant;

	use super::*;
	use crate::runner::script::{Play, ScriptRunner, says};

	fn start(runner: Arc<ScriptRunner>) -> (Halo, Receiver<HaloEvent>, tempfile::TempDir) {
		let dir = tempfile::tempdir().unwrap();
		let (tx, rx) = unbounded();
		let tb: ToolboxFor = Arc::new(|p| Toolbox::new(p, None));
		let cfg = HaloConfig {
			engine: Engine::Claude,
			model: String::new(),
			user: "Sam".into(),
			stars: StarConfig { watch_every: Duration::from_millis(40), ..Default::default() },
			terminals: TermConfig { user_config: false, ..Default::default() },
			kit: None,
			exe: None,
		};
		(Halo::start(cfg, runner, Arc::new(Store::new(dir.path())), tb, tx), rx, dir)
	}

	fn wait_until(what: &str, f: impl Fn() -> bool) {
		let t = Instant::now();
		while !f() {
			assert!(t.elapsed() < Duration::from_secs(4), "timed out waiting for {what}");
			std::thread::sleep(Duration::from_millis(10));
		}
	}

	#[test]
	fn halo_answers_then_wakes_when_a_star_lands() {
		let r = ScriptRunner::new(|spec| match spec.slot.as_str() {
			"halo" if spec.text.contains("[AGENT DONE]") => says("The flaky test is fixed."),
			"halo" => says("On it, I lit a star for the test."),
			_ => Play { wait: Duration::from_millis(150), events: vec![AgentEvent::TextDelta("Fixed: a clock race.".into())] },
		});
		let (halo, _rx, _d) = start(r.clone());
		halo.ask("Fix the flaky auth test");
		halo.stars().spawn("Flaky auth test", "Fix test_refresh_expired", None, None);
		wait_until("the wake turn", || halo.state().lines.iter().any(|l| l.role == LineRole::Halo && l.text.contains("flaky test is fixed")));
		let roles: Vec<LineRole> = halo.state().lines.iter().map(|l| l.role).collect();
		assert_eq!(roles, vec![LineRole::You, LineRole::Halo, LineRole::Wake, LineRole::Halo]);
	}

	#[test]
	fn halo_sees_the_workspaces_and_lights_stars_in_the_one_in_front() {
		use cc_agent::toolbox::ToolProvider;
		let r = ScriptRunner::new(|_| says("ok"));
		let (halo, rx, dir) = start(r.clone());
		let (a, b) = (dir.path().join("billing"), dir.path().join("web"));
		std::fs::create_dir_all(&a).unwrap();
		std::fs::create_dir_all(&b).unwrap();
		let wa = halo.open_workspace(&a).unwrap();
		halo.open_workspace(&b).unwrap();
		assert!(rx.try_iter().any(|e| matches!(e, HaloEvent::Workspaces { ref workspaces, .. } if workspaces.len() == 2)));
		let st = halo.state();
		assert_eq!(st.workspaces.len(), 2);
		assert_eq!(st.current.as_deref(), Some(st.workspaces[1].workspace.id.as_str()), "the newest is in front");

		halo.ask("hi");
		wait_until("Halo's turn", || r.specs.lock().iter().any(|s| s.slot == "halo"));
		let ctx = r.specs.lock().iter().find(|s| s.slot == "halo").unwrap().context.clone();
		assert!(ctx.contains("billing (") && ctx.contains("web (") && ctx.contains("in front of the person"), "{ctx}");

		let tools = HaloTools { stars: halo.stars().clone(), workspaces: halo.workspaces().clone(), terminals: halo.terminals().clone() };
		let spawn = |extra: serde_json::Value| {
			let mut args = serde_json::json!({ "title": "t", "goal": "g" });
			args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
			tools.call("launch_agent", &args).unwrap()
		};
		let id_of = |msg: &str| msg.split_whitespace().nth(2).unwrap().to_string();
		let front = id_of(&spawn(serde_json::json!({})).unwrap());
		let named = id_of(&spawn(serde_json::json!({ "workspace": "Billing" })).unwrap());
		let none = id_of(&spawn(serde_json::json!({ "workspace": "none" })).unwrap());
		let cwd = |id: &str| halo.stars().get(id).unwrap().cwd;
		assert_eq!(cwd(&front), Some(std::fs::canonicalize(&b).unwrap()));
		assert_eq!(cwd(&named), Some(wa.workspace.path.clone()));
		assert_eq!(cwd(&none), None);
		let err = spawn(serde_json::json!({ "workspace": "infra" })).unwrap_err();
		assert!(err.contains("no workspace infra") && err.contains("billing"), "{err}");
	}

	#[test]
	fn halo_reads_the_persons_terminals() {
		use cc_agent::toolbox::ToolProvider;
		let r = ScriptRunner::new(|_| says("ok"));
		let (halo, _rx, _d) = start(r.clone());
		let t = halo.terminals().open(None, 80, 24).unwrap();
		std::thread::sleep(Duration::from_millis(600));
		halo.terminals().write(&t.id, b"echo build-broke-here; false\n").unwrap();
		wait_until("the command to end", || halo.terminals().get(&t.id).unwrap().last.is_some());
		let tools = HaloTools { stars: halo.stars().clone(), workspaces: halo.workspaces().clone(), terminals: halo.terminals().clone() };
		let list = tools.call("list_terminals", &serde_json::json!({})).unwrap().unwrap();
		assert!(list.contains(&t.id) && list.contains("exited 1"), "{list}");
		let out = tools.call("read_terminal", &serde_json::json!({ "id": t.id, "lines": 20 })).unwrap().unwrap();
		assert!(out.contains("build-broke-here") && !out.contains('\x1b'), "{out}");
		halo.ask("why did it fail?");
		wait_until("Halo's turn", || r.specs.lock().iter().any(|s| s.slot == "halo"));
		let ctx = r.specs.lock().iter().find(|s| s.slot == "halo").unwrap().context.clone();
		assert!(ctx.contains("terminals:") && ctx.contains("exited 1"), "{ctx}");
		halo.shutdown();
		assert!(halo.terminals().list().is_empty(), "quitting closes the shells");
	}

	#[test]
	fn stars_landing_together_wake_halo_once() {
		let r = ScriptRunner::new(|spec| if spec.slot == "halo" { says("Both are done.") } else { says("done") });
		let (halo, _rx, _d) = start(r.clone());
		halo.stars().spawn("A", "a", None, None);
		halo.stars().spawn("B", "b", None, None);
		wait_until("the wake turn", || halo.state().lines.iter().any(|l| l.role == LineRole::Halo));
		std::thread::sleep(Duration::from_millis(150));
		let halo_turns: Vec<String> = r.seen.lock().iter().filter(|(slot, _)| slot == "halo").map(|(_, t)| t.clone()).collect();
		assert_eq!(halo_turns.len(), 1, "{halo_turns:?}");
		assert_eq!(halo_turns[0].matches("[AGENT DONE]").count(), 2);
	}

	#[test]
	fn halo_tools_launch_and_list_agents() {
		use cc_agent::toolbox::ToolProvider;
		let r = ScriptRunner::new(|_| Play { wait: Duration::from_millis(300), events: vec![] });
		let (halo, _rx, _d) = start(r);
		let tools = HaloTools { stars: halo.stars().clone(), workspaces: halo.workspaces().clone(), terminals: halo.terminals().clone() };
		let t = Instant::now();
		let out = tools.call("launch_agent", &serde_json::json!({ "title": "Release notes", "goal": "Draft notes for v0.4" })).unwrap().unwrap();
		assert!(t.elapsed() < Duration::from_millis(100));
		assert!(out.starts_with("Launched agent s"), "{out}");
		let list = tools.call("list_agents", &serde_json::json!({})).unwrap().unwrap();
		assert!(list.contains("Release notes") && list.contains("working"), "{list}");
		assert!(tools.call("peek_agent", &serde_json::json!({ "id": "nope" })).unwrap().is_err());
		assert!(tools.call("not_mine", &serde_json::json!({})).is_none());
	}
}
