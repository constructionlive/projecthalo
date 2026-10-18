//! The agent under Halo: one chat that can use a local model or the person's
//! own Claude Code / Codex / OpenCode.
//!
//! - [`toolbox`]: what the agent can do: built-in tools over the chat's files
//!   (read, write, transcribe recordings) plus the runner's own tools.
//! - [`start_turn`]: the built-in loop on any OpenAI-compatible endpoint.
//! - [`channel`]: the same turn on Claude Code, Codex or OpenCode, with the
//!   toolbox served to the CLI over MCP.

mod agent;
pub mod channel;
pub mod llm;
pub mod mcp;
pub mod prompt;
pub mod session;
pub mod toolbox;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

pub use agent::{MAX_STEPS, start_turn};
pub use session::{ChatSession, ExternalThread, Role, TranscriptEntry};
pub use toolbox::Toolbox;

/// Which model to talk to.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderConfig {
	/// OpenAI-compatible base, e.g. `http://127.0.0.1:11434/v1` (Ollama).
	pub base_url: String,
	pub api_key: Option<String>,
	pub model: String,
	pub context_tokens: u32,
}

/// What one turn works with.
pub struct AgentContext {
	pub toolbox: Arc<Toolbox>,
	pub provider: ProviderConfig,
	/// "[Today Thu 2026-10-15 · files: notes.md, standup.m4a]" — sent, not shown.
	pub context_line: String,
	/// The person's name.
	pub user: String,
}

#[derive(Debug, Clone)]
pub enum AgentEvent {
	TextDelta(String),
	ReasoningDelta(String),
	ToolStarted { call_id: String, name: String, args: serde_json::Value },
	ToolFinished { call_id: String, name: String, ok: bool, summary: String },
	Usage { prompt_tokens: u64, completion_tokens: u64 },
	Error(String),
	Done { steps: u32 },
}

pub struct TurnHandle {
	pub events: crossbeam_channel::Receiver<AgentEvent>,
	cancel: Arc<AtomicBool>,
}

impl TurnHandle {
	/// A turn driven by something else (another runner, a test script).
	pub fn new(events: crossbeam_channel::Receiver<AgentEvent>, cancel: Arc<AtomicBool>) -> Self {
		Self { events, cancel }
	}

	/// Stop after the current chunk / tool; the session stays consistent.
	pub fn cancel(&self) {
		self.cancel.store(true, Ordering::Relaxed);
	}
	/// The flag `cancel` sets, for stopping the turn from another thread.
	pub fn cancel_flag(&self) -> Arc<AtomicBool> {
		self.cancel.clone()
	}

	pub fn is_cancelled(&self) -> bool {
		self.cancel.load(Ordering::Relaxed)
	}
}

static LOCAL_THINKING: AtomicBool = AtomicBool::new(false);

/// Let local models think before each step (slow on a laptop; off by default).
pub fn set_local_thinking(enabled: bool) {
	LOCAL_THINKING.store(enabled, Ordering::Relaxed);
}

pub fn local_thinking() -> bool {
	LOCAL_THINKING.load(Ordering::Relaxed)
}

/// llama-server, LM Studio, Ollama… on this machine.
pub fn is_local_endpoint(base_url: &str) -> bool {
	let u = base_url.to_lowercase();
	u.contains("127.0.0.1") || u.contains("localhost") || u.contains("0.0.0.0") || u.contains("[::1]")
}

/// Model ids a server offers (`GET {base}/models`).
pub fn probe_models(base_url: &str, api_key: Option<&str>) -> Result<Vec<String>, String> {
	llm::models(base_url, api_key)
}

pub fn now_ms() -> u64 {
	std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
