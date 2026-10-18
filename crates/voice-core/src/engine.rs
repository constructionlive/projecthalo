use std::path::{Path, PathBuf};
use std::time::Instant;

use transcribe_cpp::{Model, RunOptions, Session};

use crate::Result;

/// The output of one engine call.
#[derive(Debug, Clone, Default)]
pub struct Transcription {
	pub text: String,
	/// Detected language, when the model reports one.
	pub language: Option<String>,
	/// Wall-clock time the engine spent, in milliseconds.
	pub elapsed_ms: u64,
}

/// A speech-to-text backend. Input is always 16 kHz mono f32 in [-1, 1].
///
/// transcribe.cpp covers every local GGUF model; another backend (a remote
/// server, a different runtime) only has to implement this.
pub trait SttEngine: Send {
	/// Short human-readable name, e.g. "parakeet-tdt-0.6b-v3 on Metal".
	fn describe(&self) -> String;

	/// Hint terms (names, jargon) for models that support custom vocabulary.
	fn set_vocabulary(&mut self, _terms: Vec<String>) {}

	fn transcribe(&mut self, pcm: &[f32]) -> Result<Transcription>;
}

/// Runs any GGUF model transcribe.cpp supports, on Metal when available.
pub struct TranscribeCppEngine {
	path: PathBuf,
	model: Model,
	session: Session,
	options: RunOptions,
}

impl TranscribeCppEngine {
	pub fn load(path: impl AsRef<Path>) -> Result<Self> {
		let path = path.as_ref().to_path_buf();
		let model = Model::load(&path)?;
		let session = model.session()?;
		log::info!("loaded {} ({}) on {}", model.variant(), model.arch(), model.backend());
		Ok(Self { path, model, session, options: RunOptions::default() })
	}

	pub fn path(&self) -> &Path {
		&self.path
	}
}

impl SttEngine for TranscribeCppEngine {
	fn describe(&self) -> String {
		let variant = self.model.variant();
		let name = if variant.is_empty() { self.model.arch() } else { variant };
		format!("{name} on {}", self.model.backend())
	}

	fn set_vocabulary(&mut self, terms: Vec<String>) {
		if self.model.supports(transcribe_cpp::Feature::Vocabulary) {
			self.options.vocabulary = terms;
		}
	}

	fn transcribe(&mut self, pcm: &[f32]) -> Result<Transcription> {
		let started = Instant::now();
		let result = self.session.run(pcm, &self.options)?;
		Ok(Transcription { text: result.text.trim().to_string(), language: result.language, elapsed_ms: started.elapsed().as_millis() as u64 })
	}
}
