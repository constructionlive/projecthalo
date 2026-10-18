//! Transcribe any audio file macOS can decode, split at pauses.
//!
//!     cargo run -p voice-core --release --example file -- model.gguf recording.m4a

use voice_core::{Command, VoiceService};

fn main() {
	let mut args = std::env::args().skip(1);
	let (Some(model), Some(audio)) = (args.next(), args.next()) else {
		eprintln!("usage: file <model.gguf> <audio>");
		std::process::exit(2);
	};
	let service = VoiceService::spawn(|| {});
	service.send(Command::LoadModel(model.into()));
	match voice_core::files::transcribe_file(&service.sender(), std::path::Path::new(&audio)) {
		Ok(text) => println!("{text}"),
		Err(e) => {
			eprintln!("error: {e}");
			std::process::exit(1);
		}
	}
}
