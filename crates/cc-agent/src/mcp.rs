//! MCP (JSON-RPC 2.0, one message per line) over the toolbox: what Claude
//! Code / Codex / OpenCode see when a chat runs on them (see [`crate::channel`]).

use serde_json::{Value, json};

pub const PROTOCOL: &str = "2025-06-18";

pub const INSTRUCTIONS: &str = "Halo's tools: this chat's files (list_files, read_file, write_file, transcribe_audio) and whatever the app adds (Halo's agent tools).";

pub fn text_result(text: impl Into<String>, is_error: bool) -> Value {
	json!({ "content": [{ "type": "text", "text": text.into() }], "isError": is_error })
}

fn result(id: &Value, r: Value) -> Value {
	json!({ "jsonrpc": "2.0", "id": id, "result": r })
}

pub fn error(id: &Value, code: i64, msg: &str) -> Value {
	json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } })
}

/// Answer one request. `list` builds the `tools/list` result, `call` runs a
/// tool (name, arguments) and returns a `tools/call` result. Notifications
/// get no reply.
pub fn reply(msg: &Value, list: impl FnOnce() -> Value, call: impl FnOnce(&str, Value) -> Value) -> Option<Value> {
	let id = msg.get("id")?;
	let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
	let params = msg.get("params").cloned().unwrap_or(Value::Null);
	Some(match method {
		"initialize" => result(
			id,
			json!({
				"protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL),
				"capabilities": { "tools": {} },
				"serverInfo": { "name": "command-center", "version": env!("CARGO_PKG_VERSION") },
				"instructions": INSTRUCTIONS
			}),
		),
		"ping" => result(id, json!({})),
		"tools/list" => result(id, list()),
		"tools/call" => {
			let name = params.get("name").and_then(Value::as_str).unwrap_or("");
			let args = params.get("arguments").cloned().unwrap_or(json!({}));
			result(id, call(name, args))
		}
		other => error(id, -32601, &format!("method not found: {other}")),
	})
}
