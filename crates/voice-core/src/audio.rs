//! Audio sources. The microphone is the [`Speaker::User`] source; system
//! audio capture (the AI's voice) will be the [`Speaker::System`] source and
//! feeds the same [`Command::Transcribe`] path.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use crossbeam_channel::Sender;
use handy_recorder::{AudioChunk, Recorder, RecorderConfig, Sink};
use serde::{Deserialize, Serialize};

use crate::conversation::now_ms;
use crate::segmenter::{FRAME, Segmenter, SegmenterConfig};
use crate::service::{Command, Purpose};
use crate::{Result, SAMPLE_RATE};

/// Who an utterance came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Speaker {
	/// The person at the microphone.
	User,
	/// Audio the computer played: an AI voice, a call.
	System,
	/// Text your own agent produced directly (no transcription needed).
	Agent,
}

impl Speaker {
	pub fn label(self) -> &'static str {
		match self {
			Speaker::User => "You",
			Speaker::System => "AI",
			Speaker::Agent => "Agent",
		}
	}
}

/// When system audio last held speech, unix ms. Without headphones the
/// mic hears the AI's voice from the speakers; while it plays, the mic is
/// muted so it isn't transcribed twice.
#[derive(Debug, Clone, Default)]
pub struct EchoGate {
	last_voice_ms: Arc<AtomicU64>,
	disabled: Arc<AtomicBool>,
}

impl EchoGate {
	/// Speech that ended within this long still counts (room echo).
	const HOLD_MS: u64 = 400;

	#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
	pub(crate) fn mark(&self) {
		self.last_voice_ms.store(now_ms(), Ordering::Relaxed);
	}

	/// Turn off with headphones, so you can talk over the AI.
	pub fn set_enabled(&self, enabled: bool) {
		self.disabled.store(!enabled, Ordering::Relaxed);
	}

	pub fn mic_muted(&self) -> bool {
		!self.disabled.load(Ordering::Relaxed) && now_ms().saturating_sub(self.last_voice_ms.load(Ordering::Relaxed)) < Self::HOLD_MS
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicMode {
	/// Record until `stop`, then transcribe it all at once (push-to-talk).
	Dictation,
	/// Cut speech into utterances with the VAD and transcribe each as it ends.
	Conversation,
}

enum SinkMode {
	Collect(Vec<f32>),
	Segment { segmenter: Segmenter, commands: Sender<Command>, started_ms: u64, samples_seen: u64, gate: EchoGate },
}

/// Receives mic audio on handy-recorder's delivery thread.
pub struct MicSink {
	mode: SinkMode,
	level: Arc<AtomicU32>,
}

impl Sink for MicSink {
	fn process_chunk(&mut self, chunk: AudioChunk<'_>) {
		let samples = &chunk.samples[..chunk.valid_frames];
		let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt();
		self.level.store(rms.to_bits(), Ordering::Relaxed);

		match &mut self.mode {
			SinkMode::Collect(buf) => buf.extend_from_slice(samples),
			SinkMode::Segment { segmenter, commands, started_ms, samples_seen, gate } => {
				*samples_seen += samples.len() as u64;
				let end_ms = *started_ms + *samples_seen * 1000 / SAMPLE_RATE as u64;
				// Silence keeps the segmenter's timing intact and ends any
				// utterance the echo started.
				let silence;
				let samples = if gate.mic_muted() {
					silence = vec![0.0; samples.len()];
					&silence[..]
				} else {
					samples
				};
				segmenter.push(samples, |pcm| {
					let audio_ms = pcm.len() as u64 * 1000 / SAMPLE_RATE as u64;
					let _ = commands.send(Command::Transcribe { speaker: Speaker::User, at_ms: end_ms.saturating_sub(audio_ms), pcm, purpose: Purpose::Conversation });
				});
			}
		}
	}
}

/// The microphone. Opened at `start` and closed at `stop`, so the macOS mic
/// indicator is only on while recording.
pub struct MicCapture {
	device: Option<String>,
	recorder: Option<Recorder<MicSink>>,
	mode: Option<MicMode>,
	started_ms: u64,
	level: Arc<AtomicU32>,
	commands: Sender<Command>,
	gate: EchoGate,
}

impl MicCapture {
	/// `commands` is the [`VoiceService`](crate::VoiceService) sender that
	/// conversation-mode utterances go to.
	pub fn new(commands: Sender<Command>) -> Self {
		Self { device: None, recorder: None, mode: None, started_ms: 0, level: Arc::new(AtomicU32::new(0)), commands, gate: EchoGate::default() }
	}

	/// Share this with the system audio source so the mic ignores the AI's
	/// voice from the speakers.
	pub fn echo_gate(&self) -> EchoGate {
		self.gate.clone()
	}

	/// An `InputDevice::id` from [`list_devices`], or `None` for the default.
	pub fn set_device(&mut self, device: Option<String>) {
		self.device = device;
	}

	pub fn mode(&self) -> Option<MicMode> {
		self.mode
	}

	/// Current input level (RMS, 0..1), for a meter.
	pub fn level(&self) -> f32 {
		if self.mode.is_none() {
			return 0.0;
		}
		f32::from_bits(self.level.load(Ordering::Relaxed))
	}

	pub fn start(&mut self, mode: MicMode) -> Result<()> {
		if self.mode.is_some() {
			return Ok(());
		}
		let config = RecorderConfig { device: self.device.clone(), frames_per_chunk: Some(FRAME), ..RecorderConfig::speech() };
		let recorder = Recorder::open_with_failure_handler(config, |error| {
			log::error!("microphone failed: {error}");
		})?;
		self.started_ms = now_ms();
		let sink_mode = match mode {
			MicMode::Dictation => SinkMode::Collect(Vec::with_capacity(SAMPLE_RATE as usize * 30)),
			MicMode::Conversation => SinkMode::Segment { segmenter: Segmenter::new(SegmenterConfig::default()), commands: self.commands.clone(), started_ms: self.started_ms, samples_seen: 0, gate: self.gate.clone() },
		};
		self.level.store(0, Ordering::Relaxed);
		recorder.start(MicSink { mode: sink_mode, level: self.level.clone() }).map_err(|e| e.error)?;
		self.recorder = Some(recorder);
		self.mode = Some(mode);
		Ok(())
	}

	/// Stops recording and throws the audio away.
	pub fn cancel(&mut self) {
		self.mode = None;
		if let Some(recorder) = self.recorder.take() {
			let _ = recorder.stop();
		}
	}

	/// Stops recording. Dictation hands its audio to the service for
	/// transcription; conversation mode flushes the utterance in progress.
	pub fn stop(&mut self) -> Result<()> {
		let Some(recorder) = self.recorder.take() else {
			return Ok(());
		};
		self.mode = None;
		let stopped = recorder.stop();
		drop(recorder);
		let stopped = stopped?;
		if !stopped.is_complete() {
			log::warn!("incomplete recording: {:?}, {} frames dropped", stopped.end_reason, stopped.dropped_frames);
		}
		match stopped.sink.mode {
			SinkMode::Collect(pcm) => {
				// Under ~0.2 s is a stray tap of the hotkey, not speech.
				if pcm.len() >= SAMPLE_RATE as usize / 5 {
					let _ = self.commands.send(Command::Transcribe { speaker: Speaker::User, at_ms: self.started_ms, pcm, purpose: Purpose::Dictation });
				}
			}
			SinkMode::Segment { mut segmenter, started_ms, samples_seen, .. } => {
				if let Some(pcm) = segmenter.flush() {
					let end_ms = started_ms + samples_seen * 1000 / SAMPLE_RATE as u64;
					let audio_ms = pcm.len() as u64 * 1000 / SAMPLE_RATE as u64;
					let _ = self.commands.send(Command::Transcribe { speaker: Speaker::User, at_ms: end_ms.saturating_sub(audio_ms), pcm, purpose: Purpose::Conversation });
				}
			}
		}
		Ok(())
	}
}

/// Input devices as `(id, name)`.
pub fn list_devices() -> Vec<(String, String)> {
	handy_recorder::list_input_devices().map(|devices| devices.into_iter().map(|d| (d.id, d.name)).collect()).unwrap_or_default()
}
