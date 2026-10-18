//! One real chat turn on a subscription CLI.
//!
//!     CC_BRIDGE_EXE=target/debug/halo cargo run -p cc-agent --example turn -- claude "question"

use std::sync::Arc;

use cc_agent::channel::{self, Channel, ChannelTurn, ToolHost};
use cc_agent::{AgentEvent, ChatSession, Toolbox};
use parking_lot::Mutex;

fn main() {
	let mut args = std::env::args().skip(1);
	let ch = Channel::from_key(&args.next().expect("channel")).expect("claude | codex | opencode");
	let question = args.next().expect("question");
	let dir = std::env::temp_dir().join(format!("cc-turn-{}", cc_agent::now_ms()));
	let toolbox = Arc::new(Toolbox::new(dir, None));
	let host = ToolHost::start().expect("host");
	let exe = channel::find_exe(ch).expect("CLI installed");
	let session = Arc::new(Mutex::new(ChatSession::new()));
	let turn = ChannelTurn { channel: ch, exe, model: String::new(), toolbox, context_line: "[Today Thu 2026-10-15 · 0 file(s) in this chat]".into(), user: String::new(), system: None, access: Default::default() };
	let handle = channel::start_turn(&host, session, turn, question);
	for ev in handle.events.iter() {
		match ev {
			AgentEvent::TextDelta(t) => print!("{t}"),
			AgentEvent::ToolStarted { name, .. } => println!("\n→ {name}"),
			AgentEvent::ToolFinished { name, ok, summary, .. } => println!("  {} {name}: {summary}", if ok { "✓" } else { "✗" }),
			AgentEvent::Error(e) => println!("\nERROR: {e}"),
			AgentEvent::Done { steps } => {
				println!("\n[done, {steps} steps]");
				break;
			}
			_ => {}
		}
	}
}
