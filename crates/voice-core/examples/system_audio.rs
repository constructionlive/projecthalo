//! Transcribe what the Mac plays for N seconds, tagged as the AI speaker.
//!
//!     cargo run -p voice-core --release --example system_audio -- model.gguf [seconds]
//!
//! Needs Screen & System Audio Recording permission for the terminal.

use std::time::{Duration, Instant};

use voice_core::{Command, EchoGate, SystemAudioCapture, VoiceEvent, VoiceService};

fn main() {
	let mut args = std::env::args().skip(1);
	let Some(model) = args.next() else {
		eprintln!("usage: system_audio <model.gguf> [seconds]");
		std::process::exit(2);
	};
	let seconds: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(15);

	let service = VoiceService::spawn(|| {});
	service.send(Command::LoadModel(model.into()));
	let mut capture = SystemAudioCapture::new(service.sender(), EchoGate::default());
	if let Err(e) = capture.start() {
		eprintln!("{e}");
		std::process::exit(1);
	}
	println!("listening to system audio for {seconds}s…");

	let deadline = Instant::now() + Duration::from_secs(seconds);
	let mut stopped = false;
	loop {
		if !stopped && Instant::now() >= deadline {
			capture.stop().ok();
			stopped = true;
		}
		match service.events().recv_timeout(Duration::from_millis(200)) {
			Ok(VoiceEvent::Transcribed { utterance, elapsed_ms, .. }) if !utterance.text.is_empty() => {
				println!("{}: {}  ({} ms audio, {elapsed_ms} ms)", utterance.speaker.label(), utterance.text, utterance.audio_ms)
			}
			Ok(VoiceEvent::ModelFailed(e) | VoiceEvent::Error(e)) => eprintln!("error: {e}"),
			Ok(_) => {}
			Err(_) if stopped => break,
			Err(_) => {}
		}
	}
}
