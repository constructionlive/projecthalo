//! Halo: one thread for everything, summoned with a tap of right ⌘ from anywhere.
//!
//! Two windows over one engine ([`halo_core::Halo`]): the Sky (the whole
//! picture) and the Summon panel (a quick word from any app), plus a menu bar
//! icon, a Dock badge and notifications ([`presence`]). Every engine event is
//! forwarded to both windows as `halo`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(debug_assertions)]
mod devbridge;
mod hotkey;
mod presence;
mod setup;
mod updates;
mod voice;

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cc_agent::Toolbox;
use cc_agent::channel::Access;
use halo_core::stars::{StarConfig, ToolboxFor};
use halo_core::{ChannelRunner, Halo, HaloConfig, HaloEvent, HaloState, Store};
use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::hotkey::SummonKey;
use crate::presence::Presence;
use crate::setup::AppSettings;

struct AppState {
	halo: Halo,
	runner: Arc<ChannelRunner>,
	/// The model Command Center picked, for its engine.
	setup_engine: (halo_core::Engine, String),
	/// Halo's data folder.
	root: PathBuf,
	settings: Mutex<AppSettings>,
	presence: Mutex<Option<Presence>>,
	voice: voice::VoiceHandle,
	/// Each engine's models, asked of its CLI once per run (it takes seconds).
	models: Mutex<std::collections::HashMap<halo_core::Engine, Vec<ModelChoice>>>,
}

/// A model an engine's CLI offers.
#[derive(Clone, Serialize)]
struct ModelChoice {
	/// What goes to the CLI's model flag; empty = its own default.
	id: String,
	label: String,
	note: String,
}

/// The models an engine can run, for the launch panel.
#[tauri::command]
async fn engine_models(app: AppHandle, engine: String) -> Result<Vec<ModelChoice>, String> {
	let engine = halo_core::Engine::from_key(&engine).ok_or_else(|| format!("unknown engine {engine}"))?;
	let state = app.state::<AppState>();
	if let Some(m) = state.models.lock().ok().and_then(|m| m.get(&engine).cloned()) {
		return Ok(m);
	}
	let exe = cc_agent::channel::find_exe(engine.channel()).ok_or_else(|| format!("{} isn't installed on this computer.", engine.name()))?;
	let list: Vec<ModelChoice> = cc_agent::channel::models(engine.channel(), &exe)?.into_iter().map(|m| ModelChoice { id: m.id, label: m.label, note: m.note }).collect();
	if let Ok(mut m) = state.models.lock() {
		m.insert(engine, list.clone());
	}
	Ok(list)
}

#[tauri::command]
fn get_state(state: tauri::State<AppState>) -> HaloState {
	state.halo.state()
}

#[tauri::command]
fn ask(state: tauri::State<AppState>, text: String) {
	state.halo.ask(&text);
}

#[tauri::command]
fn tell_star(state: tauri::State<AppState>, id: String, text: String) -> Result<String, String> {
	state.halo.stars().tell(&id, &text)
}

#[tauri::command]
fn stop_star(state: tauri::State<AppState>, id: String) -> Result<String, String> {
	state.halo.stars().stop(&id)
}

/// The Garage: what everything runs on and how far it may reach.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Garage {
	engine: halo_core::Engine,
	access: Access,
	/// Engines whose CLI is on this computer.
	installed: Vec<halo_core::Engine>,
}

#[tauri::command]
fn get_garage(state: tauri::State<AppState>) -> Garage {
	let access = state.settings.lock().map(|s| s.access).unwrap_or_default();
	Garage { engine: state.halo.state().engine, access, installed: state.runner.installed() }
}

#[tauri::command]
fn set_garage(state: tauri::State<AppState>, engine: Option<String>, access: Option<Access>) -> Result<Garage, String> {
	let engine = engine.as_deref().map(|k| halo_core::Engine::from_key(k).ok_or_else(|| format!("unknown engine {k}"))).transpose()?;
	if let Ok(mut s) = state.settings.lock() {
		if let Some(e) = engine {
			s.engine = Some(e);
		}
		if let Some(a) = access {
			s.access = a;
		}
		s.save(&state.root);
		apply_garage(&state.halo, &state.runner, &state.setup_engine, &s);
	}
	Ok(get_garage(state))
}

/// Puts the Garage's picks into effect (at start, and whenever they change).
fn apply_garage(halo: &Halo, runner: &ChannelRunner, setup: &(halo_core::Engine, String), s: &AppSettings) {
	runner.set_access(s.access);
	if let Some(e) = s.engine {
		// Command Center's model only means something on its own engine.
		halo.set_engine(e, if e == setup.0 { setup.1.clone() } else { String::new() });
	}
}

/// Lights a star directly (no need to ask Halo first), in `workspace` (an id),
/// else the one in front; `"none"` gives it a folder of its own.
#[tauri::command]
fn spawn_star(state: tauri::State<AppState>, goal: String, title: Option<String>, engine: Option<String>, model: Option<String>, workspace: Option<String>) -> Result<halo_core::StarSnapshot, String> {
	let goal = goal.trim();
	if goal.is_empty() {
		return Err("Say what the star should do.".into());
	}
	let title = title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).unwrap_or_else(|| title_from(goal));
	let engine = match engine.as_deref() {
		Some(k) if !k.is_empty() => Some(halo_core::Engine::from_key(k).ok_or_else(|| format!("unknown engine {k}"))?),
		_ => None,
	};
	let ws = state.halo.workspaces();
	let workspace = match workspace.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
		Some("none") => None,
		Some(id) => Some(ws.get(id).ok_or_else(|| format!("there is no workspace {id}"))?),
		None => ws.current(),
	};
	// A model only means something with the engine it was picked for.
	let model = model.map(|m| m.trim().to_string()).filter(|_| engine.is_some());
	Ok(state.halo.stars().spawn_in(&title, goal, engine, model, workspace.as_ref()))
}

/// Opens a folder as a workspace (an arena) and brings it to the front.
#[tauri::command]
fn open_workspace(state: tauri::State<AppState>, path: String) -> Result<halo_core::WorkspaceInfo, String> {
	state.halo.open_workspace(std::path::Path::new(&path))
}

/// The macOS folder picker, then [`open_workspace`]. `None`: the person cancelled.
#[tauri::command]
async fn pick_workspace(app: AppHandle) -> Result<Option<halo_core::WorkspaceInfo>, String> {
	use tauri_plugin_dialog::DialogExt;
	let Some(folder) = app.dialog().file().set_title("Open a workspace").blocking_pick_folder() else { return Ok(None) };
	let path = folder.into_path().map_err(|e| e.to_string())?;
	app.state::<AppState>().halo.open_workspace(&path).map(Some)
}

#[tauri::command]
fn close_workspace(state: tauri::State<AppState>, id: String) -> Result<(), String> {
	state.halo.close_workspace(&id)
}

/// A shell in `workspace` (an id), else the one in front; `"none"`: the home folder.
#[tauri::command]
fn terminal_open(state: tauri::State<AppState>, workspace: Option<String>, cols: u16, rows: u16) -> Result<halo_core::TermSnapshot, String> {
	let ws = state.halo.workspaces();
	let workspace = match workspace.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
		Some("none") => None,
		Some(id) => Some(ws.get(id).ok_or_else(|| format!("there is no workspace {id}"))?),
		None => ws.current(),
	};
	state.halo.terminals().open(workspace.as_ref(), cols, rows)
}

#[tauri::command]
fn terminal_write(state: tauri::State<AppState>, id: String, data: String) -> Result<(), String> {
	state.halo.terminals().write(&id, data.as_bytes())
}

#[tauri::command]
fn terminal_resize(state: tauri::State<AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
	state.halo.terminals().resize(&id, cols, rows)
}

#[tauri::command]
fn terminal_close(state: tauri::State<AppState>, id: String) -> Result<(), String> {
	state.halo.terminals().close(&id)
}

/// Its output so far (base64: it's bytes, not always whole UTF-8) and where
/// that ends in its whole output, for a view opening late.
#[tauri::command]
fn terminal_replay(state: tauri::State<AppState>, id: String) -> Result<serde_json::Value, String> {
	use base64::Engine as _;
	let (at, bytes) = state.halo.terminals().replay(&id).ok_or_else(|| format!("there is no terminal {id}"))?;
	Ok(serde_json::json!({ "at": at, "data": base64::engine::general_purpose::STANDARD.encode(bytes) }))
}

/// Terminal output to the windows, at once; when output floods in, what
/// arrives within a few milliseconds goes as one event per terminal.
/// Another listener for each terminal-output event's JSON (the dev bridge, in debug builds).
type AlsoTo = Option<Box<dyn Fn(&str) + Send>>;

fn forward_terminal_output(halo: &Halo, app: AppHandle, also: AlsoTo) {
	use base64::Engine as _;
	let (tx, rx) = crossbeam_channel::unbounded::<(String, u64, Vec<u8>)>();
	halo.terminals().set_sink(Arc::new(move |id: &str, at: u64, bytes: &[u8]| {
		let _ = tx.send((id.to_string(), at, bytes.to_vec()));
	}));
	let _ = std::thread::Builder::new().name("halo-term-out".into()).spawn(move || {
		while let Ok(first) = rx.recv() {
			// A keystroke's echo goes at once; only a flood (a build log, cat of a big file)
			// waits a moment so it travels as a few big events instead of thousands.
			if first.2.len() >= 4096 {
				std::thread::sleep(Duration::from_millis(6));
			}
			// Each terminal's chunks arrive in order and back to back: one event from where the first starts.
			let mut by_id: Vec<(String, u64, Vec<u8>)> = Vec::new();
			for (id, at, bytes) in std::iter::once(first).chain(rx.try_iter()) {
				match by_id.iter_mut().find(|(i, ..)| *i == id) {
					Some((_, _, b)) => b.extend_from_slice(&bytes),
					None => by_id.push((id, at, bytes)),
				}
			}
			for (id, at, bytes) in by_id {
				let payload = serde_json::json!({ "id": id, "at": at, "data": base64::engine::general_purpose::STANDARD.encode(bytes) });
				if let Some(also) = &also {
					also(&serde_json::json!({ "type": "termData", "id": payload["id"], "at": at, "data": payload["data"] }).to_string());
				}
				let _ = app.emit("term", payload);
			}
		}
	});
}

/// macOS's usual app menu, minus Close Window: ⌘W belongs to the page (it
/// closes a terminal car). Edit stays, so ⌘C ⌘V ⌘Z work in every text field.
#[cfg(target_os = "macos")]
fn app_menu(app: &AppHandle) -> tauri::Result<()> {
	use tauri::menu::{Menu, PredefinedMenuItem as P, Submenu};
	let halo = Submenu::with_items(app, "Halo", true, &[&P::about(app, None, None)?, &P::separator(app)?, &P::hide(app, None)?, &P::hide_others(app, None)?, &P::show_all(app, None)?, &P::separator(app)?, &P::quit(app, None)?])?;
	let edit = Submenu::with_items(app, "Edit", true, &[&P::undo(app, None)?, &P::redo(app, None)?, &P::separator(app)?, &P::cut(app, None)?, &P::copy(app, None)?, &P::paste(app, None)?, &P::select_all(app, None)?])?;
	let window = Submenu::with_items(app, "Window", true, &[&P::minimize(app, None)?, &P::maximize(app, None)?, &P::fullscreen(app, None)?])?;
	app.set_menu(Menu::with_items(app, &[&halo, &edit, &window])?)?;
	Ok(())
}

/// Is there a newer Halo? (Also asked on its own at start and every few hours.)
#[tauri::command]
async fn update_check(app: AppHandle) -> Result<Option<updates::UpdateInfo>, String> {
	updates::check(&app).await
}

/// Downloads, verifies and installs the update found, then restarts Halo.
#[tauri::command]
async fn update_install(app: AppHandle) -> Result<(), String> {
	updates::install(&app).await
}

/// The version running.
#[tauri::command]
fn app_version(app: AppHandle) -> String {
	app.package_info().version.to_string()
}

/// Where the theme kit is: beside the app in its bundle (Resources/kit), or
/// staged in the source tree for a debug build, or wherever HALO_KIT_DIR says.
fn kit_dir() -> Option<PathBuf> {
	let has = |p: &Path| p.join("bin/esbuild").is_file();
	if let Some(p) = std::env::var_os("HALO_KIT_DIR").map(PathBuf::from).filter(|p| has(p)) {
		return Some(p);
	}
	let exe = std::env::current_exe().ok()?;
	let bundled = exe.parent()?.parent()?.join("Resources/kit");
	if has(&bundled) {
		return Some(bundled);
	}
	let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("kit");
	(cfg!(debug_assertions) && has(&dev)).then_some(dev)
}

/// `halo --theme-build <theme folder>`: checks that it builds and prints what's
/// wrong; exits 0 when it does. It builds into the theme's `.halo/check`, never
/// its `dist/`: the app's own rebuild (on every save) is the only one writing that.
fn theme_build_cli(dir: Option<&str>) -> i32 {
	let Some(dir) = dir.map(PathBuf::from).and_then(|d| std::fs::canonicalize(d).ok()) else {
		eprintln!("usage: halo --theme-build <theme folder>");
		return 2;
	};
	let Some(kit) = kit_dir() else {
		eprintln!("The theme kit isn't in this copy of Halo.");
		return 2;
	};
	let t0 = std::time::Instant::now();
	match halo_core::themes::build_dir(&kit, &dir, &dir.join(".halo/check")) {
		Ok(()) => {
			println!("Built in {} ms. Halo reloads the theme by itself.", t0.elapsed().as_millis());
			0
		}
		Err(e) => {
			eprintln!("{e}");
			1
		}
	}
}

/// Debug builds: the window leaves a note for a test to read. Release builds: nothing.
#[tauri::command]
fn debug_note(key: String, value: String) {
	#[cfg(debug_assertions)]
	if let Ok(mut n) = devbridge::NOTES.lock() {
		n.insert(key, value);
	}
	#[cfg(not(debug_assertions))]
	let _ = (key, value);
}

#[tauri::command]
fn theme_create(state: tauri::State<AppState>, name: String, from: String) -> Result<halo_core::ThemeInfo, String> {
	state.halo.themes().create(&name, &from)
}

#[tauri::command]
fn theme_build(state: tauri::State<AppState>, id: String) -> Result<halo_core::ThemeInfo, String> {
	state.halo.themes().build(&id)
}

#[tauri::command]
fn theme_undo(state: tauri::State<AppState>, id: String) -> Result<halo_core::ThemeInfo, String> {
	state.halo.themes().undo(&id)
}

#[tauri::command]
fn theme_delete(state: tauri::State<AppState>, id: String) -> Result<(), String> {
	state.halo.themes().delete(&id)
}

/// An agent that changes the theme as the person asks; it rebuilds as the agent saves.
#[tauri::command]
fn theme_customize(state: tauri::State<AppState>, id: String, request: String, engine: Option<String>, model: Option<String>) -> Result<halo_core::StarSnapshot, String> {
	if request.trim().is_empty() {
		return Err("Say what to change.".into());
	}
	let engine = engine.as_deref().filter(|k| !k.is_empty()).map(|k| halo_core::Engine::from_key(k).ok_or_else(|| format!("unknown engine {k}"))).transpose()?;
	state.halo.customize_theme(&id, &request, engine, model.filter(|m| !m.is_empty()))
}

/// `halotheme://localhost/<id>/<path>`: a theme's build, for its sandboxed frame.
/// Only files inside that theme's dist/; any origin may read them (the frame has none).
fn serve_theme(halo: &Halo, uri: &str) -> tauri::http::Response<Vec<u8>> {
	let path = uri.split_once("://").map(|(_, r)| r).unwrap_or(uri);
	let path = path.split(['?', '#']).next().unwrap_or("");
	let path = path.strip_prefix("localhost/").unwrap_or(path);
	let (id, rest) = path.split_once('/').unwrap_or((path, ""));
	let rest = percent_decode(rest);
	let found = halo.themes().asset(id, &rest).and_then(|p| std::fs::read(&p).ok().map(|b| (p, b)));
	let builder = tauri::http::Response::builder().header("Access-Control-Allow-Origin", "*").header("Cache-Control", "no-cache");
	match found {
		Some((p, body)) => builder.header("Content-Type", mime(&p)).body(body),
		None => builder.status(404).body(Vec::new()),
	}
	.unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

fn mime(p: &Path) -> &'static str {
	match p.extension().map(|e| e.to_string_lossy().to_lowercase()).as_deref() {
		Some("js") => "text/javascript",
		Some("css") => "text/css",
		Some("json") => "application/json",
		Some("png") => "image/png",
		Some("jpg" | "jpeg") => "image/jpeg",
		Some("webp") => "image/webp",
		Some("svg") => "image/svg+xml",
		Some("mp4") => "video/mp4",
		Some("webm") => "video/webm",
		Some("woff2") => "font/woff2",
		Some("woff") => "font/woff",
		Some("glb") => "model/gltf-binary",
		_ => "application/octet-stream",
	}
}

fn percent_decode(s: &str) -> String {
	let b = s.as_bytes();
	let mut out = Vec::with_capacity(b.len());
	let mut i = 0;
	while i < b.len() {
		if b[i] == b'%'
			&& i + 2 < b.len()
			&& let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
		{
			out.push(v);
			i += 3;
			continue;
		}
		out.push(b[i]);
		i += 1;
	}
	String::from_utf8_lossy(&out).into_owned()
}

/// The workspace in front of the person: Halo assumes it unless told otherwise.
#[tauri::command]
fn front_workspace(state: tauri::State<AppState>, id: Option<String>) -> Result<(), String> {
	state.halo.front_workspace(id.as_deref())
}

/// A few words of the goal, for a star the person didn't name.
fn title_from(goal: &str) -> String {
	let words: Vec<&str> = goal.split_whitespace().take(5).collect();
	let t = words.join(" ");
	let t = t.trim_end_matches(['.', ',', ':', ';']);
	let mut c = t.chars();
	c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

#[tauri::command]
fn voice_status(state: tauri::State<AppState>) -> voice::VoiceStatus {
	state.voice.status()
}

/// Starts listening (the mic button). `send`: ask Halo as soon as the words are in.
#[tauri::command]
fn voice_start(state: tauri::State<AppState>, send: bool) {
	state.voice.send(voice::VoiceCmd::Start { send });
}

#[tauri::command]
fn voice_stop(state: tauri::State<AppState>) {
	state.voice.send(voice::VoiceCmd::Stop);
}

#[tauri::command]
fn voice_cancel(state: tauri::State<AppState>) {
	state.voice.send(voice::VoiceCmd::Cancel);
}

#[tauri::command]
fn cancel_halo(state: tauri::State<AppState>) {
	state.halo.cancel();
}

#[tauri::command]
fn hide_summon(app: AppHandle) {
	if let Some(w) = app.get_webview_window("summon") {
		let _ = w.hide();
	}
}

/// Fits the Summon window to its panel, so no empty window blocks clicks below it.
#[tauri::command]
fn fit_summon(app: AppHandle, height: f64) {
	if let Some(w) = app.get_webview_window("summon") {
		let _ = w.set_size(LogicalSize::new(860.0, height.clamp(160.0, 760.0)));
	}
}

/// Brings up the Sky, optionally with a star selected.
#[tauri::command]
fn open_sky(app: AppHandle, star_id: Option<String>) {
	hide_summon(app.clone());
	if let Some(w) = app.get_webview_window("sky") {
		let _ = w.show();
		let _ = w.unminimize();
		let _ = w.set_focus();
	}
	if let Some(id) = star_id {
		let _ = app.emit_to("sky", "select-star", id);
	}
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotkeyStatus {
	key: SummonKey,
	label: &'static str,
	/// macOS lets Halo see key presses.
	allowed: bool,
	/// The watcher is running.
	listening: bool,
}

#[tauri::command]
fn hotkey_status() -> HotkeyStatus {
	let key = hotkey::key();
	HotkeyStatus { key, label: key.label(), allowed: hotkey::input_monitoring_allowed(), listening: hotkey::listening() }
}

#[tauri::command]
fn open_input_monitoring() {
	hotkey::request_input_monitoring();
	hotkey::open_input_monitoring_settings();
}

#[tauri::command]
fn set_summon_key(app: AppHandle, key: SummonKey) {
	apply_summon_key(&app, key);
}

/// Switches the summon key now, remembers it, and tells the menu and windows.
fn apply_summon_key(app: &AppHandle, key: SummonKey) {
	hotkey::set_key(key);
	let state = app.state::<AppState>();
	if let Ok(mut s) = state.settings.lock() {
		s.summon_key = key;
		s.save(&state.root);
	}
	if let Ok(p) = state.presence.lock()
		&& let Some(p) = p.as_ref()
	{
		p.refresh_key();
	}
	let _ = app.emit("hotkey", hotkey_status());
}

/// A file a star made, in its folder.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StarFile {
	/// Relative to the star's folder.
	name: String,
	size: u64,
	modified: u64,
}

fn star_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
	if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
		return Err(format!("bad star id {id}"));
	}
	Ok(root.join("stars").join(id).join("work"))
}

#[tauri::command]
fn star_files(state: tauri::State<AppState>, id: String) -> Result<Vec<StarFile>, String> {
	list_star_files(&state.root, &id)
}

/// A star's files, newest first.
fn list_star_files(root: &Path, id: &str) -> Result<Vec<StarFile>, String> {
	let dir = star_dir(root, id)?;
	let mut out = Vec::new();
	collect_files(&dir, &dir, 0, &mut out);
	out.sort_by_key(|f| std::cmp::Reverse(f.modified));
	Ok(out)
}

fn collect_files(base: &Path, dir: &Path, depth: usize, out: &mut Vec<StarFile>) {
	let Ok(rd) = std::fs::read_dir(dir) else { return };
	for e in rd.flatten() {
		let name = e.file_name().to_string_lossy().into_owned();
		if name.starts_with('.') || out.len() >= 200 {
			continue;
		}
		let path = e.path();
		let Ok(meta) = e.metadata() else { continue };
		if meta.is_dir() {
			if depth < 3 {
				collect_files(base, &path, depth + 1, out);
			}
		} else {
			let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
			out.push(StarFile { name: path.strip_prefix(base).unwrap_or(&path).to_string_lossy().into_owned(), size: meta.len(), modified });
		}
	}
}

/// Opens a star's file (or its folder) with the Mac's default app, or shows it in Finder.
#[tauri::command]
fn open_star_file(state: tauri::State<AppState>, id: String, name: Option<String>, reveal: bool) -> Result<(), String> {
	let dir = star_dir(&state.root, &id)?;
	let path = match name {
		Some(n) if Path::new(&n).components().all(|c| matches!(c, Component::Normal(_))) => dir.join(n),
		Some(n) => return Err(format!("bad file name {n}")),
		None => dir,
	};
	if !path.exists() {
		return Err(format!("{} isn't there any more", path.display()));
	}
	let mut cmd = std::process::Command::new("open");
	if reveal {
		cmd.arg("-R");
	}
	cmd.arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Shows the Summon panel near the top of the screen the pointer is on, or hides it.
fn toggle_summon(app: &AppHandle) {
	let Some(w) = app.get_webview_window("summon") else { return };
	if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
		let _ = w.hide();
		return;
	}
	show_summon(app);
}

/// Shows the Summon panel near the top of the screen the pointer is on.
fn show_summon(app: &AppHandle) {
	let Some(w) = app.get_webview_window("summon") else { return };
	let monitor = app.cursor_position().ok().and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten()).or_else(|| w.primary_monitor().ok().flatten());
	if let (Some(m), Ok(size)) = (monitor, w.outer_size()) {
		let x = m.position().x + (m.size().width as i32 - size.width as i32) / 2;
		let y = m.position().y + (m.size().height as f64 * 0.12) as i32;
		let _ = w.set_position(PhysicalPosition::new(x, y));
	}
	let _ = w.show();
	let _ = w.set_focus();
	let _ = app.emit_to("summon", "summon-shown", ());
}

fn init_logging() {
	let mut builder = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
	if let Some(dir) = dirs::home_dir().map(|h| h.join("Library/Logs/Halo"))
		&& std::fs::create_dir_all(&dir).is_ok()
		&& let Ok(file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("halo.log"))
	{
		builder.target(env_logger::Target::Pipe(Box::new(file)));
	}
	builder.init();
}

fn main() {
	// Claude Code / Codex / OpenCode start us as their MCP server: pipe to the running app.
	let args: Vec<String> = std::env::args().collect();
	if args.get(1).map(String::as_str) == Some(cc_agent::channel::BRIDGE_ARG) {
		std::process::exit(cc_agent::channel::run_bridge(args.get(2).map(String::as_str).unwrap_or("")));
	}
	// A theme's agent builds it this way and reads the errors.
	if args.get(1).map(String::as_str) == Some("--theme-build") {
		std::process::exit(theme_build_cli(args.get(2).map(String::as_str)));
	}
	init_logging();
	log::info!("Halo {} starting", env!("CARGO_PKG_VERSION"));

	let setup = Arc::new(setup::Setup::load());
	// Voice first: Halo's tools transcribe with it. What hold-to-talk hears goes
	// straight to Halo; the mic button's words fill the ask line.
	let halo_cell: Arc<std::sync::OnceLock<Halo>> = Arc::default();
	let voice_app: Arc<Mutex<Option<AppHandle>>> = Arc::default();
	let voice = {
		let (app_slot, halo_cell) = (voice_app.clone(), halo_cell.clone());
		voice::start(move |out| {
			if let voice::VoiceOut::Heard { text, send: true } = &out
				&& let Some(halo) = halo_cell.get()
			{
				halo.ask(text);
			}
			if let Ok(slot) = app_slot.lock()
				&& let Some(app) = slot.as_ref()
			{
				let _ = app.emit("voice", &out);
			}
		})
	};
	let toolbox_for: ToolboxFor = {
		let transcriber = voice.transcriber();
		Arc::new(move |dir| Toolbox::new(dir, Some(transcriber.clone())))
	};
	let (events_tx, events_rx) = crossbeam_channel::unbounded::<HaloEvent>();
	// HALO_HOME: a separate data folder (test runs). HALO_STALL_SECS: quiet this long = stalled.
	let root = std::env::var_os("HALO_HOME").map(PathBuf::from).unwrap_or_else(Store::default_root);
	log::info!("data in {}", root.display());
	let settings = AppSettings::load(&root);
	hotkey::set_key(settings.summon_key);
	let store = Arc::new(Store::new(root.clone()));
	let mut stars = StarConfig { engine: setup.engine, model: setup.model.clone(), ..Default::default() };
	if let Some(secs) = std::env::var("HALO_STALL_SECS").ok().and_then(|v| v.parse::<u64>().ok()) {
		stars.stall_after = Duration::from_secs(secs);
		stars.watch_every = Duration::from_secs(2);
	}
	let cfg = HaloConfig { engine: setup.engine, model: setup.model.clone(), user: setup.user.clone(), stars, terminals: Default::default(), kit: kit_dir(), exe: std::env::current_exe().ok() };
	let runner = Arc::new(ChannelRunner::new(setup.user.clone()));
	let setup_engine = (setup.engine, setup.model.clone());
	let halo = Halo::start(cfg, runner.clone(), store, toolbox_for, events_tx);
	apply_garage(&halo, &runner, &setup_engine, &settings);

	let _ = halo_cell.set(halo.clone());
	let halo_for_setup = halo.clone();
	let fallback = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Space);
	let app = tauri::Builder::default()
		.plugin(tauri_plugin_notification::init())
		.register_uri_scheme_protocol("halotheme", {
			let halo = halo.clone();
			move |_ctx, request| serve_theme(&halo, &request.uri().to_string())
		})
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_updater::Builder::new().build())
		.plugin(tauri_plugin_process::init())
		.manage(updates::Pending::default())
		.plugin(
			tauri_plugin_global_shortcut::Builder::new()
				.with_handler(move |app, shortcut, event| {
					if shortcut == &fallback && event.state() == ShortcutState::Pressed {
						toggle_summon(app);
					}
				})
				.build(),
		)
		.manage(AppState { halo: halo.clone(), runner, setup_engine, root, settings: Mutex::new(settings), presence: Mutex::new(None), voice, models: Mutex::default() })
		.invoke_handler(tauri::generate_handler![
			get_state,
			ask,
			tell_star,
			stop_star,
			cancel_halo,
			hide_summon,
			fit_summon,
			open_sky,
			hotkey_status,
			open_input_monitoring,
			set_summon_key,
			star_files,
			open_star_file,
			spawn_star,
			engine_models,
			terminal_open,
			terminal_write,
			terminal_resize,
			terminal_close,
			terminal_replay,
			update_check,
			update_install,
			theme_create,
			theme_build,
			theme_undo,
			theme_delete,
			theme_customize,
			debug_note,
			app_version,
			open_workspace,
			pick_workspace,
			close_workspace,
			front_workspace,
			get_garage,
			set_garage,
			voice_status,
			voice_start,
			voice_stop,
			voice_cancel
		])
		.setup(move |app| {
			#[cfg(target_os = "macos")]
			if let Err(e) = app_menu(app.handle()) {
				log::warn!("app menu: {e}");
			}
			if let Ok(mut slot) = voice_app.lock() {
				*slot = Some(app.handle().clone());
			}
			match Presence::new(app.handle(), halo_for_setup.stars().list()) {
				Ok(p) => *app.state::<AppState>().presence.lock().expect("presence lock") = Some(p),
				Err(e) => log::warn!("menu bar icon: {e}"),
			}
			#[cfg(debug_assertions)]
			let fan = devbridge::Fanout::default();
			#[cfg(debug_assertions)]
			if let Some(port) = std::env::var("HALO_DEV_BRIDGE").ok().and_then(|p| p.parse::<u16>().ok()) {
				devbridge::start(port, app.handle().clone(), halo_for_setup.clone(), fan.clone());
			}
			#[cfg(debug_assertions)]
			let also: AlsoTo = {
				let fan = fan.clone();
				Some(Box::new(move |json: &str| fan.send(json)))
			};
			#[cfg(not(debug_assertions))]
			let also: AlsoTo = None;
			forward_terminal_output(&halo_for_setup, app.handle().clone(), also);
			updates::watch(app.handle().clone());
			let handle = app.handle().clone();
			let _ = std::thread::Builder::new().name("halo-events".into()).spawn(move || {
				for ev in events_rx {
					let _ = handle.emit("halo", &ev);
					if let HaloEvent::Star { star } = &ev
						&& let Ok(mut p) = handle.state::<AppState>().presence.lock()
						&& let Some(p) = p.as_mut()
					{
						p.on_star(star);
					}
					#[cfg(debug_assertions)]
					if let Ok(json) = serde_json::to_string(&ev) {
						fan.send(&json);
					}
				}
			});
			// Tap: summon. Hold: talk to Halo (the panel shows what it hears); let go: it's asked.
			let (h1, h2, h3) = (app.handle().clone(), app.handle().clone(), app.handle().clone());
			hotkey::watch(
				Arc::new(move || {
					let h = h1.clone();
					let _ = h1.run_on_main_thread(move || toggle_summon(&h));
				}),
				Arc::new(move || {
					let h = h2.clone();
					let _ = h2.run_on_main_thread(move || {
						show_summon(&h);
						let _ = h.emit_to("summon", "voice-hold", true);
					});
					h2.state::<AppState>().voice.send(voice::VoiceCmd::Start { send: true });
				}),
				Arc::new(move || {
					h3.state::<AppState>().voice.send(voice::VoiceCmd::Stop);
					let _ = h3.emit_to("summon", "voice-hold", false);
				}),
			);
			// The watcher starts once macOS allows it: keep the menu and windows in step.
			let handle = app.handle().clone();
			let _ = std::thread::Builder::new().name("halo-hotkey-status".into()).spawn(move || {
				let mut last = None;
				loop {
					let now = (hotkey::listening(), hotkey::input_monitoring_allowed());
					if last != Some(now) {
						last = Some(now);
						if let Ok(p) = handle.state::<AppState>().presence.lock()
							&& let Some(p) = p.as_ref()
						{
							p.refresh_key();
						}
						let _ = handle.emit("hotkey", hotkey_status());
					}
					std::thread::sleep(Duration::from_secs(2));
				}
			});
			if let Err(e) = app.global_shortcut().register(fallback) {
				log::warn!("could not register ⌘⇧Space: {e}");
			}
			Ok(())
		})
		.on_window_event(|window, event| match (window.label(), event) {
			("summon", WindowEvent::Focused(false)) => {
				let _ = window.hide();
			}
			("sky", WindowEvent::CloseRequested { api, .. }) => {
				// Halo keeps running (stars too), in the menu bar.
				api.prevent_close();
				// Hidden while full screen, macOS leaves its Space behind: an empty
				// black screen. Leave full screen first, then hide once it's done.
				if window.is_fullscreen().unwrap_or(false) {
					let _ = window.set_fullscreen(false);
					let w = window.clone();
					let _ = std::thread::Builder::new().name("sky-hide".into()).spawn(move || {
						std::thread::sleep(Duration::from_millis(900));
						let _ = w.hide();
					});
				} else {
					let _ = window.hide();
				}
			}
			_ => {}
		})
		.build(tauri::generate_context!())
		.expect("Halo failed to start");

	app.run(move |app, event| match event {
		RunEvent::Exit => {
			halo.shutdown();
			// Free the speech model now, before the exit handlers tear down the GPU device.
			app.state::<AppState>().voice.shutdown();
		}
		#[cfg(target_os = "macos")]
		RunEvent::Reopen { .. } => open_sky(app.clone(), None),
		_ => {}
	});
}
