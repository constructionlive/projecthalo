//! Everything the agent can do in one chat: built-in tools over the chat's
//! folder (`list_files`, `read_file`, `write_file`, and `transcribe_audio` with
//! LiveType's engine), plus whatever the runner adds ([`ToolProvider`]).

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};

/// Transcribes an audio file to text (the app plugs in LiveType's engine).
pub type Transcriber = Arc<dyn Fn(&Path) -> Result<String, String> + Send + Sync>;

const READ_LIMIT: usize = 60_000;

/// A tool as offered to a model.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolSpec {
	pub name: String,
	pub description: String,
	pub parameters: Value,
}

impl ToolSpec {
	/// OpenAI `tools` entry.
	pub fn openai(&self) -> Value {
		json!({ "type": "function", "function": { "name": self.name, "description": self.description, "parameters": self.parameters } })
	}

	/// MCP `tools/list` entry.
	pub fn mcp(&self) -> Value {
		json!({ "name": self.name, "description": self.description, "inputSchema": self.parameters })
	}
}

/// More tools from whoever runs the agent (Halo's `launch_agent`…), offered
/// after the built-ins.
pub trait ToolProvider: Send + Sync {
	fn specs(&self) -> Vec<ToolSpec>;
	/// `None`: not one of this provider's tools.
	fn call(&self, name: &str, args: &Value) -> Option<Result<String, String>>;
}

/// What one chat's agent can use.
pub struct Toolbox {
	/// The chat's folder: attachments land here, outputs go here.
	pub workspace: PathBuf,
	pub transcriber: Option<Transcriber>,
	pub extra: Vec<Arc<dyn ToolProvider>>,
}

impl Toolbox {
	pub fn new(workspace: PathBuf, transcriber: Option<Transcriber>) -> Self {
		let _ = std::fs::create_dir_all(&workspace);
		Self { workspace, transcriber, extra: Vec::new() }
	}

	pub fn with_tools(mut self, provider: Arc<dyn ToolProvider>) -> Self {
		self.extra.push(provider);
		self
	}

	/// Every tool, built-ins first.
	pub fn specs(&self) -> Vec<ToolSpec> {
		let mut out = builtin_specs(self.transcriber.is_some());
		for p in &self.extra {
			out.extend(p.specs());
		}
		out
	}

	pub fn call(&self, name: &str, args: Value) -> Result<String, String> {
		for p in &self.extra {
			if let Some(r) = p.call(name, &args) {
				return r;
			}
		}
		match name {
			"list_files" => self.list_files(),
			"read_file" => self.read_file(&args),
			"write_file" => self.write_file(&args),
			"transcribe_audio" => self.transcribe(&args),
			other => Err(format!("unknown tool {other}")),
		}
	}

	/// Resolves a path inside the chat's folder; nothing outside it.
	fn resolve(&self, raw: &str) -> Result<PathBuf, String> {
		let p = Path::new(raw.trim());
		let rel = p.strip_prefix(&self.workspace).unwrap_or(p);
		// Not just is_absolute(): on Windows "/etc/x" isn't absolute (no drive), yet joined it lands at C:\etc\x.
		if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
			return Err(format!("{raw} is outside this chat's files; use a name from list_files"));
		}
		Ok(self.workspace.join(rel))
	}

	fn list_files(&self) -> Result<String, String> {
		let mut files = Vec::new();
		collect(&self.workspace, &self.workspace, &mut files);
		if files.is_empty() {
			return Ok("No files in this chat yet. The person can attach some with the paperclip or by dropping them on the window.".into());
		}
		files.sort();
		let mut out = format!("{} file(s) in {}:\n", files.len(), self.workspace.display());
		for rel in files {
			let size = std::fs::metadata(self.workspace.join(&rel)).map(|m| m.len()).unwrap_or(0);
			out.push_str(&format!("- {rel} ({})\n", human_size(size)));
		}
		out.push_str("Full paths are this folder + the name.");
		Ok(out)
	}

	fn read_file(&self, args: &Value) -> Result<String, String> {
		let path = self.resolve(args.get("path").and_then(Value::as_str).ok_or("path is required")?)?;
		let bytes = std::fs::read(&path).map_err(|e| format!("couldn't read {}: {e}", path.display()))?;
		let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
		if matches!(ext.as_str(), "m4a" | "mp3" | "wav" | "aiff" | "aif" | "caf" | "aac" | "flac" | "mp4" | "mov") {
			return Err(format!("{} is audio or video: use transcribe_audio for its words.", path.display()));
		}
		let Ok(text) = String::from_utf8(bytes.clone()) else {
			return Err(format!("{} is a binary file ({}), not text.", path.display(), human_size(bytes.len() as u64)));
		};
		let offset = args.get("offset_line").and_then(Value::as_u64).unwrap_or(0) as usize;
		let lines: Vec<&str> = text.lines().skip(offset).collect();
		let mut out = String::new();
		let mut shown = 0;
		for line in &lines {
			if out.len() + line.len() > READ_LIMIT {
				break;
			}
			out.push_str(line);
			out.push('\n');
			shown += 1;
		}
		if shown < lines.len() {
			out.push_str(&format!("… ({} more lines: read again with offset_line {})", lines.len() - shown, offset + shown));
		}
		Ok(out)
	}

	fn write_file(&self, args: &Value) -> Result<String, String> {
		let path = self.resolve(args.get("path").and_then(Value::as_str).ok_or("path is required")?)?;
		let content = args.get("content").and_then(Value::as_str).ok_or("content is required")?;
		if let Some(dir) = path.parent() {
			std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
		}
		std::fs::write(&path, content).map_err(|e| format!("couldn't write {}: {e}", path.display()))?;
		Ok(format!("Wrote {} ({}).", path.display(), human_size(content.len() as u64)))
	}

	fn transcribe(&self, args: &Value) -> Result<String, String> {
		let t = self.transcriber.as_ref().ok_or("No speech model: download one under Settings → Voice.")?;
		let path = self.resolve(args.get("path").and_then(Value::as_str).ok_or("path is required")?)?;
		if !path.is_file() {
			return Err(format!("{} not found; see list_files", path.display()));
		}
		let text = t(&path)?;
		if text.trim().is_empty() {
			return Ok("No speech found in the recording.".into());
		}
		// Keep a copy beside the recording, so it can be read again later.
		let out = path.with_extension("transcript.txt");
		let _ = std::fs::write(&out, &text);
		Ok(format!("Transcript (also saved as {}):\n\n{text}", out.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
	}
}

fn builtin_specs(voice: bool) -> Vec<ToolSpec> {
	let obj = |props: Value, required: &[&str]| json!({ "type": "object", "properties": props, "required": required });
	let mut v = vec![
		ToolSpec { name: "list_files".into(), description: "List the files attached to this chat (and ones you wrote), with sizes.".into(), parameters: obj(json!({}), &[]) },
		ToolSpec {
			name: "read_file".into(),
			description: "Read a text file from this chat's files (txt, md, csv, json, …). Long files come in parts: pass offset_line to continue.".into(),
			parameters: obj(json!({ "path": { "type": "string", "description": "Name from list_files" }, "offset_line": { "type": "integer", "description": "Line to start from (0 = start)" } }), &["path"]),
		},
		ToolSpec {
			name: "write_file".into(),
			description: "Write a text file into this chat's files (a summary, an email draft, a CSV…). Overwrites a file of the same name.".into(),
			parameters: obj(json!({ "path": { "type": "string", "description": "File name, e.g. summary.md" }, "content": { "type": "string" } }), &["path", "content"]),
		},
	];
	if voice {
		v.push(ToolSpec {
			name: "transcribe_audio".into(),
			description: "Transcribe a recording in this chat's files (m4a, mp3, wav, …: meetings, voice memos, calls) to text, on this computer.".into(),
			parameters: obj(json!({ "path": { "type": "string", "description": "Name from list_files" } }), &["path"]),
		});
	}
	v
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<String>) {
	let Ok(entries) = std::fs::read_dir(dir) else { return };
	for e in entries.flatten() {
		let p = e.path();
		let name = e.file_name().to_string_lossy().into_owned();
		if name.starts_with('.') {
			continue;
		}
		if p.is_dir() {
			collect(root, &p, out);
		} else if let Ok(rel) = p.strip_prefix(root) {
			// Always "notes/a.md", on Windows too: the name the model sees and passes back.
			out.push(rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"));
		}
	}
}

pub fn human_size(n: u64) -> String {
	match n {
		n if n >= 1_000_000 => format!("{:.1} MB", n as f64 / 1e6),
		n if n >= 1_000 => format!("{:.0} KB", n as f64 / 1e3),
		n => format!("{n} B"),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn toolbox() -> Toolbox {
		let dir = std::env::temp_dir().join(format!("cc-toolbox-{}-{}", std::process::id(), crate::now_ms()));
		Toolbox::new(dir, None)
	}

	#[test]
	fn files_stay_inside_the_chat() {
		let t = toolbox();
		assert!(t.call("write_file", json!({ "path": "notes/a.md", "content": "hi" })).is_ok());
		assert_eq!(t.call("read_file", json!({ "path": "notes/a.md" })).unwrap(), "hi\n");
		assert!(t.call("list_files", json!({})).unwrap().contains("notes/a.md"));
		assert!(t.call("read_file", json!({ "path": "../secret" })).is_err());
		assert!(t.call("write_file", json!({ "path": "/etc/x", "content": "" })).is_err());
		assert!(t.call("write_file", json!({ "path": "\\\\server\\share\\x", "content": "" })).is_err() || !cfg!(windows));
		assert!(t.call("write_file", json!({ "path": "C:x", "content": "" })).is_err() || !cfg!(windows));
		// The chat folder's own absolute paths are fine.
		let abs = t.workspace.join("notes/a.md");
		assert!(t.call("read_file", json!({ "path": abs.to_string_lossy() })).is_ok());
	}
}
