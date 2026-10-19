//! Halo on the desktop when its windows are closed: a menu bar icon with what
//! is running and what is waiting, a Dock badge with the waiting count, and a
//! notification when a star needs the person, lands or fails (only when Halo
//! isn't the window they're looking at).

use std::collections::HashMap;

use halo_core::{StarSnapshot, StarStatus};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_notification::NotificationExt;

use crate::hotkey::{self, SummonKey};

pub struct Presence {
	app: AppHandle,
	tray: TrayIcon,
	status: MenuItem<Wry>,
	summon: MenuItem<Wry>,
	allow: MenuItem<Wry>,
	right: CheckMenuItem<Wry>,
	left: CheckMenuItem<Wry>,
	stars: HashMap<String, StarSnapshot>,
}

impl Presence {
	pub fn new(app: &AppHandle, stars: Vec<StarSnapshot>) -> tauri::Result<Self> {
		let status = MenuItem::with_id(app, "status", "Nothing running", false, None::<&str>)?;
		let open = MenuItem::with_id(app, "open", "Open Halo", true, None::<&str>)?;
		let summon = MenuItem::with_id(app, "summon", "Summon", true, None::<&str>)?;
		let right = CheckMenuItem::with_id(app, "key-right", "Right ⌘", true, false, None::<&str>)?;
		let left = CheckMenuItem::with_id(app, "key-left", "Left ⌘", true, false, None::<&str>)?;
		let keys = Submenu::with_items(app, "Summon key", true, &[&right, &left])?;
		let allow = MenuItem::with_id(app, "allow", "Allow the ⌘ shortcut…", true, None::<&str>)?;
		let quit = MenuItem::with_id(app, "quit", "Quit Halo", true, None::<&str>)?;
		let menu = Menu::with_items(app, &[&status, &PredefinedMenuItem::separator(app)?, &open, &summon, &keys, &allow, &PredefinedMenuItem::separator(app)?, &quit])?;
		let tray = TrayIconBuilder::with_id("halo")
			.icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
			.icon_as_template(true)
			.tooltip("Halo")
			.menu(&menu)
			.show_menu_on_left_click(true)
			.on_menu_event(|app, ev| match ev.id().as_ref() {
				"open" => crate::open_sky(app.clone(), None),
				"summon" => crate::toggle_summon(app),
				"key-right" => crate::apply_summon_key(app, SummonKey::RightCommand),
				"key-left" => crate::apply_summon_key(app, SummonKey::LeftCommand),
				"allow" => hotkey::open_input_monitoring_settings(),
				"quit" => app.exit(0),
				_ => {}
			})
			.build(app)?;
		let me = Self { app: app.clone(), tray, status, summon, allow, right, left, stars: stars.into_iter().map(|s| (s.id.clone(), s)).collect() };
		me.refresh_key();
		me.summarise();
		Ok(me)
	}

	/// The summon key and its permission, as the menu shows them.
	pub fn refresh_key(&self) {
		let key = hotkey::key();
		let _ = self.summon.set_text(format!("Summon · tap {}  (or {})", key.label(), hotkey::FALLBACK_LABEL));
		let _ = self.right.set_checked(key == SummonKey::RightCommand);
		let _ = self.left.set_checked(key == SummonKey::LeftCommand);
		let ready = hotkey::listening();
		let _ = self.allow.set_text(if ready { format!("{} is ready", capitalise(key.label())) } else { format!("Allow {} in Accessibility…", key.label()) });
		let _ = self.allow.set_enabled(!ready);
	}

	/// A star changed: notify on the moments that matter, then update the counts.
	pub fn on_star(&mut self, star: &StarSnapshot) {
		let before = self.stars.insert(star.id.clone(), star.clone()).map(|s| s.status);
		if before.is_some() && before != Some(star.status) && !self.halo_in_front() {
			let (title, body) = match star.status {
				StarStatus::NeedsYou => (format!("{} needs you", star.title), star.question.clone().unwrap_or_else(|| star.now.clone())),
				StarStatus::Landed => (format!("{} landed", star.title), star.now.clone()),
				StarStatus::Failed => (format!("{} failed", star.title), star.error.clone().unwrap_or_default()),
				_ => (String::new(), String::new()),
			};
			if !title.is_empty()
				&& let Err(e) = self.app.notification().builder().title(&title).body(&body).show()
			{
				log::warn!("notification: {e}");
			}
		}
		self.summarise();
	}

	fn halo_in_front(&self) -> bool {
		["sky", "summon"].iter().any(|l| self.app.get_webview_window(l).is_some_and(|w| w.is_focused().unwrap_or(false)))
	}

	fn summarise(&self) {
		let working = self.stars.values().filter(|s| matches!(s.status, StarStatus::Working | StarStatus::Forming)).count();
		let waiting = self.stars.values().filter(|s| s.status == StarStatus::NeedsYou).count();
		let text = match (working, waiting) {
			(0, 0) => "Nothing running".to_string(),
			(w, 0) => format!("{w} working"),
			(0, n) => format!("{n} waiting on you"),
			(w, n) => format!("{w} working · {n} waiting on you"),
		};
		let _ = self.status.set_text(&text);
		let _ = self.tray.set_tooltip(Some(format!("Halo · {text}")));
		let _ = self.tray.set_title((waiting > 0).then(|| waiting.to_string()));
		if let Some(w) = self.app.get_webview_window("sky") {
			let _ = w.set_badge_count((waiting > 0).then_some(waiting as i64));
		}
	}
}

fn capitalise(s: &str) -> String {
	let mut c = s.chars();
	c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}
