//! Halo on disk:
//!
//! ```text
//! <root>/halo/session.json      Halo's own conversation
//! <root>/halo/transcript.json   what the person sees of it
//! <root>/halo/work/             Halo's folder (quick lookups, attachments)
//! <root>/stars/<id>/star.json   a star's snapshot
//! <root>/stars/<id>/session.json
//! <root>/stars/<id>/work/       the star's folder (its CLI runs here)
//! <root>/events.jsonl           append-only log of everything (never compacted)
//! ```

use std::io::Write;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::json;

pub struct Store {
	root: PathBuf,
	log: Mutex<()>,
}

impl Store {
	pub fn new(root: impl Into<PathBuf>) -> Self {
		let root = root.into();
		let _ = std::fs::create_dir_all(root.join("halo/work"));
		let _ = std::fs::create_dir_all(root.join("stars"));
		Self { root, log: Mutex::new(()) }
	}

	/// `~/Library/Application Support/Halo` on macOS.
	pub fn default_root() -> PathBuf {
		dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("Halo")
	}

	pub fn root(&self) -> &Path {
		&self.root
	}

	pub fn halo_dir(&self) -> PathBuf {
		self.root.join("halo")
	}

	pub fn star_dir(&self, id: &str) -> PathBuf {
		self.root.join("stars").join(id)
	}

	/// Writes through a temporary file, so a crash never leaves half a file.
	pub fn save<T: Serialize>(&self, path: &Path, value: &T) {
		if let Some(dir) = path.parent() {
			let _ = std::fs::create_dir_all(dir);
		}
		let tmp = path.with_extension("tmp");
		match serde_json::to_vec_pretty(value) {
			Ok(bytes) => {
				if std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, path)).is_err() {
					log::warn!("could not save {}", path.display());
				}
			}
			Err(e) => log::warn!("could not encode {}: {e}", path.display()),
		}
	}

	pub fn load<T: DeserializeOwned>(&self, path: &Path) -> Option<T> {
		let bytes = std::fs::read(path).ok()?;
		match serde_json::from_slice(&bytes) {
			Ok(v) => Some(v),
			Err(e) => {
				log::warn!("could not read {}: {e}", path.display());
				None
			}
		}
	}

	/// One line in the log that recall will search: what happened, to which star.
	pub fn record(&self, kind: &str, star: Option<&str>, text: &str) {
		let line = json!({ "ts": crate::now_ms(), "kind": kind, "star": star, "text": text });
		let _guard = self.log.lock();
		let res = std::fs::OpenOptions::new().create(true).append(true).open(self.root.join("events.jsonl")).and_then(|mut f| writeln!(f, "{line}"));
		if let Err(e) = res {
			log::warn!("could not write the event log: {e}");
		}
	}

	/// Every star folder that has a snapshot.
	pub fn star_ids(&self) -> Vec<String> {
		let mut ids: Vec<String> = std::fs::read_dir(self.root.join("stars")).map(|rd| rd.filter_map(Result::ok).filter(|e| e.path().join("star.json").is_file()).map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
		ids.sort();
		ids
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn saves_loads_and_logs() {
		let dir = tempfile::tempdir().unwrap();
		let s = Store::new(dir.path());
		let p = s.star_dir("s1").join("star.json");
		s.save(&p, &json!({ "a": 1 }));
		assert_eq!(s.load::<serde_json::Value>(&p).unwrap()["a"], 1);
		assert_eq!(s.star_ids(), vec!["s1".to_string()]);
		s.record("landed", Some("s1"), "41 doors");
		s.record("you", None, "thanks");
		let log = std::fs::read_to_string(dir.path().join("events.jsonl")).unwrap();
		assert_eq!(log.lines().count(), 2);
		assert!(log.contains("41 doors"));
	}
}
