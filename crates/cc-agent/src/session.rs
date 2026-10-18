//! A chat: stored messages (persistable), the transcript the UI shows, and
//! the API message list. CRM Desk's, unchanged in shape so chats move freely
//! between the apps' agents.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::llm::ToolCall;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum Msg {
	User {
		text: String,
		/// What the person was looking at when they sent it — sent, not shown.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		context: Option<String>,
	},
	Assistant {
		#[serde(default)]
		text: String,
		#[serde(default, skip_serializing_if = "String::is_empty")]
		reasoning: String,
		#[serde(default, skip_serializing_if = "Vec::is_empty")]
		tool_calls: Vec<ToolCall>,
	},
	Tool {
		call_id: String,
		name: String,
		text: String,
		ok: bool,
	},
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
	User,
	Assistant,
	Tool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptEntry {
	pub role: Role,
	pub text: String,
	pub tool_name: Option<String>,
	pub tool_ok: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChatSession {
	pub messages: Vec<Msg>,
	/// Rolling summary of compacted turns.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub summary: Option<String>,
	#[serde(default)]
	pub prompt_tokens: u64,
	#[serde(default)]
	pub completion_tokens: u64,
	/// The conversation as Claude Code / Codex / OpenCode holds it, resumed next turn.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub external: Option<ExternalThread>,
}

/// A conversation held by an outside agent CLI, resumed by id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExternalThread {
	/// [`crate::channel::Channel::key`]: "claude", "codex" or "opencode".
	pub channel: String,
	pub id: String,
}

impl ChatSession {
	pub fn new() -> Self {
		Self::default()
	}

	pub fn clear(&mut self) {
		*self = Self::default();
	}

	pub fn transcript(&self) -> Vec<TranscriptEntry> {
		let mut out = Vec::new();
		for m in &self.messages {
			match m {
				Msg::User { text, .. } => out.push(TranscriptEntry { role: Role::User, text: text.clone(), tool_name: None, tool_ok: None }),
				Msg::Assistant { text, .. } => {
					if !text.trim().is_empty() {
						out.push(TranscriptEntry { role: Role::Assistant, text: text.clone(), tool_name: None, tool_ok: None });
					}
				}
				Msg::Tool { name, text, ok, .. } => out.push(TranscriptEntry { role: Role::Tool, text: first_line(text), tool_name: Some(name.clone()), tool_ok: Some(*ok) }),
			}
		}
		out
	}

	/// The `messages` array for the API.
	pub fn api_messages(&self, system: &str) -> Vec<Value> {
		let mut sys = system.to_string();
		if let Some(s) = &self.summary {
			sys.push_str("\n\n# Earlier in this conversation (summary)\n");
			sys.push_str(s);
		}
		let mut out = vec![json!({"role": "system", "content": sys})];
		for m in &self.messages {
			match m {
				Msg::User { text, context } => {
					let content = match context {
						Some(c) => format!("{c}\n\n{text}"),
						None => text.clone(),
					};
					out.push(json!({"role": "user", "content": content}));
				}
				Msg::Assistant { text, tool_calls, .. } => {
					let mut v = json!({"role": "assistant", "content": text});
					if !tool_calls.is_empty() {
						v["tool_calls"] = Value::Array(tool_calls.iter().map(|c| json!({"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}})).collect());
					}
					out.push(v);
				}
				Msg::Tool { call_id, text, .. } => out.push(json!({"role": "tool", "tool_call_id": call_id, "content": text})),
			}
		}
		out
	}
}

fn first_line(t: &str) -> String {
	let l = t.lines().next().unwrap_or("").trim();
	if l.chars().count() > 240 { format!("{}…", l.chars().take(240).collect::<String>()) } else { l.to_string() }
}

/// Rough token estimate for compaction (4 chars/token).
pub fn estimate_tokens(messages: &[Value]) -> u64 {
	messages.iter().map(|m| m.get("content").and_then(Value::as_str).map_or(0, |s| s.len() as u64 / 4) + m.get("tool_calls").map_or(0, |c| c.to_string().len() as u64 / 4) + 4).sum()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn api_shape_and_round_trip() {
		let mut s = ChatSession::new();
		s.messages.push(Msg::User { text: "what's due".into(), context: Some("[CRM: Leads]".into()) });
		s.messages.push(Msg::Assistant { text: String::new(), reasoning: String::new(), tool_calls: vec![ToolCall { id: "c1".into(), name: "list_rows".into(), arguments: "{}".into() }] });
		s.messages.push(Msg::Tool { call_id: "c1".into(), name: "list_rows".into(), text: "3 rows\n…".into(), ok: true });
		s.messages.push(Msg::Assistant { text: "Three bids.".into(), reasoning: String::new(), tool_calls: vec![] });
		let m = s.api_messages("sys");
		assert_eq!(m.len(), 5);
		assert!(m[1]["content"].as_str().unwrap().starts_with("[CRM: Leads]\n\nwhat's due"));
		assert_eq!(m[2]["tool_calls"][0]["function"]["name"], "list_rows");
		assert_eq!(m[3]["tool_call_id"], "c1");
		let back: ChatSession = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
		assert_eq!(back.transcript().len(), 3);
		assert_eq!(back.transcript()[1].text, "3 rows");
	}
}
