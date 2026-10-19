//! Workspaces: the folders the person works in, usually repositories. Each
//! is an arena in the UI. Stars lit in one run in its folder, side by side
//! in the same checkout; Halo knows them all and which one is in front.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::now_ms;
use crate::store::Store;

/// The scenery each new workspace gets, in turn.
pub const ARENAS: [&str; 4] = ["bay", "mesa", "porto", "glace"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
	pub id: String,
	/// The folder's name, e.g. "billing".
	pub name: String,
	pub path: PathBuf,
	/// Which arena it is drawn as (one of [`ARENAS`]).
	pub arena: String,
	pub created: u64,
	pub last_used: u64,
}

/// A workspace with what git says about it now.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
	#[serde(flatten)]
	pub workspace: Workspace,
	/// The checked-out branch; `None` when it isn't a git repository.
	pub branch: Option<String>,
	/// Files with uncommitted changes.
	pub dirty: u32,
	/// The folder is gone (moved or deleted).
	pub missing: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
	workspaces: Vec<Workspace>,
	current: Option<String>,
}

pub struct Workspaces {
	store: Arc<Store>,
	saved: Mutex<Saved>,
}

impl Workspaces {
	pub fn load(store: Arc<Store>) -> Self {
		let saved = store.load(&store.root().join("workspaces.json")).unwrap_or_default();
		Self { store, saved: Mutex::new(saved) }
	}

	fn save(&self, saved: &Saved) {
		self.store.save(&self.store.root().join("workspaces.json"), saved);
	}

	/// Adds a folder (or returns the one already added for it).
	pub fn add(&self, path: &Path) -> Result<Workspace, String> {
		let path = std::fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
		if !path.is_dir() {
			return Err(format!("{} is not a folder", path.display()));
		}
		let mut saved = self.saved.lock();
		if let Some(w) = saved.workspaces.iter().find(|w| w.path == path) {
			return Ok(w.clone());
		}
		let used: Vec<&str> = saved.workspaces.iter().map(|w| w.arena.as_str()).collect();
		let arena = ARENAS.iter().find(|a| !used.contains(a)).unwrap_or(&ARENAS[saved.workspaces.len() % ARENAS.len()]);
		let now = now_ms();
		let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
		// Unique even for folders opened in the same millisecond.
		let mut n = saved.workspaces.len() as u64;
		let id = loop {
			let id = format!("w{}{}", crate::stars::base36(now), crate::stars::base36(n));
			if !saved.workspaces.iter().any(|w| w.id == id) {
				break id;
			}
			n += 1;
		};
		let w = Workspace { id, name, path, arena: arena.to_string(), created: now, last_used: now };
		saved.workspaces.push(w.clone());
		if saved.current.is_none() {
			saved.current = Some(w.id.clone());
		}
		self.save(&saved);
		self.store.record("workspace", None, &format!("added {}", w.path.display()));
		Ok(w)
	}

	/// Forgets a workspace (its folder and its stars are left as they are).
	pub fn remove(&self, id: &str) -> Result<(), String> {
		let mut saved = self.saved.lock();
		let before = saved.workspaces.len();
		saved.workspaces.retain(|w| w.id != id);
		if saved.workspaces.len() == before {
			return Err(format!("there is no workspace {id}"));
		}
		if saved.current.as_deref() == Some(id) {
			saved.current = saved.workspaces.iter().max_by_key(|w| w.last_used).map(|w| w.id.clone());
		}
		self.save(&saved);
		Ok(())
	}

	/// The one in front of the person (Halo assumes it unless told otherwise).
	pub fn set_current(&self, id: Option<&str>) -> Result<(), String> {
		let mut saved = self.saved.lock();
		if let Some(id) = id {
			let w = saved.workspaces.iter_mut().find(|w| w.id == id).ok_or_else(|| format!("there is no workspace {id}"))?;
			w.last_used = now_ms();
		}
		saved.current = id.map(str::to_string);
		self.save(&saved);
		Ok(())
	}

	pub fn current(&self) -> Option<Workspace> {
		let saved = self.saved.lock();
		saved.current.as_ref().and_then(|id| saved.workspaces.iter().find(|w| &w.id == id)).cloned()
	}

	pub fn current_id(&self) -> Option<String> {
		self.saved.lock().current.clone()
	}

	pub fn list(&self) -> Vec<Workspace> {
		self.saved.lock().workspaces.clone()
	}

	pub fn get(&self, id: &str) -> Option<Workspace> {
		self.saved.lock().workspaces.iter().find(|w| w.id == id).cloned()
	}

	/// By id, name (any case) or path, as Halo or the person says it.
	pub fn find(&self, key: &str) -> Option<Workspace> {
		let key = key.trim();
		let saved = self.saved.lock();
		let ws = &saved.workspaces;
		ws.iter().find(|w| w.id == key).or_else(|| ws.iter().find(|w| w.name.eq_ignore_ascii_case(key))).or_else(|| ws.iter().find(|w| w.path == Path::new(&expand_home(key)))).cloned()
	}

	/// Every workspace with its git branch and changes (runs git, a few ms each).
	pub fn infos(&self) -> Vec<WorkspaceInfo> {
		self.list().into_iter().map(info).collect()
	}

	/// For the line in front of each of Halo's turns.
	pub fn context(&self) -> String {
		let saved = self.saved.lock();
		if saved.workspaces.is_empty() {
			return "no workspaces open".into();
		}
		let parts: Vec<String> = saved
			.workspaces
			.iter()
			.map(|w| {
				let here = if saved.current.as_deref() == Some(&w.id) { ", in front of the person" } else { "" };
				format!("{} ({}{here})", w.name, tilde(&w.path))
			})
			.collect();
		format!("workspaces: {}", parts.join(", "))
	}
}

pub fn info(workspace: Workspace) -> WorkspaceInfo {
	let missing = !workspace.path.is_dir();
	let git = |args: &[&str]| -> Option<String> {
		let out = crate::quiet_command("git").arg("-C").arg(&workspace.path).args(args).output().ok()?;
		out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
	};
	let (branch, dirty) = if missing {
		(None, 0)
	} else {
		match git(&["rev-parse", "--abbrev-ref", "HEAD"]) {
			Some(b) => (Some(b.trim().to_string()), git(&["status", "--porcelain"]).map(|s| s.lines().count() as u32).unwrap_or(0)),
			None => (None, 0),
		}
	};
	WorkspaceInfo { workspace, branch, dirty, missing }
}

/// `/Users/me/code/x` → `~/code/x`.
pub fn tilde(path: &Path) -> String {
	match dirs::home_dir().and_then(|h| path.strip_prefix(h).ok().map(Path::to_path_buf)) {
		Some(rest) => format!("~/{}", rest.display()),
		None => path.display().to_string(),
	}
}

fn expand_home(p: &str) -> PathBuf {
	match (p.strip_prefix("~/"), dirs::home_dir()) {
		(Some(rest), Some(h)) => h.join(rest),
		_ => PathBuf::from(p),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn adds_finds_and_picks_arenas() {
		let dir = tempfile::tempdir().unwrap();
		let store = Arc::new(Store::new(dir.path().join("halo")));
		let (a, b) = (dir.path().join("billing"), dir.path().join("web"));
		std::fs::create_dir_all(&a).unwrap();
		std::fs::create_dir_all(&b).unwrap();
		let ws = Workspaces::load(store.clone());
		let wa = ws.add(&a).unwrap();
		let wb = ws.add(&b).unwrap();
		assert_eq!(ws.add(&a).unwrap().id, wa.id, "same folder, same workspace");
		assert_eq!((wa.arena.as_str(), wb.arena.as_str()), ("bay", "mesa"));
		assert_eq!(ws.current_id(), Some(wa.id.clone()), "the first one is in front");
		assert_eq!(ws.find("WEB").unwrap().id, wb.id);
		ws.set_current(Some(&wb.id)).unwrap();
		assert!(ws.context().contains("web (") && ws.context().contains("in front of the person"));
		assert_eq!(Workspaces::load(store).list().len(), 2, "kept on disk");
		ws.remove(&wb.id).unwrap();
		assert_eq!(ws.current_id(), Some(wa.id));
		assert!(ws.add(&dir.path().join("nope")).is_err());
		let i = info(ws.list()[0].clone());
		assert!(!i.missing && i.branch.is_none(), "not a repo: {i:?}");
	}
}
