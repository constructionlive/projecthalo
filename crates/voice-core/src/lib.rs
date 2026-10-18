//! voice-core: local speech-to-text for LiveType and any app that embeds it
//! (crm-desk included).
//!
//! The pieces:
//!
//! - [`engine`]: the [`SttEngine`] trait and the transcribe.cpp implementation.
//!   Any GGUF model transcribe.cpp supports (Parakeet, Whisper, Moonshine,
//!   Canary, ...) or one of your own drops in here.
//! - [`models`]: a small catalog of published models plus download and
//!   on-disk management. Custom GGUF files are added by path.
//! - [`audio`]: audio sources. Each source is tagged with a [`Speaker`], so a
//!   conversation knows who said what without a diarization model.
//! - [`system_audio`]: what the Mac plays (an AI voice) as the
//!   [`Speaker::System`] source, via ScreenCaptureKit (macOS).
//! - [`segmenter`]: earshot VAD that cuts continuous audio into utterances.
//! - [`service`]: [`VoiceService`], a worker thread that owns the engine and
//!   emits [`VoiceEvent`]s on a channel. This is what host apps talk to.
//! - [`conversation`]: the speaker-tagged transcript.
//! - [`files`]: transcribing recordings (any format macOS can decode).
//! - [`tts`]: reading text aloud ([`Narrator`]), for spoken replies.

pub mod audio;
pub mod conversation;
pub mod engine;
pub mod error;
pub mod files;
pub mod models;
pub mod segmenter;
pub mod service;
#[cfg(target_os = "macos")]
pub mod system_audio;
#[cfg(not(target_os = "macos"))]
#[path = "system_audio_stub.rs"]
pub mod system_audio;
pub mod tts;

pub use audio::{EchoGate, MicCapture, MicMode, Speaker};
pub use conversation::{Conversation, Utterance};
pub use engine::{SttEngine, TranscribeCppEngine, Transcription};
pub use error::{Error, Result};
pub use models::{CATALOG, ModelEntry, ModelSource, ModelStore};
pub use service::{Command, Purpose, VoiceEvent, VoiceService};
pub use system_audio::SystemAudioCapture;
pub use tts::Narrator;

/// Sample rate every engine and source in this crate works at.
pub const SAMPLE_RATE: u32 = 16_000;
