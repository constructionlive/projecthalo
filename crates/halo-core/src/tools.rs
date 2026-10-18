//! What Halo can do with its agents, offered to its CLI as ordinary tools.

use std::sync::Arc;

use serde_json::{Value, json};

use cc_agent::toolbox::{ToolProvider, ToolSpec};

use crate::runner::Engine;
use crate::stars::{StarRuntime, StarSnapshot, StarStatus};
use crate::terminals::{Terminals, describe};
use crate::workspaces::{Workspaces, tilde};

pub struct HaloTools {
	pub stars: StarRuntime,
	pub workspaces: Arc<Workspaces>,
	pub terminals: Terminals,
}

fn s<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
	args.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).ok_or_else(|| format!("{key} is required"))
}

fn ago(ms: u64) -> String {
	let secs = crate::now_ms().saturating_sub(ms) / 1000;
	match secs {
		0..=59 => format!("{secs}s ago"),
		60..=3599 => format!("{} min ago", secs / 60),
		_ => format!("{} h ago", secs / 3600),
	}
}

fn line(st: &StarSnapshot) -> String {
	let stalled = if st.stalled { ", stalled" } else { "" };
	let place = st.cwd.as_deref().map(|p| format!(" · in {}", tilde(p))).unwrap_or_default();
	format!("{} · {}{stalled} · \"{}\" · {}{place} · {}", st.id, st.status.label(), st.title, st.engine.name(), st.now)
}

fn detail(st: &StarSnapshot) -> String {
	let mut out = format!("{}\nGoal: {}\nLast activity: {}\n", line(st), st.goal, ago(st.last_activity));
	if let Some(q) = &st.question {
		out.push_str(&format!("Question for the person: {q}\n"));
	}
	if let Some(r) = st.result.as_ref().filter(|_| st.status == StarStatus::Landed) {
		out.push_str(&format!("Result:\n{r}\n"));
	}
	if let Some(e) = &st.error {
		out.push_str(&format!("Error: {e}\n"));
	}
	out.push_str("Recent log:\n");
	for l in st.log.iter().rev().take(12).rev() {
		out.push_str(&format!("- [{:?}] {}\n", l.kind, l.text));
	}
	out
}

impl ToolProvider for HaloTools {
	fn specs(&self) -> Vec<ToolSpec> {
		let id = json!({ "type": "string", "description": "The agent's id, e.g. s1k3f0" });
		vec![
			ToolSpec {
				name: "launch_agent".into(),
				description:
					"Launch an agent: a background worker that does one job on its own (its own Claude Code / Codex / OpenCode session, in a workspace's folder). Returns immediately; you'll get an [AGENT …] message when it is done, needs the person, fails or stalls."
						.into(),
				parameters: json!({ "type": "object", "properties": {
					"title": { "type": "string", "description": "A few words the person will see, e.g. \"Fix flaky auth test\"" },
					"goal": { "type": "string", "description": "Everything the agent needs: what to do, which repository and branch, files, errors, commands, what done looks like" },
					"engine": { "type": "string", "enum": ["claude", "codex", "opencode"], "description": "Optional; defaults to the person's choice in Settings" },
					"workspace": { "type": "string", "description": "Optional: the workspace's name (e.g. \"billing\") to work in; defaults to the one in front of the person; \"none\" for a folder of its own" }
				}, "required": ["title", "goal"] }),
			},
			ToolSpec { name: "list_agents".into(), description: "Every agent with its status and what it is doing now.".into(), parameters: json!({ "type": "object", "properties": {} }) },
			ToolSpec { name: "peek_agent".into(), description: "One agent in detail: goal, status, question or result, recent log.".into(), parameters: json!({ "type": "object", "properties": { "id": id }, "required": ["id"] }) },
			ToolSpec {
				name: "tell_agent".into(),
				description: "Send an agent a message: the person's answer to its question, a correction, or more work. An agent that is busy gets it when its current step ends; a finished one picks back up.".into(),
				parameters: json!({ "type": "object", "properties": { "id": id, "message": { "type": "string" } }, "required": ["id", "message"] }),
			},
			ToolSpec { name: "list_terminals".into(), description: "The person's open terminals: where each is, what it is running or how its last command ended, ports it listens on.".into(), parameters: json!({ "type": "object", "properties": {} }) },
			ToolSpec {
				name: "read_terminal".into(),
				description: "The latest output of one of the person's terminals, as plain text: to see why a command failed, what a server logged, what a test printed.".into(),
				parameters: json!({ "type": "object", "properties": { "id": { "type": "string", "description": "The terminal's id, e.g. t1k3f0" }, "lines": { "type": "integer", "description": "How many lines from the end (default 80, at most 400)" } }, "required": ["id"] }),
			},
			ToolSpec { name: "stop_agent".into(), description: "Stop an agent.".into(), parameters: json!({ "type": "object", "properties": { "id": id }, "required": ["id"] }) },
		]
	}

	fn call(&self, name: &str, args: &Value) -> Option<Result<String, String>> {
		let r = match name {
			"launch_agent" => (|| {
				let title = s(args, "title")?;
				let goal = s(args, "goal")?;
				let engine = match args.get("engine").and_then(Value::as_str) {
					Some(k) => Some(Engine::from_key(k).ok_or_else(|| format!("unknown engine {k}"))?),
					None => None,
				};
				let workspace = match args.get("workspace").and_then(Value::as_str).map(str::trim).filter(|w| !w.is_empty()) {
					Some(w) if w.eq_ignore_ascii_case("none") => None,
					Some(w) => Some(self.workspaces.find(w).ok_or_else(|| format!("there is no workspace {w}; open ones: {}", self.workspaces.context()))?),
					None => self.workspaces.current(),
				};
				let st = self.stars.spawn_in(title, goal, engine, None, workspace.as_ref());
				let when = if st.status == StarStatus::Forming { " It's queued behind other running agents." } else { "" };
				let place = workspace.map(|w| format!(" in {} ({})", w.name, tilde(&w.path))).unwrap_or_else(|| " in its own folder".into());
				Ok(format!("Launched agent {} \"{}\" on {}{place}.{when} It works in the background; an [AGENT …] message will wake you when it reports. Answer the person now.", st.id, st.title, st.engine.name()))
			})(),
			"list_agents" => {
				let all = self.stars.list();
				Ok(if all.is_empty() { "No agents yet.".into() } else { all.iter().map(line).collect::<Vec<_>>().join("\n") })
			}
			"peek_agent" => s(args, "id").and_then(|id| self.stars.get(id).map(|st| detail(&st)).ok_or_else(|| format!("there is no agent {id}"))),
			"tell_agent" => s(args, "id").and_then(|id| s(args, "message").and_then(|m| self.stars.tell(id, m))),
			"stop_agent" => s(args, "id").and_then(|id| self.stars.stop(id)),
			"list_terminals" => {
				let all = self.terminals.list();
				Ok(if all.is_empty() { "No terminals open.".into() } else { all.iter().map(describe).collect::<Vec<_>>().join("\n") })
			}
			"read_terminal" => s(args, "id").and_then(|id| {
				let lines = args.get("lines").and_then(Value::as_u64).unwrap_or(80).clamp(1, 400) as usize;
				let t = self.terminals.get(id).ok_or_else(|| format!("there is no terminal {id}"))?;
				let text = self.terminals.read(id, lines).unwrap_or_default();
				Ok(format!("{}\n--- last {lines} lines ---\n{text}", describe(&t)))
			}),
			_ => return None,
		};
		Some(r)
	}
}
