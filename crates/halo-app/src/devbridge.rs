//! Debug builds only, and only with `HALO_DEV_BRIDGE=<port>`: the same
//! commands the windows use, over plain HTTP on 127.0.0.1, plus the engine's
//! events as Server-Sent Events. Lets a browser run Halo's real UI against the
//! real engine in the running app, so it can be driven and checked end to end.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender, unbounded};
use halo_core::Halo;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

/// Copies of the engine's events for every open `/events` stream.
/// Notes the window leaves for tests (`debug_note`), read back at /debug-notes.
pub static NOTES: std::sync::Mutex<std::collections::BTreeMap<String, String>> = std::sync::Mutex::new(std::collections::BTreeMap::new());

#[derive(Clone, Default)]
pub struct Fanout(Arc<Mutex<Vec<Sender<String>>>>);

impl Fanout {
	pub fn send(&self, json: &str) {
		if let Ok(mut subs) = self.0.lock() {
			subs.retain(|tx| tx.send(json.to_string()).is_ok());
		}
	}

	fn subscribe(&self) -> Receiver<String> {
		let (tx, rx) = unbounded();
		if let Ok(mut subs) = self.0.lock() {
			subs.push(tx);
		}
		rx
	}
}

pub fn start(port: u16, app: AppHandle, halo: Halo, fan: Fanout) {
	let listener = match TcpListener::bind(("127.0.0.1", port)) {
		Ok(l) => l,
		Err(e) => {
			log::warn!("dev bridge: could not listen on {port}: {e}");
			return;
		}
	};
	log::info!("dev bridge on http://127.0.0.1:{port}");
	let _ = std::thread::Builder::new().name("halo-devbridge".into()).spawn(move || {
		for stream in listener.incoming().flatten() {
			let (app, halo, fan) = (app.clone(), halo.clone(), fan.clone());
			let _ = std::thread::Builder::new().name("halo-devbridge-conn".into()).spawn(move || {
				if let Err(e) = serve(stream, &app, &halo, &fan) {
					log::debug!("dev bridge: {e}");
				}
			});
		}
	});
}

const CORS: &str = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n";

fn respond(s: &mut TcpStream, status: &str, body: &Value) -> std::io::Result<()> {
	let text = body.to_string();
	write!(s, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{CORS}Connection: close\r\n\r\n{text}", text.len())
}

fn window(app: &AppHandle, label: &str) -> Value {
	let Some(w) = app.get_webview_window(label) else { return Value::Null };
	let pos = w.outer_position().ok();
	let size = w.outer_size().ok();
	let monitor = w.current_monitor().ok().flatten();
	json!({
		"visible": w.is_visible().unwrap_or(false),
		"focused": w.is_focused().unwrap_or(false),
		"x": pos.map(|p| p.x), "y": pos.map(|p| p.y),
		"width": size.map(|s| s.width), "height": size.map(|s| s.height),
		"scale": w.scale_factor().ok(),
		"monitor": monitor.map(|m| json!({ "x": m.position().x, "y": m.position().y, "width": m.size().width, "height": m.size().height })),
	})
}

fn on_main(app: &AppHandle, f: impl FnOnce(AppHandle) + Send + 'static) {
	let h = app.clone();
	let _ = app.run_on_main_thread(move || f(h));
}

fn serve(mut s: TcpStream, app: &AppHandle, halo: &Halo, fan: &Fanout) -> std::io::Result<()> {
	let mut reader = BufReader::new(s.try_clone()?);
	let mut first = String::new();
	reader.read_line(&mut first)?;
	let mut parts = first.split_whitespace();
	let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
	let mut len = 0usize;
	loop {
		let mut h = String::new();
		if reader.read_line(&mut h)? == 0 || h.trim().is_empty() {
			break;
		}
		if let Some((k, v)) = h.split_once(':')
			&& k.eq_ignore_ascii_case("content-length")
		{
			len = v.trim().parse().unwrap_or(0);
		}
	}
	let mut body = vec![0; len.min(1 << 20)];
	reader.read_exact(&mut body)?;
	let args: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
	let arg = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_string();

	if method == "OPTIONS" {
		return write!(s, "HTTP/1.1 204 No Content\r\n{CORS}Content-Length: 0\r\nConnection: close\r\n\r\n");
	}
	// A custom theme's build, as the app's halotheme:// protocol serves it (tests load themes this way).
	if method == "GET"
		&& let Some(rest) = path.strip_prefix("/theme/")
	{
		let r = crate::serve_theme(halo, &format!("halotheme://localhost/{rest}"));
		let ctype = r.headers().get("Content-Type").and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string();
		write!(s, "HTTP/1.1 {} OK\r\nContent-Type: {ctype}\r\n{CORS}Content-Length: {}\r\nConnection: close\r\n\r\n", r.status().as_u16(), r.body().len())?;
		s.write_all(r.body())?;
		return s.flush();
	}
	let result: Result<Value, String> = match (method.as_str(), path.as_str()) {
		("GET", "/events") => {
			write!(s, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n{CORS}\r\n")?;
			s.flush()?;
			let rx = fan.subscribe();
			loop {
				let out = match rx.recv_timeout(Duration::from_secs(15)) {
					Ok(json) => format!("data: {json}\n\n"),
					Err(crossbeam_channel::RecvTimeoutError::Timeout) => ": ping\n\n".into(),
					Err(_) => return Ok(()),
				};
				s.write_all(out.as_bytes())?;
				s.flush()?;
			}
		}
		("GET", "/state") => serde_json::to_value(halo.state()).map_err(|e| e.to_string()),
		("POST", "/ask") => {
			halo.ask(&arg("text"));
			Ok(Value::Null)
		}
		("POST", "/tell") => halo.stars().tell(&arg("id"), &arg("text")).map(Value::String),
		("POST", "/stop") => halo.stars().stop(&arg("id")).map(Value::String),
		("POST", "/cancel") => {
			halo.cancel();
			Ok(Value::Null)
		}
		("POST", "/toggle-summon") => {
			on_main(app, |h| crate::toggle_summon(&h));
			Ok(Value::Null)
		}
		("POST", "/hide-summon") => {
			on_main(app, crate::hide_summon);
			Ok(Value::Null)
		}
		("POST", "/fit-summon") => {
			let height = args.get("height").and_then(Value::as_f64).unwrap_or(400.0);
			on_main(app, move |h| crate::fit_summon(h, height));
			Ok(Value::Null)
		}
		("POST", "/open-sky") => {
			let id = args.get("starId").and_then(Value::as_str).map(str::to_string);
			on_main(app, move |h| crate::open_sky(h, id));
			Ok(Value::Null)
		}
		("GET", "/windows") => Ok(json!({ "sky": window(app, "sky"), "summon": window(app, "summon") })),
		("GET", "/permissions") => Ok(json!({ "inputMonitoring": crate::hotkey::input_monitoring_allowed() })),
		("POST", "/spawn") => {
			let state = app.state::<crate::AppState>();
			let title = args.get("title").and_then(Value::as_str).map(str::to_string);
			let engine = args.get("engine").and_then(Value::as_str).map(str::to_string);
			let model = args.get("model").and_then(Value::as_str).map(str::to_string);
			let workspace = args.get("workspace").and_then(Value::as_str).map(str::to_string);
			crate::spawn_star(state, arg("goal"), title, engine, model, workspace).and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string()))
		}
		("POST", "/models") => tauri::async_runtime::block_on(crate::engine_models(app.clone(), arg("engine"))).and_then(|m| serde_json::to_value(m).map_err(|e| e.to_string())),
		("POST", "/term-open") => {
			let state = app.state::<crate::AppState>();
			let workspace = args.get("workspace").and_then(Value::as_str).map(str::to_string);
			crate::terminal_open(state, workspace, 100, 30).and_then(|t| serde_json::to_value(t).map_err(|e| e.to_string()))
		}
		("POST", "/term-write") => halo.terminals().write(&arg("id"), arg("data").as_bytes()).map(|_| Value::Null),
		("POST", "/term-replay") => crate::terminal_replay(app.state::<crate::AppState>(), arg("id")),
		("POST", "/term-resize") => {
			let n = |k: &str| args.get(k).and_then(Value::as_u64).unwrap_or(0) as u16;
			halo.terminals().resize(&arg("id"), n("cols"), n("rows")).map(|_| Value::Null)
		}
		("POST", "/term-close") => halo.terminals().close(&arg("id")).map(|_| Value::Null),
		("POST", "/term-read") => halo.terminals().read(&arg("id"), 200).map(Value::String).ok_or_else(|| "no such terminal".to_string()),
		("GET", "/version") => Ok(Value::String(app.package_info().version.to_string())),
		("POST", "/update-check") => tauri::async_runtime::block_on(crate::updates::check(app)).and_then(|u| serde_json::to_value(u).map_err(|e| e.to_string())),
		("POST", "/update-install") => {
			// It restarts the app when it's done: answer first.
			let h = app.clone();
			tauri::async_runtime::spawn(async move {
				if let Err(e) = crate::updates::install(&h).await {
					log::error!("{e}");
					let _ = h.emit("update-failed", e);
				}
			});
			Ok(Value::Null)
		}
		("POST", "/theme-create") => halo.themes().create(&arg("name"), &arg("from")).and_then(|t| serde_json::to_value(t).map_err(|e| e.to_string())),
		("POST", "/theme-build") => halo.themes().build(&arg("id")).and_then(|t| serde_json::to_value(t).map_err(|e| e.to_string())),
		("POST", "/theme-undo") => halo.themes().undo(&arg("id")).and_then(|t| serde_json::to_value(t).map_err(|e| e.to_string())),
		("POST", "/theme-delete") => halo.themes().delete(&arg("id")).map(|_| Value::Null),
		("POST", "/theme-customize") => {
			let engine = args.get("engine").and_then(Value::as_str).and_then(halo_core::Engine::from_key);
			let model = args.get("model").and_then(Value::as_str).map(str::to_string);
			halo.customize_theme(&arg("id"), &arg("request"), engine, model).and_then(|t| serde_json::to_value(t).map_err(|e| e.to_string()))
		}
		// Runs a script in the Sky window (tests: e.g. to collect what a theme's probe reports).
		("POST", "/sky-eval") => app.get_webview_window("sky").ok_or("no sky window".to_string()).and_then(|w| w.eval(arg("js")).map_err(|e| e.to_string())).map(|_| Value::Null),
		("GET", "/debug-notes") => Ok(serde_json::to_value(NOTES.lock().map(|n| n.clone()).unwrap_or_default()).unwrap_or(Value::Null)),
		("POST", "/workspace-open") => halo.open_workspace(std::path::Path::new(&arg("path"))).and_then(|w| serde_json::to_value(w).map_err(|e| e.to_string())),
		("POST", "/workspace-close") => halo.close_workspace(&arg("id")).map(|_| Value::Null),
		("POST", "/workspace-front") => {
			let id = args.get("id").and_then(Value::as_str).map(str::to_string);
			halo.front_workspace(id.as_deref()).map(|_| Value::Null)
		}
		("GET", "/garage") => serde_json::to_value(crate::get_garage(app.state::<crate::AppState>())).map_err(|e| e.to_string()),
		("POST", "/garage") => {
			let engine = args.get("engine").and_then(Value::as_str).map(str::to_string);
			args.get("access")
				.cloned()
				.filter(|v| !v.is_null())
				.map(serde_json::from_value)
				.transpose()
				.map_err(|e| e.to_string())
				.and_then(|access| crate::set_garage(app.state::<crate::AppState>(), engine, access))
				.and_then(|g| serde_json::to_value(g).map_err(|e| e.to_string()))
		}
		("POST", "/voice-file") => (app.state::<crate::AppState>().voice.transcriber())(std::path::Path::new(&arg("path"))).map(Value::String),
		("GET", "/voice-status") => serde_json::to_value(app.state::<crate::AppState>().voice.status()).map_err(|e| e.to_string()),
		("POST", "/voice-start") | ("POST", "/voice-stop") | ("POST", "/allow-hotkey") | ("POST", "/noop") => Ok(Value::Null),
		("POST", "/quit") => {
			on_main(app, |h| h.exit(0));
			Ok(Value::Null)
		}
		("GET", "/hotkey") => serde_json::to_value(crate::hotkey_status()).map_err(|e| e.to_string()),
		("POST", "/summon-key") => match serde_json::from_value::<crate::hotkey::SummonKey>(args.get("key").cloned().unwrap_or(Value::Null)) {
			Ok(key) => {
				on_main(app, move |h| crate::apply_summon_key(&h, key));
				Ok(Value::Null)
			}
			Err(e) => Err(e.to_string()),
		},
		("POST", "/star-files") => {
			let root = app.state::<crate::AppState>().root.clone();
			crate::list_star_files(&root, &arg("id")).and_then(|f| serde_json::to_value(f).map_err(|e| e.to_string()))
		}
		_ => return respond(&mut s, "404 Not Found", &json!({ "error": format!("no route {method} {path}") })),
	};
	match result {
		Ok(v) => respond(&mut s, "200 OK", &json!({ "ok": v })),
		Err(e) => respond(&mut s, "200 OK", &json!({ "error": e })),
	}
}
