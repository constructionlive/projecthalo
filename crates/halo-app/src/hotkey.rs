//! A lone tap of one ⌘ key summons Halo: right ⌘ by default (left ⌘ is a
//! setting); on Windows, Ctrl (the Windows key belongs to Start). Pressed and
//! released within a moment with no other key or click in between, so ⌘C,
//! ⌘-click and a held ⌘ never trigger it.
//!
//! macOS only shows key presses to apps allowed under Accessibility (as
//! LiveType asks) or Input Monitoring. The
//! watcher waits for that permission and starts the moment it is given (no
//! restart), and switches itself back on if macOS ever pauses it. ⌘⇧Space
//! (Ctrl+Alt+Space on Windows) works without the permission. Windows needs
//! none: a low-level keyboard hook sees every key.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SummonKey {
	#[default]
	RightCommand,
	LeftCommand,
}

impl SummonKey {
	/// macOS virtual key code.
	#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
	pub fn keycode(self) -> i64 {
		match self {
			SummonKey::RightCommand => 54,
			SummonKey::LeftCommand => 55,
		}
	}

	/// Windows virtual key code (VK_RCONTROL, VK_LCONTROL).
	#[cfg_attr(not(windows), allow(dead_code))]
	pub fn vk(self) -> u32 {
		match self {
			SummonKey::RightCommand => 0xA3,
			SummonKey::LeftCommand => 0xA2,
		}
	}

	pub fn label(self) -> &'static str {
		match (self, cfg!(windows)) {
			(SummonKey::RightCommand, false) => "right ⌘",
			(SummonKey::LeftCommand, false) => "left ⌘",
			(SummonKey::RightCommand, true) => "right Ctrl",
			(SummonKey::LeftCommand, true) => "left Ctrl",
		}
	}
}

/// The shortcut that summons without the key watcher.
pub const FALLBACK_LABEL: &str = if cfg!(windows) { "Ctrl+Alt+Space" } else { "⌘⇧Space" };

/// What the key watcher sees, reduced to what matters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEvent {
	/// The summon key went down; `others` = another modifier was already held.
	Down {
		others: bool,
	},
	Up,
	/// Any other key, modifier, click or scroll.
	Other,
}

const TAP_WINDOW: Duration = Duration::from_millis(450);

/// Turns key events into "the summon key was tapped on its own".
#[derive(Debug, Default)]
pub struct TapDetector {
	down: Option<Instant>,
}

impl TapDetector {
	/// True when this event completes a lone tap.
	pub fn feed(&mut self, ev: KeyEvent, at: Instant) -> bool {
		match ev {
			KeyEvent::Down { others } => {
				self.down = (!others).then_some(at);
				false
			}
			KeyEvent::Up => self.down.take().is_some_and(|t| at.duration_since(t) < TAP_WINDOW),
			KeyEvent::Other => {
				self.down = None;
				false
			}
		}
	}
}

/// Whether the watcher is receiving keys right now.
static LISTENING: AtomicBool = AtomicBool::new(false);
/// The summon key in use (changeable while running): false = right ⌘, true = left ⌘.
static LEFT: AtomicBool = AtomicBool::new(false);

pub fn set_key(key: SummonKey) {
	LEFT.store(key == SummonKey::LeftCommand, Ordering::Relaxed);
}

pub fn key() -> SummonKey {
	if LEFT.load(Ordering::Relaxed) { SummonKey::LeftCommand } else { SummonKey::RightCommand }
}

pub fn listening() -> bool {
	LISTENING.load(Ordering::Relaxed)
}

#[cfg(target_os = "macos")]
mod mac {
	use std::ffi::c_void;

	use core_foundation::base::TCFType;
	use core_foundation::boolean::CFBoolean;
	use core_foundation::dictionary::CFDictionary;
	use core_foundation::string::{CFString, CFStringRef};

	#[link(name = "CoreGraphics", kind = "framework")]
	unsafe extern "C" {
		pub fn CGPreflightListenEventAccess() -> bool;
		pub fn CGEventTapEnable(tap: *const c_void, enable: bool);
	}

	#[link(name = "ApplicationServices", kind = "framework")]
	unsafe extern "C" {
		fn AXIsProcessTrusted() -> bool;
		fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
		static kAXTrustedCheckOptionPrompt: CFStringRef;
	}

	pub fn accessibility() -> bool {
		// SAFETY: a plain query with no arguments.
		unsafe { AXIsProcessTrusted() }
	}

	/// macOS's own "Halo would like to control this computer" dialog, which
	/// also adds Halo to the Accessibility list (as LiveType does).
	pub fn request_accessibility() {
		// SAFETY: the key is a CFString constant from ApplicationServices; the
		// dictionary lives for the duration of the call.
		unsafe {
			let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
			let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
			AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef() as *const c_void);
		}
	}
}

/// Whether macOS lets Halo see key presses: Accessibility (what LiveType uses)
/// or Input Monitoring, either is enough.
pub fn input_monitoring_allowed() -> bool {
	#[cfg(target_os = "macos")]
	// SAFETY: a plain query with no arguments.
	return mac::accessibility() || unsafe { mac::CGPreflightListenEventAccess() };
	#[cfg(not(target_os = "macos"))]
	true
}

/// Asks macOS for Accessibility, with its own dialog (once per app).
pub fn request_input_monitoring() {
	#[cfg(target_os = "macos")]
	mac::request_accessibility();
}

/// Opens System Settings at Privacy & Security → Accessibility.
pub fn open_input_monitoring_settings() {
	#[cfg(target_os = "macos")]
	let _ = std::process::Command::new("open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").spawn();
}

/// What a held summon key does: starts on hold, ends on release.
pub type Hook = std::sync::Arc<dyn Fn() + Send + Sync>;

/// Taps and holds, from the key events either platform's watcher sees.
struct Taps {
	detector: TapDetector,
	/// (press number, still clean, holding): shared with the hold timer.
	hold: std::sync::Arc<std::sync::Mutex<(u64, bool, bool)>>,
	on_tap: Hook,
	on_hold: Hook,
	on_release: Hook,
}

impl Taps {
	fn new(on_tap: Hook, on_hold: Hook, on_release: Hook) -> Self {
		Self { detector: TapDetector::default(), hold: Default::default(), on_tap, on_hold, on_release }
	}

	fn feed(&mut self, ev: KeyEvent) {
		let holding = self.hold.lock().map(|h| h.2).unwrap_or(false);
		match ev {
			KeyEvent::Down { others } => {
				if let Ok(mut h) = self.hold.lock() {
					*h = (h.0 + 1, !others, false);
					let (n, shared, on_hold) = (h.0, self.hold.clone(), self.on_hold.clone());
					std::thread::spawn(move || {
						std::thread::sleep(TAP_WINDOW);
						let start = shared.lock().map(|mut h| {
							let go = h.0 == n && h.1 && !h.2;
							if go {
								h.2 = true;
							}
							go
						});
						if start.unwrap_or(false) {
							on_hold();
						}
					});
				}
			}
			KeyEvent::Up => {
				if let Ok(mut h) = self.hold.lock() {
					h.1 = false;
					h.2 = false;
				}
				if holding {
					self.detector.feed(KeyEvent::Other, Instant::now());
					(self.on_release)();
					return;
				}
			}
			KeyEvent::Other if !holding => {
				if let Ok(mut h) = self.hold.lock() {
					h.1 = false;
				}
			}
			KeyEvent::Other => return,
		}
		if self.detector.feed(ev, Instant::now()) {
			(self.on_tap)();
		}
	}
}

/// Calls `on_tap` on each lone tap of the summon key ([`set_key`]); holding it
/// past the tap window calls `on_hold` once, and letting go then calls
/// `on_release` (hold-to-talk). All from background threads.
#[cfg(target_os = "macos")]
pub fn watch(on_tap: Hook, on_hold: Hook, on_release: Hook) {
	use std::cell::RefCell;
	use std::sync::atomic::AtomicUsize;

	use core_foundation::base::TCFType;
	use core_foundation::runloop::{CFRunLoop, kCFRunLoopCommonModes};
	use core_graphics::event::{CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType, EventField};

	let _ = std::thread::Builder::new().name("halo-hotkey".into()).spawn(move || {
		if !input_monitoring_allowed() {
			log::info!("{}: waiting for Accessibility", key().label());
			// HALO_NO_PROMPT: test runs never put a dialog on the person's screen.
			if std::env::var_os("HALO_NO_PROMPT").is_none() {
				request_input_monitoring();
			}
			while !input_monitoring_allowed() {
				std::thread::sleep(Duration::from_secs(2));
			}
		}
		let port = AtomicUsize::new(0);
		let taps = RefCell::new(Taps::new(on_tap, on_hold, on_release));
		let interests = vec![CGEventType::FlagsChanged, CGEventType::KeyDown, CGEventType::LeftMouseDown, CGEventType::RightMouseDown, CGEventType::OtherMouseDown, CGEventType::ScrollWheel];
		let tap = CGEventTap::new(CGEventTapLocation::Session, CGEventTapPlacement::TailAppendEventTap, CGEventTapOptions::ListenOnly, interests, |_proxy, kind, event| {
			let ev = match kind {
				CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
					// macOS paused the watcher (system busy): switch it back on.
					let p = port.load(Ordering::Relaxed);
					if p != 0 {
						// SAFETY: p is this tap's mach port, alive while the run loop runs.
						unsafe { mac::CGEventTapEnable(p as *const std::ffi::c_void, true) };
						log::info!("{}: watcher switched back on", key().label());
					}
					KeyEvent::Other
				}
				CGEventType::FlagsChanged if event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) == key().keycode() => {
					let flags = event.get_flags();
					if flags.contains(CGEventFlags::CGEventFlagCommand) {
						let others = CGEventFlags::CGEventFlagShift | CGEventFlags::CGEventFlagControl | CGEventFlags::CGEventFlagAlternate | CGEventFlags::CGEventFlagSecondaryFn;
						KeyEvent::Down { others: flags.intersects(others) }
					} else {
						KeyEvent::Up
					}
				}
				_ => KeyEvent::Other,
			};
			taps.borrow_mut().feed(ev);
			None
		});
		match tap {
			Ok(tap) => {
				port.store(tap.mach_port.as_concrete_TypeRef() as usize, Ordering::Relaxed);
				let Ok(source) = tap.mach_port.create_runloop_source(0) else {
					log::warn!("{}: could not attach the key watcher", key().label());
					return;
				};
				// SAFETY: the source and the tap live until this thread's run loop ends.
				unsafe { CFRunLoop::get_current().add_source(&source, kCFRunLoopCommonModes) };
				tap.enable();
				LISTENING.store(true, Ordering::Relaxed);
				log::info!("{} watcher on", key().label());
				CFRunLoop::run_current();
				LISTENING.store(false, Ordering::Relaxed);
			}
			Err(()) => log::warn!("{}: macOS refused the key watcher even with Accessibility allowed", key().label()),
		}
	});
}

/// Windows: low-level keyboard and mouse hooks, on a thread of their own that
/// pumps messages (Windows calls a hook on the thread that set it).
#[cfg(windows)]
pub fn watch(on_tap: Hook, on_hold: Hook, on_release: Hook) {
	use std::cell::RefCell;

	use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
	use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LCONTROL, VK_LWIN, VK_MENU, VK_RCONTROL, VK_RWIN, VK_SHIFT};
	use windows_sys::Win32::UI::WindowsAndMessaging::{
		CallNextHookEx, DispatchMessageW, GetMessageW, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, SetWindowsHookExW, TranslateMessage, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_MOUSEHWHEEL, WM_MOUSEWHEEL,
		WM_RBUTTONDOWN, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDOWN,
	};

	thread_local! {
		static TAPS: RefCell<Option<Taps>> = const { RefCell::new(None) };
		/// The summon key is down (Windows repeats key-downs while it's held).
		static DOWN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
	}
	fn feed(ev: KeyEvent) {
		TAPS.with(|t| {
			if let Some(t) = t.borrow_mut().as_mut() {
				t.feed(ev);
			}
		});
	}
	fn held(vk: u16) -> bool {
		// SAFETY: a plain query.
		unsafe { GetAsyncKeyState(vk as i32) as u16 & 0x8000 != 0 }
	}
	unsafe extern "system" fn keyboard(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
		if code >= 0 {
			// SAFETY: for WH_KEYBOARD_LL, l points at a KBDLLHOOKSTRUCT.
			let k = unsafe { &*(l as *const KBDLLHOOKSTRUCT) };
			let msg = w as u32;
			let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
			let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
			if k.flags & LLKHF_INJECTED == 0 {
				if k.vkCode == key().vk() {
					if down && !DOWN.replace(true) {
						let other_ctrl = if key() == SummonKey::RightCommand { VK_LCONTROL } else { VK_RCONTROL };
						feed(KeyEvent::Down { others: [VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN, other_ctrl].into_iter().any(held) });
					} else if up {
						DOWN.set(false);
						feed(KeyEvent::Up);
					}
				} else if down {
					feed(KeyEvent::Other);
				}
			}
		}
		// SAFETY: passing the event on, as every hook must.
		unsafe { CallNextHookEx(std::ptr::null_mut(), code, w, l) }
	}
	unsafe extern "system" fn mouse(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
		if code >= 0 && [WM_LBUTTONDOWN, WM_RBUTTONDOWN, WM_MBUTTONDOWN, WM_XBUTTONDOWN, WM_MOUSEWHEEL, WM_MOUSEHWHEEL].contains(&(w as u32)) {
			feed(KeyEvent::Other);
		}
		// SAFETY: as above.
		unsafe { CallNextHookEx(std::ptr::null_mut(), code, w, l) }
	}

	let _ = std::thread::Builder::new().name("halo-hotkey".into()).spawn(move || {
		TAPS.with(|t| *t.borrow_mut() = Some(Taps::new(on_tap, on_hold, on_release)));
		// SAFETY: hooks on this thread, which pumps messages for as long as Halo runs.
		unsafe {
			let kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), std::ptr::null_mut(), 0);
			let ms = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), std::ptr::null_mut(), 0);
			if kb.is_null() {
				log::warn!("{}: Windows refused the key watcher", key().label());
				return;
			}
			if ms.is_null() {
				log::warn!("{}: no mouse watcher (a Ctrl-click may summon)", key().label());
			}
			LISTENING.store(true, Ordering::Relaxed);
			log::info!("{} watcher on", key().label());
			let mut msg: MSG = std::mem::zeroed();
			while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
				TranslateMessage(&msg);
				DispatchMessageW(&msg);
			}
			LISTENING.store(false, Ordering::Relaxed);
		}
	});
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn watch(_on_tap: Hook, _on_hold: Hook, _on_release: Hook) {}

#[cfg(test)]
mod tests {
	use super::*;

	fn run(steps: &[(KeyEvent, u64)]) -> Vec<bool> {
		let t0 = Instant::now();
		let mut d = TapDetector::default();
		steps.iter().map(|(e, ms)| d.feed(*e, t0 + Duration::from_millis(*ms))).collect()
	}

	const DOWN: KeyEvent = KeyEvent::Down { others: false };
	const UP: KeyEvent = KeyEvent::Up;

	#[test]
	fn a_quick_lone_tap_summons() {
		assert_eq!(run(&[(DOWN, 0), (UP, 120)]), [false, true]);
	}

	#[test]
	fn a_shortcut_does_not() {
		assert_eq!(run(&[(DOWN, 0), (KeyEvent::Other, 50), (UP, 120)]), [false, false, false], "⌘C");
	}

	#[test]
	fn holding_does_not() {
		assert_eq!(run(&[(DOWN, 0), (UP, 900)]), [false, false]);
	}

	#[test]
	fn with_another_modifier_held_does_not() {
		assert_eq!(run(&[(KeyEvent::Down { others: true }, 0), (UP, 100)]), [false, false], "⇧⌘");
	}

	#[test]
	fn a_click_while_holding_does_not() {
		assert_eq!(run(&[(DOWN, 0), (KeyEvent::Other, 80), (UP, 150)]), [false, false, false], "⌘-click");
	}

	#[test]
	fn two_taps_summon_twice() {
		assert_eq!(run(&[(DOWN, 0), (UP, 100), (DOWN, 400), (UP, 480)]), [false, true, false, true]);
	}

	#[test]
	fn a_stray_release_does_not() {
		assert_eq!(run(&[(UP, 0)]), [false]);
	}

	#[test]
	fn right_command_is_the_default() {
		assert_eq!(SummonKey::default(), SummonKey::RightCommand);
		assert_eq!(SummonKey::default().keycode(), 54);
		assert_eq!(serde_json::from_str::<SummonKey>("\"leftCommand\"").unwrap(), SummonKey::LeftCommand);
	}
}
