//! Transcribing recordings: any audio file macOS can read (m4a, mp3, wav,
//! aiff, caf…), decoded to 16 kHz mono, split at pauses and transcribed
//! piece by piece so hour-long meetings fit the model.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use crossbeam_channel::{Sender, bounded};

use crate::SAMPLE_RATE;
use crate::segmenter::{Segmenter, SegmenterConfig};
use crate::service::Command as VoiceCommand;
use crate::{Error, Result};

/// Decodes `path` to 16 kHz mono f32. Uses macOS's `afconvert` for anything
/// that isn't already a 16 kHz mono WAV.
pub fn load_audio(path: &Path) -> Result<Vec<f32>> {
	if let Ok(pcm) = read_wav_16k_mono(path) {
		return Ok(pcm);
	}
	let tmp = std::env::temp_dir().join(format!("voice-core-{}-{}.wav", std::process::id(), crate::conversation::now_ms()));
	let out = Command::new("afconvert").arg("-f").arg("WAVE").arg("-d").arg(format!("LEI16@{SAMPLE_RATE}")).arg("-c").arg("1").arg(path).arg(&tmp).output().map_err(|e| Error::Other(format!("couldn't run afconvert: {e}")))?;
	if !out.status.success() {
		let _ = std::fs::remove_file(&tmp);
		return Err(Error::Other(format!("couldn't decode {}: {}", path.display(), String::from_utf8_lossy(&out.stderr).trim())));
	}
	let pcm = read_wav_16k_mono(&tmp);
	let _ = std::fs::remove_file(&tmp);
	pcm
}

fn read_wav_16k_mono(path: &Path) -> Result<Vec<f32>> {
	let mut reader = hound::WavReader::open(path).map_err(|e| Error::Other(e.to_string()))?;
	let spec = reader.spec();
	if spec.sample_rate != SAMPLE_RATE || spec.channels != 1 {
		return Err(Error::Other("not 16 kHz mono".into()));
	}
	let pcm: std::result::Result<Vec<f32>, _> = match spec.sample_format {
		hound::SampleFormat::Int => reader.samples::<i16>().map(|s| s.map(|s| s as f32 / 32768.0)).collect(),
		hound::SampleFormat::Float => reader.samples::<f32>().collect(),
	};
	pcm.map_err(|e| Error::Other(e.to_string()))
}

/// Transcribes a recording through a running [`VoiceService`](crate::VoiceService).
/// Returns the text with a blank line between pieces spoken apart.
pub fn transcribe_file(service: &Sender<VoiceCommand>, path: &Path) -> Result<String> {
	let pcm = load_audio(path)?;
	if pcm.is_empty() {
		return Ok(String::new());
	}
	// Pauses split the recording; long stretches are cut at 30 s by the segmenter.
	let mut pieces = Vec::new();
	let mut seg = Segmenter::new(SegmenterConfig::default());
	for chunk in pcm.chunks(SAMPLE_RATE as usize) {
		seg.push(chunk, |u| pieces.push(u));
	}
	pieces.extend(seg.flush());
	let mut text = Vec::new();
	for piece in pieces {
		let (tx, rx) = bounded(1);
		service.send(VoiceCommand::TranscribeTo { pcm: piece, reply: tx }).map_err(|_| Error::Other("the speech engine has stopped".into()))?;
		let t = rx.recv_timeout(Duration::from_secs(300)).map_err(|_| Error::Other("the speech engine didn't answer".into()))?.map_err(Error::Other)?;
		if !t.text.trim().is_empty() {
			text.push(t.text.trim().to_string());
		}
	}
	Ok(text.join("\n\n"))
}
