//! Updates. Halo asks its feed (`halo/latest.json` on R2) for a newer version
//! at start and every few hours and tells the windows. On the person's word it
//! downloads the update, checks its signature against the public key in
//! tauri.conf.json (an update that fails the check is never installed),
//! installs it over this copy and restarts.
//!
//! `HALO_UPDATE_URL` points it at another feed (tests); `HALO_NO_UPDATE_CHECK`
//! turns the background check off. Debug builds only check a feed given that way.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
const FIRST_CHECK: Duration = Duration::from_secs(20);

/// A newer version, as the windows show it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
	pub version: String,
	pub current: String,
	pub date: Option<String>,
	pub notes: String,
	/// Can't be skipped or put off (the feed says so).
	pub critical: bool,
}

/// The update found last, kept for installing.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

fn feed() -> Option<String> {
	std::env::var("HALO_UPDATE_URL").ok().filter(|u| !u.trim().is_empty())
}

/// Whether to look on our own: never in tests that say so, and debug builds only against a test feed.
fn auto_check() -> bool {
	std::env::var_os("HALO_NO_UPDATE_CHECK").is_none() && (feed().is_some() || !cfg!(debug_assertions))
}

/// Asks the feed. `None`: this is the newest.
pub async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<Option<UpdateInfo>, String> {
	let mut builder = app.updater_builder().timeout(Duration::from_secs(30));
	if let Some(url) = feed() {
		builder = builder.endpoints(vec![url.parse().map_err(|e| format!("HALO_UPDATE_URL: {e}"))?]).map_err(|e| e.to_string())?;
	}
	let update = builder.build().map_err(|e| e.to_string())?.check().await.map_err(|e| format!("Couldn't check for updates: {e}"))?;
	let Some(update) = update else {
		*app.state::<Pending>().0.lock().expect("pending lock") = None;
		return Ok(None);
	};
	let info = UpdateInfo {
		version: update.version.clone(),
		current: update.current_version.clone(),
		date: update.date.map(|d| d.to_string()),
		notes: update.body.clone().unwrap_or_default(),
		critical: update.raw_json.get("critical").and_then(serde_json::Value::as_bool).unwrap_or(false),
	};
	*app.state::<Pending>().0.lock().expect("pending lock") = Some(update);
	Ok(Some(info))
}

/// Downloads (telling the windows how far it is), verifies, installs, restarts.
pub async fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
	let update = app.state::<Pending>().0.lock().expect("pending lock").take().ok_or("No update to install: check again.")?;
	let mut done = 0usize;
	let progress = app.clone();
	let finished = app.clone();
	update
		.download_and_install(
			move |chunk, total| {
				done += chunk;
				let _ = progress.emit("update-progress", serde_json::json!({ "done": done, "total": total }));
			},
			move || {
				let _ = finished.emit("update-installed", ());
			},
		)
		.await
		.map_err(|e| format!("The update couldn't be installed: {e}"))?;
	log::info!("update installed; restarting");
	app.restart();
}

/// Looks now and then on its own, and tells the windows when there's something new.
pub fn watch<R: Runtime>(app: AppHandle<R>) {
	if !auto_check() {
		return;
	}
	tauri::async_runtime::spawn(async move {
		tokio_sleep(FIRST_CHECK).await;
		loop {
			match check(&app).await {
				Ok(Some(info)) => {
					log::info!("update available: {} (have {})", info.version, info.current);
					let _ = app.emit("update-available", &info);
				}
				Ok(None) => {}
				Err(e) => log::warn!("{e}"),
			}
			tokio_sleep(CHECK_EVERY).await;
		}
	});
}

async fn tokio_sleep(d: Duration) {
	let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}
