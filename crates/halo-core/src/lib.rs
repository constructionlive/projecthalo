//! Halo's engine.
//!
//! - [`Halo`]: the one thread the person talks to. It answers quickly, hands
//!   long work to stars, and is never blocked by them: each star's outcome
//!   comes back as a message that wakes it ([`Wake`]).
//! - [`stars`]: background agents, each its own Claude Code / Codex / OpenCode
//!   session in its own folder, with a status, a live log, a heartbeat and an
//!   inbox for the person's replies.
//! - [`tools`]: what Halo can do with stars (`spawn_star`, `peek_star`…),
//!   served to its CLI over MCP like any other tool.
//! - [`runner`]: how a turn runs: on the person's CLIs, or scripted in tests.
//! - [`store`]: everything on disk, including the append-only event log.
//! - [`workspaces`]: the person's folders; stars lit in one run there.
//! - [`themes`]: themes the person makes, built against the shipped kit.
//! - [`terminals`]: the person's shells, and what each is doing.

mod halo;
pub mod prompt;
pub mod runner;
pub mod stars;
pub mod store;
pub mod terminals;
pub mod themes;
pub mod tools;
pub mod workspaces;

use serde::Serialize;

pub use halo::{Halo, HaloConfig, HaloState, Line, LineRole};
pub use runner::{ChannelRunner, Engine, Runner, TurnSpec};
pub use stars::{LogEntry, LogKind, StarRuntime, StarSnapshot, StarStatus, Wake};
pub use store::Store;
pub use terminals::{TermSnapshot, TermStatus, Terminals};
pub use themes::{ThemeInfo, Themes};
pub use workspaces::{Workspace, WorkspaceInfo, Workspaces};

/// Everything the UI hears about, in order.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HaloEvent {
	/// Halo started a turn: for something the person said, or because stars reported.
	#[serde(rename_all = "camelCase")]
	TurnStarted {
		reason: LineRole,
		text: String,
	},
	/// Halo's reply, as it streams.
	Text {
		delta: String,
	},
	/// Halo used a tool (`done` false when it starts, true when it finishes).
	#[serde(rename_all = "camelCase")]
	Tool {
		call_id: String,
		name: String,
		done: bool,
		ok: bool,
		summary: String,
	},
	TurnDone,
	Error {
		message: String,
	},
	/// A star changed (status, progress, log).
	Star {
		star: Box<StarSnapshot>,
	},
	/// A terminal changed: a command started or ended, it moved, a port opened.
	Terminal {
		terminal: Box<TermSnapshot>,
	},
	#[serde(rename_all = "camelCase")]
	TerminalClosed {
		id: String,
	},
	/// A theme was made or rebuilt (its version, or its build errors).
	Theme {
		theme: Box<ThemeInfo>,
	},
	ThemeRemoved {
		id: String,
	},
	/// Workspaces were opened or closed, or another came to the front.
	Workspaces {
		workspaces: Vec<WorkspaceInfo>,
		current: Option<String>,
	},
}

/// Milliseconds since the epoch.
pub fn now_ms() -> u64 {
	cc_agent::now_ms()
}

/// "Fri 2026-10-17" for the context line in front of each message.
pub fn today() -> String {
	let days = (now_ms() / 86_400_000) as i64;
	// Howard Hinnant's civil-from-days.
	let z = days + 719_468;
	let era = z.div_euclid(146_097);
	let doe = z - era * 146_097;
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = if mp < 10 { mp + 3 } else { mp - 9 };
	let y = yoe + era * 400 + i64::from(m <= 2);
	let weekday = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"][days.rem_euclid(7) as usize];
	format!("{weekday} {y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
	#[test]
	fn today_has_a_weekday_and_a_date() {
		let t = super::today();
		assert_eq!(t.len(), 14, "{t}");
		assert!(t.as_bytes()[3] == b' ' && t.as_bytes()[8] == b'-', "{t}");
	}
}
