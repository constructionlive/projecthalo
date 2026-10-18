//! System audio (what the Mac is playing: an AI voice, a call) as the
//! [`Speaker::System`] source, through ScreenCaptureKit. Needs macOS 13+ and
//! the Screen Recording permission.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use crossbeam_channel::Sender;
use parking_lot::Mutex;
use screencapturekit::prelude::*;

use crate::audio::EchoGate;
use crate::conversation::now_ms;
use crate::segmenter::{Segmenter, SegmenterConfig};
use crate::service::{Command, Purpose};
use crate::{Error, Result, SAMPLE_RATE, Speaker};

struct Shared {
	segmenter: Mutex<Segmenter>,
	commands: Sender<Command>,
	level: AtomicU32,
	gate: EchoGate,
}

impl Shared {
	fn emit(&self, pcm: Vec<f32>) {
		let audio_ms = pcm.len() as u64 * 1000 / SAMPLE_RATE as u64;
		let _ = self.commands.send(Command::Transcribe { speaker: Speaker::System, at_ms: now_ms().saturating_sub(audio_ms), pcm, purpose: Purpose::Conversation });
	}
}

struct AudioHandler(Arc<Shared>);

impl SCStreamOutputTrait for AudioHandler {
	fn did_output_sample_buffer(&self, sample: CMSampleBuffer, kind: SCStreamOutputType) {
		if !matches!(kind, SCStreamOutputType::Audio) {
			return;
		}
		let Ok(buffers) = sample.audio_buffer_list() else { return };
		// Mono float32 at 16 kHz, as configured: one buffer.
		let Some(buffer) = (&buffers).into_iter().next() else { return };
		let samples: Vec<f32> = buffer.data().as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect();
		if samples.is_empty() {
			return;
		}
		let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
		self.0.level.store(rms.to_bits(), Ordering::Relaxed);

		let mut segmenter = self.0.segmenter.lock();
		segmenter.push(&samples, |pcm| self.0.emit(pcm));
		if segmenter.in_speech() {
			self.0.gate.mark();
		}
	}
}

/// Captures everything the Mac plays, except LiveType's own sounds.
pub struct SystemAudioCapture {
	commands: Sender<Command>,
	gate: EchoGate,
	running: Option<(SCStream, Arc<Shared>)>,
}

impl SystemAudioCapture {
	pub fn new(commands: Sender<Command>, gate: EchoGate) -> Self {
		Self { commands, gate, running: None }
	}

	pub fn is_running(&self) -> bool {
		self.running.is_some()
	}

	pub fn level(&self) -> f32 {
		self.running.as_ref().map_or(0.0, |(_, s)| f32::from_bits(s.level.load(Ordering::Relaxed)))
	}

	pub fn start(&mut self) -> Result<()> {
		if self.running.is_some() {
			return Ok(());
		}
		let sc = |e: SCError| Error::Other(format!("system audio: {e}. Allow LiveType under System Settings → Privacy & Security → Screen & System Audio Recording."));
		let content = SCShareableContent::get().map_err(sc)?;
		let display = content.displays().into_iter().next().ok_or_else(|| Error::Other("system audio: no display found".into()))?;
		let filter = SCContentFilter::create().with_display(&display).with_excluding_windows(&[]).build().map_err(sc)?;
		// ScreenCaptureKit always captures video too; keep it tiny and rare.
		let config =
			SCStreamConfiguration::new().with_width(2).with_height(2).with_minimum_frame_interval(&CMTime::new(1, 1)).with_captures_audio(true).with_excludes_current_process_audio(true).with_sample_rate(SAMPLE_RATE as i32).with_channel_count(1);

		let shared = Arc::new(Shared { segmenter: Mutex::new(Segmenter::new(SegmenterConfig::default())), commands: self.commands.clone(), level: AtomicU32::new(0), gate: self.gate.clone() });
		let mut stream = SCStream::new(&filter, &config).map_err(sc)?;
		stream.add_output_handler(AudioHandler(shared.clone()), SCStreamOutputType::Audio).map_err(sc)?;
		// A screen handler that drops frames keeps ScreenCaptureKit from
		// logging every frame it has nowhere to send.
		stream.add_output_handler(|_: CMSampleBuffer, _: SCStreamOutputType| {}, SCStreamOutputType::Screen).map_err(sc)?;
		stream.start_capture().map_err(sc)?;
		self.running = Some((stream, shared));
		Ok(())
	}

	/// Stops capturing and transcribes the utterance in progress.
	pub fn stop(&mut self) -> Result<()> {
		let Some((stream, shared)) = self.running.take() else { return Ok(()) };
		let result = stream.stop_capture();
		if let Some(pcm) = shared.segmenter.lock().flush() {
			shared.emit(pcm);
		}
		result.map_err(|e| Error::Other(format!("system audio: {e}")))
	}
}

impl Drop for SystemAudioCapture {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}
