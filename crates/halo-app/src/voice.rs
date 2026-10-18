//! Voice: LiveType's speech engine, on this Mac. The microphone is heard and
//! transcribed locally with the model LiveType already downloaded (nothing is
//! fetched twice, nothing leaves the machine). Everything runs on one thread
//! that owns the engine; the app talks to it with [`VoiceCmd`]s and hears back
//! [`VoiceOut`]s (status, mic level for the meter, and what was said).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crossbeam_channel::{Sender, unbounded};
use serde::Serialize;
use voice_core::models::{self, ModelEntry};
use voice_core::{Command, MicCapture, MicMode, ModelStore, Purpose, VoiceEvent, VoiceService};

pub enum VoiceCmd {
	/// Start listening. `send`: ask Halo as soon as the words are in (hold-to-talk).
	Start { send: bool },
	/// Stop listening; the words follow as [`VoiceOut::Heard`].
	Stop,
	/// Stop and throw the recording away.
	Cancel,
	/// Free the speech model (it lives on the GPU) and end; replies when done.
	/// Must happen before the app exits: ggml aborts if its Metal device is
	/// torn down by the exit handlers with a model still loaded.
	Shutdown(Sender<()>),
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
	/// "noModel", "loading", "ready" or "failed".
	pub state: &'static str,
	pub model: Option<String>,
	pub error: Option<String>,
	pub recording: bool,
	pub transcribing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum VoiceOut {
	Status {
		status: VoiceStatus,
	},
	/// 0..1, a few times a second while recording.
	Level {
		level: f32,
	},
	/// What the person said. `send`: it should go straight to Halo.
	Heard {
		text: String,
		send: bool,
	},
}

#[derive(Clone)]
pub struct VoiceHandle {
	tx: Sender<VoiceCmd>,
	status: Arc<Mutex<VoiceStatus>>,
	/// The engine's command line, once it is up: for transcribing files.
	engine: Arc<Mutex<Option<Sender<Command>>>>,
}

impl VoiceHandle {
	pub fn send(&self, cmd: VoiceCmd) {
		let _ = self.tx.send(cmd);
	}

	/// Frees the model and waits (briefly) for it: call before quitting.
	pub fn shutdown(&self) {
		let (tx, rx) = crossbeam_channel::bounded(1);
		if self.tx.send(VoiceCmd::Shutdown(tx)).is_ok() {
			let _ = rx.recv_timeout(Duration::from_secs(4));
		}
	}

	/// For the `transcribe_audio` tool (meeting recordings, voice memos): uses the
	/// same engine and model, on this Mac.
	pub fn transcriber(&self) -> cc_agent::toolbox::Transcriber {
		let (engine, status) = (self.engine.clone(), self.status.clone());
		Arc::new(move |path: &std::path::Path| {
			if status.lock().map(|s| s.state != "ready").unwrap_or(true) {
				return Err("The speech model isn't ready (open LiveType once to download one).".into());
			}
			let sender = engine.lock().ok().and_then(|e| e.clone()).ok_or("the speech engine isn't running")?;
			voice_core::files::transcribe_file(&sender, path).map_err(|e| e.to_string())
		})
	}

	pub fn status(&self) -> VoiceStatus {
		self.status.lock().map(|s| s.clone()).unwrap_or_default()
	}
}

/// The model LiveType uses, else any downloaded one.
fn chosen_model(store: &ModelStore) -> Option<ModelEntry> {
	let choice = dirs::data_dir().and_then(|d| std::fs::read(d.join("LiveType/settings.json")).ok()).and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()).and_then(|v| v.get("model_id")?.as_str().map(str::to_string));
	let catalog = models::catalog();
	choice.and_then(|id| catalog.iter().find(|e| e.id == id).cloned()).filter(|e| store.is_available(e)).or_else(|| catalog.into_iter().find(|e| store.is_available(e)))
}

pub fn start(emit: impl Fn(VoiceOut) + Send + 'static) -> VoiceHandle {
	let (tx, rx) = unbounded::<VoiceCmd>();
	let status = Arc::new(Mutex::new(VoiceStatus { state: "noModel", ..Default::default() }));
	let shared = status.clone();
	let engine: Arc<Mutex<Option<Sender<Command>>>> = Arc::default();
	let engine_slot = engine.clone();
	let _ = std::thread::Builder::new().name("halo-voice".into()).spawn(move || {
		let publish = |f: &dyn Fn(&mut VoiceStatus)| {
			if let Ok(mut s) = shared.lock() {
				f(&mut s);
				emit(VoiceOut::Status { status: s.clone() });
			}
		};
		let service = VoiceService::spawn(|| {});
		if let Ok(mut e) = engine_slot.lock() {
			*e = Some(service.sender());
		}
		let mut mic = MicCapture::new(service.sender());
		match ModelStore::for_app("LiveType").ok().and_then(|store| chosen_model(&store).map(|e| (store.path_of(&e), e.id.clone()))) {
			Some((path, id)) => {
				publish(&|s| {
					s.state = "loading";
					s.model = Some(id.clone());
				});
				service.send(Command::LoadModel(path));
			}
			None => publish(&|s| s.state = "noModel"),
		}
		let mut send_after = false;
		let mut discard = false;
		let mut done: Option<Sender<()>> = None;
		loop {
			match rx.recv_timeout(Duration::from_millis(90)) {
				Ok(VoiceCmd::Start { send }) => {
					let ready = shared.lock().map(|s| s.state == "ready").unwrap_or(false);
					if !ready {
						publish(&|s| s.error = Some(if s.state == "noModel" { "No speech model: open LiveType once to download one.".into() } else { "The speech model is still loading.".into() }));
						continue;
					}
					send_after = send;
					discard = false;
					match mic.start(MicMode::Dictation) {
						Ok(()) => publish(&|s| {
							s.recording = true;
							s.error = None;
						}),
						Err(e) => {
							let msg = e.to_string();
							publish(&|s| s.error = Some(format!("Microphone: {msg}")));
						}
					}
				}
				Ok(VoiceCmd::Stop) => {
					if mic.mode().is_some() && mic.stop().is_ok() {
						publish(&|s| {
							s.recording = false;
							s.transcribing = true;
						});
					}
				}
				Ok(VoiceCmd::Cancel) => {
					if mic.mode().is_some() {
						discard = true;
						let _ = mic.stop();
						publish(&|s| {
							s.recording = false;
							s.transcribing = true;
						});
					}
				}
				Ok(VoiceCmd::Shutdown(reply)) => {
					done = Some(reply);
					break;
				}
				Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
				Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
			}
			if mic.mode().is_some() {
				emit(VoiceOut::Level { level: mic.level() });
			}
			while let Some(event) = service.try_recv() {
				match event {
					VoiceEvent::ModelLoading(_) => publish(&|s| s.state = "loading"),
					VoiceEvent::ModelReady { .. } => publish(&|s| {
						s.state = "ready";
						s.error = None;
					}),
					VoiceEvent::ModelFailed(e) => publish(&|s| {
						s.state = "failed";
						s.error = Some(e.clone());
					}),
					VoiceEvent::Transcribed { utterance, purpose: Purpose::Dictation, .. } => {
						publish(&|s| s.transcribing = false);
						let text = utterance.text.trim().to_string();
						if !text.is_empty() && !discard {
							emit(VoiceOut::Heard { text, send: send_after });
						}
					}
					VoiceEvent::Error(e) => {
						log::warn!("voice: {e}");
						publish(&|s| {
							s.transcribing = false;
							s.recording = false;
							s.error = Some(e.clone());
						});
					}
					_ => {}
				}
			}
		}
		let _ = mic.stop();
		if let Ok(mut e) = engine_slot.lock() {
			*e = None;
		}
		drop(mic);
		// Joins the engine thread, which frees the model while the GPU device is still alive.
		drop(service);
		log::info!("voice engine stopped");
		if let Some(reply) = done {
			let _ = reply.send(());
		}
	});
	VoiceHandle { tx, status, engine }
}
