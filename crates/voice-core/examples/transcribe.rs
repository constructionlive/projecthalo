//! Transcribe a 16 kHz mono WAV with any GGUF model, through the same
//! VoiceService path the app uses.
//!
//!     cargo run -p voice-core --release --example transcribe -- model.gguf audio.wav

use std::time::Duration;

use voice_core::{Command, Purpose, Speaker, VoiceEvent, VoiceService};

fn main() {
	let mut args = std::env::args().skip(1);
	let (Some(model), Some(wav)) = (args.next(), args.next()) else {
		eprintln!("usage: transcribe <model.gguf> <audio.wav>");
		std::process::exit(2);
	};

	let mut reader = hound::WavReader::open(&wav).expect("open wav");
	let spec = reader.spec();
	assert_eq!(spec.sample_rate, 16_000, "need 16 kHz audio");
	assert_eq!(spec.channels, 1, "need mono audio");
	let pcm: Vec<f32> = match spec.sample_format {
		hound::SampleFormat::Int => reader.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect(),
		hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap()).collect(),
	};

	let service = VoiceService::spawn(|| {});
	service.send(Command::LoadModel(model.into()));
	service.send(Command::Transcribe { speaker: Speaker::User, at_ms: 0, pcm, purpose: Purpose::Dictation });

	while let Ok(event) = service.events().recv_timeout(Duration::from_secs(120)) {
		match event {
			VoiceEvent::ModelReady { description } => println!("model: {description}"),
			VoiceEvent::Transcribed { utterance, elapsed_ms, .. } => {
				println!("{} ms audio in {elapsed_ms} ms\n{}", utterance.audio_ms, utterance.text);
				break;
			}
			VoiceEvent::ModelFailed(e) | VoiceEvent::Error(e) => {
				eprintln!("error: {e}");
				std::process::exit(1);
			}
			_ => {}
		}
	}
}
