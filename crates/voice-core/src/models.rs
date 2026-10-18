//! Model catalog and on-disk store.
//!
//! Catalog models are GGUF files published under huggingface.co/handy-computer
//! and verified against their reference implementations by the transcribe.cpp
//! project. Any other GGUF transcribe.cpp can load is added as a custom path.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use crate::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModelSource {
	/// A file in a Hugging Face repo, downloaded into the store.
	HuggingFace { repo: String, file: String },
	/// A GGUF already on disk.
	Local { path: PathBuf },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelEntry {
	/// Stable id used in settings.
	pub id: String,
	pub name: String,
	pub notes: String,
	pub size_mb: u32,
	pub source: ModelSource,
}

/// A published model in the built-in catalog.
#[derive(Debug, Clone, Copy)]
pub struct CatalogItem {
	pub id: &'static str,
	pub name: &'static str,
	pub notes: &'static str,
	pub size_mb: u32,
	pub repo: &'static str,
	pub file: &'static str,
}

/// Curated starting set. The first entry is the default.
pub const CATALOG: &[CatalogItem] = &[
	CatalogItem {
		id: "parakeet-tdt-0.6b-v3",
		name: "Parakeet TDT 0.6B v3",
		notes: "Best all-round. 25 European languages; the model Phonon-2 is distilled from.",
		size_mb: 485,
		repo: "handy-computer/parakeet-tdt-0.6b-v3-gguf",
		file: "parakeet-tdt-0.6b-v3-Q4_K_M.gguf",
	},
	CatalogItem { id: "parakeet-tdt-0.6b-v2", name: "Parakeet TDT 0.6B v2", notes: "English only, very accurate.", size_mb: 475, repo: "handy-computer/parakeet-tdt-0.6b-v2-gguf", file: "parakeet-tdt-0.6b-v2-Q4_K_M.gguf" },
	CatalogItem { id: "whisper-large-v3-turbo", name: "Whisper large-v3 turbo", notes: "99 languages. Slower than Parakeet.", size_mb: 536, repo: "handy-computer/whisper-large-v3-turbo-gguf", file: "whisper-large-v3-turbo-Q4_K_M.gguf" },
	CatalogItem { id: "canary-180m-flash", name: "Canary 180M Flash", notes: "Small and fast. English, German, French, Spanish.", size_mb: 139, repo: "handy-computer/canary-180m-flash-gguf", file: "canary-180m-flash-Q4_K_M.gguf" },
	CatalogItem { id: "whisper-base.en", name: "Whisper base.en", notes: "Tiny English model, good for testing.", size_mb: 59, repo: "handy-computer/whisper-base.en-gguf", file: "whisper-base.en-Q4_K_M.gguf" },
];

impl CatalogItem {
	pub fn entry(&self) -> ModelEntry {
		ModelEntry { id: self.id.into(), name: self.name.into(), notes: self.notes.into(), size_mb: self.size_mb, source: ModelSource::HuggingFace { repo: self.repo.into(), file: self.file.into() } }
	}
}

pub fn catalog() -> Vec<ModelEntry> {
	CATALOG.iter().map(CatalogItem::entry).collect()
}

pub fn default_model_id() -> &'static str {
	CATALOG[0].id
}

/// Where downloaded models live.
#[derive(Debug, Clone)]
pub struct ModelStore {
	dir: PathBuf,
}

impl ModelStore {
	/// `<data dir>/<app>/models`, e.g. `~/Library/Application Support/LiveType/models`.
	pub fn for_app(app: &str) -> Result<Self> {
		let base = dirs::data_dir().ok_or_else(|| Error::Other("no data directory".into()))?;
		Self::at(base.join(app).join("models"))
	}

	pub fn at(dir: impl Into<PathBuf>) -> Result<Self> {
		let dir = dir.into();
		fs::create_dir_all(&dir)?;
		Ok(Self { dir })
	}

	pub fn dir(&self) -> &Path {
		&self.dir
	}

	/// Where the entry's GGUF is (or would be, once downloaded).
	pub fn path_of(&self, entry: &ModelEntry) -> PathBuf {
		match &entry.source {
			ModelSource::HuggingFace { file, .. } => self.dir.join(file),
			ModelSource::Local { path } => path.clone(),
		}
	}

	pub fn is_available(&self, entry: &ModelEntry) -> bool {
		self.path_of(entry).is_file()
	}

	/// Downloads a Hugging Face entry. `progress(done, total)` is called as
	/// bytes arrive; setting `cancel` stops the download and removes the
	/// partial file.
	pub fn download(&self, entry: &ModelEntry, cancel: &AtomicBool, mut progress: impl FnMut(u64, u64)) -> Result<PathBuf> {
		let ModelSource::HuggingFace { repo, file } = &entry.source else {
			return Ok(self.path_of(entry));
		};
		let dest = self.dir.join(file);
		let part = self.dir.join(format!("{file}.part"));
		let url = format!("https://huggingface.co/{repo}/resolve/main/{file}");

		let client = reqwest::blocking::Client::builder().timeout(None).build().map_err(|e| Error::Download(e.to_string()))?;
		let mut response = client.get(&url).send().and_then(|r| r.error_for_status()).map_err(|e| Error::Download(e.to_string()))?;
		let total = response.content_length().unwrap_or(0);

		let result = (|| -> Result<()> {
			let mut out = File::create(&part)?;
			let mut buf = vec![0u8; 1 << 16];
			let mut done = 0u64;
			loop {
				if cancel.load(Ordering::Relaxed) {
					return Err(Error::Download("cancelled".into()));
				}
				let n = response.read(&mut buf)?;
				if n == 0 {
					break;
				}
				out.write_all(&buf[..n])?;
				done += n as u64;
				progress(done, total);
			}
			out.sync_all()?;
			if total != 0 && done != total {
				return Err(Error::Download(format!("got {done} of {total} bytes")));
			}
			Ok(())
		})();

		match result {
			Ok(()) => {
				fs::rename(&part, &dest)?;
				Ok(dest)
			}
			Err(e) => {
				let _ = fs::remove_file(&part);
				Err(e)
			}
		}
	}

	/// Deletes a downloaded model. Custom (local) models are never deleted.
	pub fn remove(&self, entry: &ModelEntry) -> Result<()> {
		if let ModelSource::HuggingFace { .. } = entry.source {
			let path = self.path_of(entry);
			if path.exists() {
				fs::remove_file(path)?;
			}
		}
		Ok(())
	}
}

/// A custom entry for a GGUF on disk.
pub fn custom_entry(path: &Path) -> ModelEntry {
	let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "custom model".into());
	let size_mb = fs::metadata(path).map(|m| (m.len() / 1_000_000) as u32).unwrap_or(0);
	ModelEntry { id: format!("custom:{}", path.display()), name: stem, notes: path.display().to_string(), size_mb, source: ModelSource::Local { path: path.to_path_buf() } }
}
