//! Split a 16 kHz mono WAV into utterances with the VAD, transcribing each.
//!
//!     cargo run -p voice-core --release --example segment -- model.gguf audio.wav

use voice_core::engine::{SttEngine, TranscribeCppEngine};
use voice_core::segmenter::{Segmenter, SegmenterConfig};

fn main() {
	let mut args = std::env::args().skip(1);
	let (Some(model), Some(wav)) = (args.next(), args.next()) else {
		eprintln!("usage: segment <model.gguf> <audio.wav>");
		std::process::exit(2);
	};
	let mut reader = hound::WavReader::open(&wav).expect("open wav");
	assert_eq!(reader.spec().sample_rate, 16_000, "need 16 kHz mono");
	let mut pcm: Vec<f32> = reader.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect();
	pcm.extend(std::iter::repeat_n(0.0, 16_000)); // trailing silence ends the last utterance

	let mut engine = TranscribeCppEngine::load(&model).expect("load model");
	let mut segmenter = Segmenter::new(SegmenterConfig::default());
	let mut utterances = Vec::new();
	// Feed in 10 ms chunks, the way the microphone delivers audio.
	for chunk in pcm.chunks(160) {
		segmenter.push(chunk, |u| utterances.push(u));
	}
	utterances.extend(segmenter.flush());
	for (i, u) in utterances.iter().enumerate() {
		let t = engine.transcribe(u).expect("transcribe");
		println!("#{} {:.2}s: {}", i + 1, u.len() as f32 / 16_000.0, t.text);
	}
}
