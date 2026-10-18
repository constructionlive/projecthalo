//! Halo end to end on the person's own Claude Code: Halo lights a star through
//! its MCP tool, answers without waiting, and wakes up when the star lands.
//!
//! ```sh
//! cargo build -p halo-app   # the bridge the CLI starts
//! CC_BRIDGE_EXE=target/debug/halo cargo run -p halo-core --example live -- [model]
//! ```

use std::sync::Arc;
use std::time::{Duration, Instant};

use cc_agent::Toolbox;
use halo_core::stars::{StarConfig, ToolboxFor};
use halo_core::{ChannelRunner, Engine, Halo, HaloConfig, HaloEvent, LineRole, Store};

fn main() {
	let model = std::env::args().nth(1).unwrap_or_else(|| "haiku".into());
	let root = std::env::temp_dir().join(format!("halo-live-{}", std::process::id()));
	println!("store: {}", root.display());
	let tb: ToolboxFor = Arc::new(|p| Toolbox::new(p, None));
	let (tx, rx) = crossbeam_channel::unbounded();
	let cfg = HaloConfig { engine: Engine::Claude, model: model.clone(), user: String::new(), stars: StarConfig { model, ..Default::default() }, terminals: Default::default(), kit: None, exe: None };
	let halo = Halo::start(cfg, Arc::new(ChannelRunner::new("")), Arc::new(Store::new(&root)), tb, tx);

	let t0 = Instant::now();
	halo.ask("Light one star titled \"Smoke test\". Its goal: write a file named hello.txt containing the word hi in its folder, then reply with the file's name. Don't do it yourself.");
	let mut turns = 0;
	while t0.elapsed() < Duration::from_secs(300) {
		let Ok(ev) = rx.recv_timeout(Duration::from_secs(1)) else { continue };
		let at = format!("{:>5.1}s", t0.elapsed().as_secs_f32());
		match ev {
			HaloEvent::TurnStarted { reason, .. } => println!("{at} halo turn ({reason:?})"),
			HaloEvent::Tool { name, done: false, .. } => println!("{at}   tool {name}"),
			HaloEvent::Error { message } => println!("{at}   ERROR {message}"),
			HaloEvent::Star { star } => println!("{at}   star {} {:?}: {}", star.id, star.status, star.now),
			HaloEvent::TurnDone => {
				turns += 1;
				let last = halo.state().lines.iter().rev().find(|l| l.role == LineRole::Halo).map(|l| l.text.clone()).unwrap_or_default();
				println!("{at} halo said: {last}");
				if turns == 2 {
					break;
				}
			}
			_ => {}
		}
	}
	let st = halo.state();
	let roles: Vec<LineRole> = st.lines.iter().map(|l| l.role).collect();
	println!("\nthread: {roles:?}");
	for s in &st.stars {
		let file = root.join("stars").join(&s.id).join("work/hello.txt");
		println!("star {} {:?} · hello.txt: {:?}", s.id, s.status, std::fs::read_to_string(&file).ok());
	}
	halo.shutdown();
}
