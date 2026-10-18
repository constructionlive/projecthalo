//! Themes the person makes: each a folder of web code (React, three.js, CSS)
//! built against the theme kit that ships in the app, run sandboxed in Halo's
//! window (the window decides what a theme may do, from its theme.json).
//!
//! ```text
//! <root>/themes/<id>/theme.json   name, description, what it was made from, permissions
//! <root>/themes/<id>/src/         its code: src/index.tsx renders the whole window
//! <root>/themes/<id>/dist/        the build (theme.js, theme.css, assets/)
//! <root>/themes/<id>/.kit/        read-only reference for its agent: KIT.md and Halo's UI source
//! <root>/themes/<id>/.halo/       its state, and a snapshot of src per good build (undo)
//! ```
//!
//! The kit (`<kit>`): `ui/src` (Halo's UI, with the sandbox's lib/api), the
//! libraries in `node_modules`, `bin/esbuild` and `KIT.md`.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use crossbeam_channel::Sender;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::{HaloEvent, now_ms};

/// The kit version a theme is written against (KIT.md documents it).
pub const KIT_VERSION: u32 = 1;
/// The built-in themes a new one can start from.
pub const STARTS: [&str; 3] = ["blank", "roadster", "galaxy"];
/// Everything a theme can ask for; a theme gets only what its theme.json lists.
pub const PERMISSIONS: [&str; 8] = ["read", "ask", "agents", "workspaces", "terminals", "voice", "settings", "app"];
/// Files a snapshot keeps (code, styles, notes; not images or video).
const TEXT: [&str; 8] = ["ts", "tsx", "js", "jsx", "css", "json", "md", "svg"];
const SNAPSHOTS_KEPT: u32 = 40;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
	pub name: String,
	#[serde(default)]
	pub description: String,
	#[serde(default = "kit_version")]
	pub kit: u32,
	#[serde(default)]
	pub permissions: Vec<String>,
	/// The built-in it was made from.
	#[serde(default)]
	pub from: Option<String>,
}

fn kit_version() -> u32 {
	KIT_VERSION
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildState {
	/// Good builds so far (each has a snapshot).
	version: u32,
	built: Option<u64>,
	/// The last build's errors, if it failed.
	error: Option<String>,
	ms: u64,
}

/// A theme as the windows see it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeInfo {
	pub id: String,
	#[serde(flatten)]
	pub manifest: Manifest,
	pub version: u32,
	pub built: Option<u64>,
	pub error: Option<String>,
	pub ms: u64,
	pub dir: PathBuf,
}

pub struct Themes {
	root: PathBuf,
	kit: Option<PathBuf>,
	events: Sender<HaloEvent>,
	/// Source fingerprints, to rebuild when a file changes.
	seen: Mutex<BTreeMap<String, u64>>,
	building: Mutex<()>,
}

impl Themes {
	/// `kit`: where the theme kit is (None: themes can't be built here).
	pub fn new(root: PathBuf, kit: Option<PathBuf>, events: Sender<HaloEvent>) -> Arc<Self> {
		let _ = std::fs::create_dir_all(&root);
		let t = Arc::new(Self { root, kit, events, seen: Mutex::default(), building: Mutex::new(()) });
		let weak = Arc::downgrade(&t);
		let _ = std::thread::Builder::new().name("halo-themes".into()).spawn(move || {
			loop {
				std::thread::sleep(Duration::from_millis(700));
				let Some(t) = weak.upgrade() else { break };
				t.rebuild_changed();
			}
		});
		t
	}

	pub fn kit(&self) -> Option<&Path> {
		self.kit.as_deref()
	}

	pub fn dir(&self, id: &str) -> Option<PathBuf> {
		let ok = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
		ok.then(|| self.root.join(id)).filter(|d| d.join("theme.json").is_file())
	}

	pub fn list(&self) -> Vec<ThemeInfo> {
		let mut out: Vec<ThemeInfo> = std::fs::read_dir(&self.root).into_iter().flatten().flatten().filter_map(|e| self.info(&e.file_name().to_string_lossy())).collect();
		out.sort_by_key(|t| std::cmp::Reverse(t.built.unwrap_or(0)));
		out
	}

	pub fn info(&self, id: &str) -> Option<ThemeInfo> {
		let dir = self.dir(id)?;
		let manifest: Manifest = serde_json::from_slice(&std::fs::read(dir.join("theme.json")).ok()?).ok()?;
		let st: BuildState = std::fs::read(dir.join(".halo/state.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
		Some(ThemeInfo { id: id.to_string(), manifest, version: st.version, built: st.built, error: st.error, ms: st.ms, dir })
	}

	/// A new theme, from a built-in (`blank`, `roadster`, `galaxy`), built once.
	pub fn create(&self, name: &str, from: &str) -> Result<ThemeInfo, String> {
		let kit = self.kit.as_ref().ok_or("The theme kit isn't in this copy of Halo.")?;
		if !STARTS.contains(&from) {
			return Err(format!("unknown starting point {from}"));
		}
		let name = name.trim();
		let name = if name.is_empty() { "My theme" } else { name };
		let id = format!("{}-{}", slug(name), crate::stars::base36(now_ms() % 1_000_000_000));
		let dir = self.root.join(&id);
		let src = dir.join("src");
		std::fs::create_dir_all(&src).map_err(|e| e.to_string())?;
		let ui = kit.join("ui/src");
		let permissions: Vec<String> = match from {
			"blank" => {
				copy_dir(&ui.join("kit/templates/blank"), &src, &|_| true)?;
				let _ = std::fs::remove_file(src.join("theme.json"));
				vec!["read", "ask", "agents"]
			}
			"roadster" => {
				copy_dir(&ui.join("roadster"), &src.join("roadster"), &|_| true)?;
				std::fs::write(src.join("index.tsx"), "// This theme started as Halo's Roadster world: the season of arenas, the cars, the cockpit.\nimport type { ThemeProps } from '@halo/ui/kit/theme';\nimport { Roadster } from './roadster/Roadster';\n\nexport default function Theme(props: ThemeProps) {\n  return <Roadster {...props} />;\n}\n").map_err(|e| e.to_string())?;
				vec!["read", "ask", "agents", "workspaces", "terminals", "voice"]
			}
			_ => {
				std::fs::create_dir_all(src.join("sky")).map_err(|e| e.to_string())?;
				std::fs::copy(ui.join("sky/Sky.tsx"), src.join("sky/Sky.tsx")).map_err(|e| e.to_string())?;
				std::fs::write(src.join("index.tsx"), "// This theme started as Halo's Galaxy: Halo and its agents as stars.\nimport { Sky } from './sky/Sky';\n\nexport default function Theme() {\n  return <Sky />;\n}\n").map_err(|e| e.to_string())?;
				vec!["read", "ask", "agents", "workspaces", "terminals", "voice", "settings"]
			}
		}
		.into_iter()
		.map(String::from)
		.collect();
		rewire(&src, &src)?;
		let manifest = Manifest { name: name.to_string(), description: String::new(), kit: KIT_VERSION, permissions, from: Some(from.to_string()) };
		write_json(&dir.join("theme.json"), &manifest)?;
		self.refresh_reference(&id)?;
		self.build(&id)
	}

	/// Puts the kit's reference (KIT.md, Halo's UI source as text) in the theme's
	/// `.kit/`, where its agent can read it: fresh, so it matches this Halo.
	pub fn refresh_reference(&self, id: &str) -> Result<(), String> {
		let kit = self.kit.as_ref().ok_or("The theme kit isn't in this copy of Halo.")?;
		let dir = self.dir(id).or_else(|| Some(self.root.join(id))).filter(|d| d.is_dir()).ok_or_else(|| format!("there is no theme {id}"))?;
		let refdir = dir.join(".kit");
		let _ = std::fs::remove_dir_all(&refdir);
		copy_dir(&kit.join("ui/src"), &refdir.join("ui/src"), &is_text)?;
		std::fs::copy(kit.join("KIT.md"), refdir.join("KIT.md")).map_err(|e| e.to_string())?;
		Ok(())
	}

	/// Builds it now; a good build is snapshotted (undo), a bad one keeps the last good build.
	pub fn build(&self, id: &str) -> Result<ThemeInfo, String> {
		let dir = self.dir(id).ok_or_else(|| format!("there is no theme {id}"))?;
		let kit = self.kit.as_ref().ok_or("The theme kit isn't in this copy of Halo.")?;
		let _one = self.building.lock();
		let mut st: BuildState = std::fs::read(dir.join(".halo/state.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
		let t0 = Instant::now();
		let result = build_dir(kit, &dir, &dir.join("dist"));
		st.ms = t0.elapsed().as_millis() as u64;
		match result {
			Ok(()) => {
				st.version += 1;
				st.built = Some(now_ms());
				st.error = None;
				snapshot(&dir, st.version)?;
			}
			Err(e) => st.error = Some(e),
		}
		write_json(&dir.join(".halo/state.json"), &st)?;
		self.seen.lock().insert(id.to_string(), fingerprint(&dir.join("src")));
		let info = self.info(id).ok_or("the theme vanished")?;
		let _ = self.events.send(HaloEvent::Theme { theme: Box::new(info.clone()) });
		Ok(info)
	}

	/// Back to the build before the last good one.
	pub fn undo(&self, id: &str) -> Result<ThemeInfo, String> {
		let dir = self.dir(id).ok_or_else(|| format!("there is no theme {id}"))?;
		let info = self.info(id).ok_or("the theme vanished")?;
		if info.version < 2 {
			return Err("Nothing to undo: this is its first version.".into());
		}
		let back = dir.join(".halo/history").join((info.version - 1).to_string());
		if !back.is_dir() {
			return Err("That version is no longer kept.".into());
		}
		// The text files become the snapshot's (images and video stay as they are).
		for f in walk(&dir.join("src")).into_iter().filter(|f| is_text(f)) {
			let _ = std::fs::remove_file(f);
		}
		copy_dir(&back, &dir.join("src"), &|_| true)?;
		// The undone build and its snapshot go; the restored one is built anew as the next version.
		let _ = std::fs::remove_dir_all(dir.join(".halo/history").join(info.version.to_string()));
		let mut st: BuildState = std::fs::read(dir.join(".halo/state.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
		st.version -= 2;
		write_json(&dir.join(".halo/state.json"), &st)?;
		self.build(id)
	}

	pub fn delete(&self, id: &str) -> Result<(), String> {
		let dir = self.dir(id).ok_or_else(|| format!("there is no theme {id}"))?;
		std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
		self.seen.lock().remove(id);
		let _ = self.events.send(HaloEvent::ThemeRemoved { id: id.to_string() });
		Ok(())
	}

	/// A file of a theme's build, for the window to load (never outside its dist/).
	pub fn asset(&self, id: &str, path: &str) -> Option<PathBuf> {
		let dist = self.dir(id)?.join("dist");
		let rel = Path::new(path.trim_start_matches('/'));
		if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
			return None;
		}
		Some(dist.join(rel)).filter(|p| p.is_file())
	}

	/// What its agent is told, around the person's request.
	pub fn agent_goal(&self, id: &str, request: &str, halo_exe: &Path) -> Result<String, String> {
		let info = self.info(id).ok_or_else(|| format!("there is no theme {id}"))?;
		self.refresh_reference(id)?;
		Ok(format!(
			"You are changing a Halo theme, \"{name}\", in this folder: the person sees it live in Halo's window as you work.\n\n\
			The person asks: {request}\n\n\
			How:\n\
			- Read .kit/KIT.md first: what a theme is, what Halo gives it, the rules. .kit/ui/src is Halo's own UI source, read-only: learn from it, never edit it.\n\
			- Change only files in src/ (and theme.json's name, description and permissions). Import Halo's components as '@halo/ui/…'.\n\
			- After each change, build: \"{exe}\" --theme-build \"{dir}\". Fix every error it prints before you go on. Halo rebuilds and reloads the theme when your files change, so keep it building.\n\
			- Ask only for the permissions the theme needs, and never add network calls or remote scripts: themes run sandboxed and offline.\n\
			- Finish with a short note of what changed and how it looks.",
			name = info.manifest.name,
			exe = halo_exe.display(),
			dir = info.dir.display(),
		))
	}

	/// Rebuilds themes whose source changed (an agent, or the person, editing them).
	fn rebuild_changed(&self) {
		if self.kit.is_none() {
			return;
		}
		for t in self.list() {
			let fp = fingerprint(&t.dir.join("src"));
			let before = self.seen.lock().get(&t.id).copied();
			match before {
				None => {
					self.seen.lock().insert(t.id.clone(), fp);
				}
				Some(b) if b != fp => {
					// Let a burst of saves settle first.
					std::thread::sleep(Duration::from_millis(250));
					if fingerprint(&t.dir.join("src")) == fp {
						let _ = self.build(&t.id);
					}
				}
				_ => {}
			}
		}
	}
}

/// esbuild, from the kit, on a theme folder, into `out` (its `dist/` for the
/// real thing). Errors come back as esbuild prints them (file, line, what's wrong).
pub fn build_dir(kit: &Path, dir: &Path, out: &Path) -> Result<(), String> {
	let entry = dir.join("src/index.tsx");
	if !entry.is_file() {
		return Err("src/index.tsx is missing: it's the theme's entry.".into());
	}
	let out = Command::new(kit.join("bin/esbuild"))
		.arg(kit.join("ui/src/kit/main.tsx"))
		.args(["--bundle", "--format=esm", "--target=safari16", "--jsx=automatic", "--minify", "--log-level=error", "--color=false"])
		.arg(format!("--outdir={}", out.display()))
		.arg("--entry-names=theme")
		.arg(format!("--alias:@theme={}", entry.display()))
		.arg(format!("--alias:@halo/ui={}", kit.join("ui/src").display()))
		.args([
			"--loader:.jpg=file",
			"--loader:.jpeg=file",
			"--loader:.png=file",
			"--loader:.webp=file",
			"--loader:.svg=file",
			"--loader:.mp4=file",
			"--loader:.webm=file",
			"--loader:.woff2=file",
			"--loader:.woff=file",
			"--loader:.glb=file",
			"--loader:.hdr=file",
		])
		.arg("--asset-names=assets/[name]-[hash]")
		// Relative: the frame's document sets its <base> to wherever the build is served
		// (halotheme://localhost/<id>/ in the app, the dev bridge in tests).
		.arg("--public-path=./")
		.env("NODE_PATH", kit.join("node_modules"))
		.current_dir(dir)
		.output()
		.map_err(|e| format!("couldn't run the theme compiler: {e}"))?;
	if out.status.success() {
		Ok(())
	} else {
		let text = String::from_utf8_lossy(&out.stderr).trim().to_string();
		Err(if text.is_empty() { "the build failed".into() } else { text.chars().take(6000).collect() })
	}
}

/// Imports of files the theme didn't copy point at the kit (`@halo/ui/…`), so a
/// built-in's copied source finds the rest of Halo's UI.
fn rewire(src: &Path, file_root: &Path) -> Result<(), String> {
	let re = regex::Regex::new(r#"((?:from|import)\s+['"])(\.{1,2}/[^'"]+)(['"])"#).expect("import pattern");
	for f in walk(file_root).into_iter().filter(|f| matches!(ext(f).as_str(), "ts" | "tsx" | "css")) {
		let text = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
		let dir = f.parent().unwrap_or(src).to_path_buf();
		let out = re.replace_all(&text, |c: &regex::Captures| {
			let target = normalize(&dir.join(&c[2]));
			let exists = [target.clone(), with_ext(&target, ".ts"), with_ext(&target, ".tsx"), with_ext(&target, ".css"), target.join("index.ts"), target.join("index.tsx")].iter().any(|p| p.exists());
			match (exists, target.strip_prefix(src)) {
				(false, Ok(rel)) => format!("{}@halo/ui/{}{}", &c[1], rel.to_string_lossy(), &c[3]),
				_ => c[0].to_string(),
			}
		});
		if out != text {
			std::fs::write(&f, out.as_ref()).map_err(|e| e.to_string())?;
		}
	}
	Ok(())
}

fn with_ext(p: &Path, e: &str) -> PathBuf {
	PathBuf::from(format!("{}{e}", p.display()))
}

/// `a/b/../c` → `a/c`, without touching the disk.
fn normalize(p: &Path) -> PathBuf {
	let mut out = PathBuf::new();
	for c in p.components() {
		match c {
			Component::ParentDir => {
				out.pop();
			}
			Component::CurDir => {}
			other => out.push(other),
		}
	}
	out
}

fn snapshot(dir: &Path, version: u32) -> Result<(), String> {
	let hist = dir.join(".halo/history");
	copy_dir(&dir.join("src"), &hist.join(version.to_string()), &is_text)?;
	if version > SNAPSHOTS_KEPT {
		let _ = std::fs::remove_dir_all(hist.join((version - SNAPSHOTS_KEPT).to_string()));
	}
	Ok(())
}

/// Changes when any file under `dir` is added, removed or saved.
fn fingerprint(dir: &Path) -> u64 {
	let mut h: u64 = 1469598103934665603;
	for f in walk(dir) {
		let m = std::fs::metadata(&f).ok();
		let t = m.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0);
		for v in [f.to_string_lossy().len() as u64, t, m.map(|m| m.len()).unwrap_or(0)] {
			h = (h ^ v).wrapping_mul(1099511628211);
		}
		for b in f.to_string_lossy().bytes() {
			h = (h ^ b as u64).wrapping_mul(1099511628211);
		}
	}
	h
}

fn ext(p: &Path) -> String {
	p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn is_text(p: &Path) -> bool {
	TEXT.contains(&ext(p).as_str())
}

fn walk(dir: &Path) -> Vec<PathBuf> {
	let mut out = Vec::new();
	let mut todo = vec![dir.to_path_buf()];
	while let Some(d) = todo.pop() {
		for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
			let p = e.path();
			if e.file_name().to_string_lossy().starts_with('.') {
				continue;
			}
			if p.is_dir() {
				todo.push(p);
			} else {
				out.push(p);
			}
		}
	}
	out.sort();
	out
}

fn copy_dir(from: &Path, to: &Path, keep: &dyn Fn(&Path) -> bool) -> Result<(), String> {
	for f in walk(from).into_iter().filter(|f| keep(f)) {
		let rel = f.strip_prefix(from).map_err(|e| e.to_string())?;
		let dest = to.join(rel);
		if let Some(p) = dest.parent() {
			std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
		}
		std::fs::copy(&f, &dest).map_err(|e| format!("{}: {e}", f.display()))?;
	}
	Ok(())
}

fn write_json<T: Serialize>(path: &Path, v: &T) -> Result<(), String> {
	if let Some(p) = path.parent() {
		std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
	}
	std::fs::write(path, serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn slug(name: &str) -> String {
	let s: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
	let s = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
	let s: String = s.chars().take(32).collect();
	if s.is_empty() { "theme".into() } else { s }
}

#[cfg(test)]
mod tests {
	use crossbeam_channel::unbounded;

	use super::*;

	/// The kit staged by scripts/stage-kit.sh (skips when it isn't there).
	fn kit() -> Option<PathBuf> {
		let k = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../halo-app/kit");
		k.join("bin/esbuild").is_file().then_some(k)
	}

	#[test]
	fn rewire_points_missing_imports_at_the_kit() {
		let d = tempfile::tempdir().unwrap();
		let src = d.path().join("src");
		std::fs::create_dir_all(src.join("roadster")).unwrap();
		std::fs::write(src.join("roadster/car.ts"), "export const x = 1;\n").unwrap();
		std::fs::write(src.join("roadster/Pier.tsx"), "import { x } from './car';\nimport { api } from '../lib/api';\nimport '../styles/halo.css';\n").unwrap();
		rewire(&src, &src).unwrap();
		let out = std::fs::read_to_string(src.join("roadster/Pier.tsx")).unwrap();
		assert!(out.contains("from './car'") && out.contains("from '@halo/ui/lib/api'") && out.contains("import '@halo/ui/styles/halo.css'"), "{out}");
	}

	#[test]
	fn assets_never_leave_the_build() {
		let d = tempfile::tempdir().unwrap();
		let (tx, _rx) = unbounded();
		let t = Themes::new(d.path().to_path_buf(), None, tx);
		std::fs::create_dir_all(d.path().join("x/dist")).unwrap();
		std::fs::write(d.path().join("x/theme.json"), r#"{"name":"x"}"#).unwrap();
		std::fs::write(d.path().join("x/dist/theme.js"), "1").unwrap();
		std::fs::write(d.path().join("secret.txt"), "no").unwrap();
		assert!(t.asset("x", "theme.js").is_some());
		assert!(t.asset("x", "../../secret.txt").is_none());
		assert!(t.asset("x", "/etc/passwd").is_none());
		assert!(t.asset("../x", "theme.js").is_none(), "ids are names, not paths");
	}

	#[test]
	fn a_theme_is_made_built_broken_rebuilt_and_undone() {
		let Some(kit) = kit() else { return eprintln!("no staged kit: run scripts/stage-kit.sh") };
		let d = tempfile::tempdir().unwrap();
		let (tx, rx) = unbounded();
		let t = Themes::new(d.path().to_path_buf(), Some(kit), tx);
		let th = t.create("Ocean Deck", "blank").unwrap();
		assert!(th.id.starts_with("ocean-deck-") && th.error.is_none() && th.version == 1, "{th:?}");
		assert!(th.dir.join("dist/theme.js").is_file() && th.dir.join(".kit/KIT.md").is_file());
		// An agent's broken edit: the last good build stays, the error is reported.
		let index = th.dir.join("src/index.tsx");
		let good = std::fs::read_to_string(&index).unwrap();
		std::fs::write(&index, good.replace("export default function Theme", "export default function Theme(")).unwrap();
		let broken = t.build(&th.id).unwrap();
		assert!(broken.error.as_deref().is_some_and(|e| e.contains("index.tsx")) && broken.version == 1, "{broken:?}");
		// Fixed with a visible change: version 2.
		std::fs::write(&index, good.replace("<span className=\"t-name\">Halo</span>", "<span className=\"t-name\">Ocean Deck</span>")).unwrap();
		let fixed = t.build(&th.id).unwrap();
		assert!(fixed.error.is_none() && fixed.version == 2);
		assert!(std::fs::read_to_string(th.dir.join("dist/theme.js")).unwrap().contains("Ocean Deck"));
		// Undo: back to the first version's code.
		let undone = t.undo(&th.id).unwrap();
		assert!(undone.error.is_none(), "{undone:?}");
		assert!(!std::fs::read_to_string(&index).unwrap().contains("Ocean Deck"));
		assert!(!std::fs::read_to_string(th.dir.join("dist/theme.js")).unwrap().contains("Ocean Deck"));
		assert!(rx.try_iter().any(|e| matches!(e, HaloEvent::Theme { .. })));
		t.delete(&th.id).unwrap();
		assert!(t.list().is_empty());
	}

	#[test]
	fn roadster_and_galaxy_fork_and_build() {
		let Some(kit) = kit() else { return };
		let d = tempfile::tempdir().unwrap();
		let (tx, _rx) = unbounded();
		let t = Themes::new(d.path().to_path_buf(), Some(kit), tx);
		for from in ["roadster", "galaxy"] {
			let th = t.create(&format!("My {from}"), from).unwrap();
			assert!(th.error.is_none(), "{from}: {:?}", th.error);
			assert_eq!(th.manifest.from.as_deref(), Some(from));
		}
	}

	#[test]
	fn a_save_rebuilds_on_its_own() {
		let Some(kit) = kit() else { return };
		let d = tempfile::tempdir().unwrap();
		let (tx, _rx) = unbounded();
		let t = Themes::new(d.path().to_path_buf(), Some(kit), tx);
		let th = t.create("Watch me", "blank").unwrap();
		std::thread::sleep(Duration::from_millis(900));
		let index = th.dir.join("src/index.tsx");
		std::fs::write(&index, std::fs::read_to_string(&index).unwrap().replace(">Halo<", ">Watched<")).unwrap();
		let t0 = Instant::now();
		while t.info(&th.id).unwrap().version < 2 {
			assert!(t0.elapsed() < Duration::from_secs(6), "no rebuild after a save");
			std::thread::sleep(Duration::from_millis(50));
		}
		assert!(std::fs::read_to_string(th.dir.join("dist/theme.js")).unwrap().contains("Watched"));
	}
}
