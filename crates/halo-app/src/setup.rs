//! What Halo starts with: the person's name and engine, read from Command
//! Center's settings so nothing has to be set up twice.

use std::path::PathBuf;

use halo_core::Engine;
use serde::Deserialize;

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct CcSettings {
	user: String,
	model: String,
}

pub struct Setup {
	pub user: String,
	pub engine: Engine,
	pub model: String,
}

impl Setup {
	pub fn load() -> Self {
		let path = dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("Command Center/settings.json");
		let cc: CcSettings = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
		// "claude:opus" → Claude Code with opus; cloud and local models aren't channels, so Claude Code.
		let (engine, model) = match cc.model.split_once(':') {
			Some((k, m)) => match Engine::from_key(k) {
				Some(e) => (e, m.to_string()),
				None => (Engine::Claude, String::new()),
			},
			None => (Engine::Claude, String::new()),
		};
		// For test runs: HALO_ENGINE=claude|codex|opencode, HALO_MODEL=haiku.
		let engine = std::env::var("HALO_ENGINE").ok().and_then(|k| Engine::from_key(&k)).unwrap_or(engine);
		let model = std::env::var("HALO_MODEL").unwrap_or(model);
		Self { user: cc.user, engine, model }
	}
}

/// Halo's own settings, in its data folder.
#[derive(Debug, Clone, Default, serde::Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
	pub summon_key: crate::hotkey::SummonKey,
	/// The Garage: the engine everything runs on (unset = Command Center's choice)…
	pub engine: Option<Engine>,
	/// …and how far it may reach without asking.
	pub access: cc_agent::channel::Access,
}

impl AppSettings {
	fn path(root: &std::path::Path) -> PathBuf {
		root.join("settings.json")
	}

	pub fn load(root: &std::path::Path) -> Self {
		std::fs::read(Self::path(root)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
	}

	pub fn save(&self, root: &std::path::Path) {
		if let Ok(json) = serde_json::to_vec_pretty(self)
			&& let Err(e) = std::fs::write(Self::path(root), json)
		{
			log::warn!("could not save settings: {e}");
		}
	}
}
