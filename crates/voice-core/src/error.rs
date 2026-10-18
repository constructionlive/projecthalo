#[derive(Debug, thiserror::Error)]
pub enum Error {
	#[error("no model loaded")]
	NoModel,
	#[error("model error: {0}")]
	Model(#[from] transcribe_cpp::Error),
	#[error("microphone error: {0}")]
	Mic(#[from] handy_recorder::Error),
	#[error("download failed: {0}")]
	Download(String),
	#[error("io error: {0}")]
	Io(#[from] std::io::Error),
	#[error("{0}")]
	Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;
