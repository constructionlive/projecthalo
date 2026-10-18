//! The worker that owns the STT engine. Host apps send [`Command`]s and read
//! [`VoiceEvent`]s; nothing here blocks the UI thread.

use std::path::PathBuf;
use std::thread;

use crossbeam_channel::{Receiver, Sender, unbounded};

use crate::conversation::Utterance;
use crate::engine::{SttEngine, TranscribeCppEngine, Transcription};
use crate::{SAMPLE_RATE, Speaker};

/// What a transcription is for, so the host knows what to do with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
	/// Push-to-talk: type the text into the focused app.
	Dictation,
	/// A line of a live conversation.
	Conversation,
}

pub enum Command {
	/// Load a GGUF with transcribe.cpp, replacing the current engine.
	LoadModel(PathBuf),
	/// Install any other engine implementation.
	SetEngine(Box<dyn SttEngine>),
	SetVocabulary(Vec<String>),
	Transcribe {
		speaker: Speaker,
		/// When the audio started, unix ms.
		at_ms: u64,
		pcm: Vec<f32>,
		purpose: Purpose,
	},
	/// Transcribe and answer on `reply` instead of as an event: for callers
	/// on other threads, like an agent's transcribe tool.
	TranscribeTo {
		pcm: Vec<f32>,
		reply: Sender<Result<Transcription, String>>,
	},
	Shutdown,
}

#[derive(Debug, Clone)]
pub enum VoiceEvent {
	ModelLoading(PathBuf),
	ModelReady {
		description: String,
	},
	ModelFailed(String),
	/// Audio was received and is being transcribed.
	Transcribing {
		purpose: Purpose,
	},
	/// Text may be empty when the audio held no speech.
	Transcribed {
		utterance: Utterance,
		purpose: Purpose,
		/// Engine time, ms.
		elapsed_ms: u64,
	},
	Error(String),
}

pub struct VoiceService {
	commands: Sender<Command>,
	events: Receiver<VoiceEvent>,
	worker: Option<thread::JoinHandle<()>>,
}

impl VoiceService {
	/// `notify` runs on the worker after every event, e.g. to wake a UI.
	pub fn spawn(notify: impl Fn() + Send + 'static) -> Self {
		let (commands, command_rx) = unbounded::<Command>();
		let (event_tx, events) = unbounded::<VoiceEvent>();
		let worker = thread::Builder::new().name("voice-engine".into()).spawn(move || run(command_rx, event_tx, notify)).expect("spawn voice engine thread");
		Self { commands, events, worker: Some(worker) }
	}

	/// For audio sources and anything else that submits work.
	pub fn sender(&self) -> Sender<Command> {
		self.commands.clone()
	}

	pub fn send(&self, command: Command) {
		let _ = self.commands.send(command);
	}

	pub fn try_recv(&self) -> Option<VoiceEvent> {
		self.events.try_recv().ok()
	}

	pub fn events(&self) -> &Receiver<VoiceEvent> {
		&self.events
	}
}

impl Drop for VoiceService {
	fn drop(&mut self) {
		let _ = self.commands.send(Command::Shutdown);
		if let Some(worker) = self.worker.take() {
			let _ = worker.join();
		}
	}
}

fn run(commands: Receiver<Command>, events: Sender<VoiceEvent>, notify: impl Fn()) {
	let mut engine: Option<Box<dyn SttEngine>> = None;
	let mut vocabulary: Vec<String> = Vec::new();
	let emit = |event: VoiceEvent| {
		let _ = events.send(event);
		notify();
	};

	for command in commands {
		match command {
			Command::LoadModel(path) => {
				emit(VoiceEvent::ModelLoading(path.clone()));
				// Free the old model first so two never sit in memory.
				engine = None;
				match TranscribeCppEngine::load(&path) {
					Ok(mut e) => {
						e.set_vocabulary(vocabulary.clone());
						emit(VoiceEvent::ModelReady { description: e.describe() });
						engine = Some(Box::new(e));
					}
					Err(e) => emit(VoiceEvent::ModelFailed(e.to_string())),
				}
			}
			Command::SetEngine(mut e) => {
				e.set_vocabulary(vocabulary.clone());
				emit(VoiceEvent::ModelReady { description: e.describe() });
				engine = Some(e);
			}
			Command::SetVocabulary(terms) => {
				vocabulary = terms;
				if let Some(e) = engine.as_mut() {
					e.set_vocabulary(vocabulary.clone());
				}
			}
			Command::Transcribe { speaker, at_ms, pcm, purpose } => {
				let Some(e) = engine.as_mut() else {
					emit(VoiceEvent::Error("no model loaded".into()));
					continue;
				};
				emit(VoiceEvent::Transcribing { purpose });
				match e.transcribe(&pcm) {
					Ok(t) => emit(VoiceEvent::Transcribed { utterance: Utterance { speaker, text: t.text, at_ms, audio_ms: pcm.len() as u64 * 1000 / SAMPLE_RATE as u64 }, purpose, elapsed_ms: t.elapsed_ms }),
					Err(err) => emit(VoiceEvent::Error(err.to_string())),
				}
			}
			Command::TranscribeTo { pcm, reply } => {
				let result = match engine.as_mut() {
					Some(e) => e.transcribe(&pcm).map_err(|e| e.to_string()),
					None => Err("no speech model loaded".into()),
				};
				let _ = reply.send(result);
			}
			Command::Shutdown => break,
		}
	}
}
