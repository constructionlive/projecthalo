//! The agent loop (Takeoff Desk's, by way of CRM Desk): stream a completion,
//! run the tool calls it asks for, feed the results back, until the model
//! answers without tools, the step cap is hit, or the person cancels. Older
//! turns are summarised when the next request would pass 70% of the window.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crossbeam_channel::{Sender, unbounded};
use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::llm::{self, Delta};
use crate::prompt::{SUMMARY_PROMPT, system_prompt};
use crate::session::{ChatSession, Msg, estimate_tokens};
use crate::{AgentContext, AgentEvent, TurnHandle};

pub const MAX_STEPS: u32 = 100;
const TOOL_TEXT_LIMIT: usize = 16_000;

pub fn start_turn(session: Arc<Mutex<ChatSession>>, ctx: AgentContext, user_text: String) -> TurnHandle {
	let (tx, rx) = unbounded();
	let cancel = Arc::new(AtomicBool::new(false));
	let c2 = cancel.clone();
	std::thread::Builder::new()
		.name("cc-agent".into())
		.spawn(move || {
			let steps = run(&session, ctx, user_text, &tx, &c2);
			let _ = tx.send(AgentEvent::Done { steps });
		})
		.expect("spawn agent thread");
	TurnHandle { events: rx, cancel }
}

/// Cap a tool's text so one result can't flood the context.
pub(crate) fn clip_tool_text(text: &mut String) {
	if text.len() > TOOL_TEXT_LIMIT {
		let cut = text.char_indices().nth(TOOL_TEXT_LIMIT).map(|(i, _)| i).unwrap_or(text.len());
		text.truncate(cut);
		text.push_str("\n… (truncated — narrow the request)");
	}
}

fn run(session: &Arc<Mutex<ChatSession>>, ctx: AgentContext, user_text: String, tx: &Sender<AgentEvent>, cancel: &Arc<AtomicBool>) -> u32 {
	let toolbox = ctx.toolbox.clone();
	let tool_defs: Vec<Value> = toolbox.specs().iter().map(|t| t.openai()).collect();
	let system = system_prompt(&ctx.user, &toolbox.workspace);
	let provider = ctx.provider.clone();
	session.lock().messages.push(Msg::User { text: user_text, context: Some(ctx.context_line.clone()) });
	let mut steps = 0;
	let mut failures_in_a_row = 0;
	while steps < MAX_STEPS {
		if cancel.load(Ordering::Relaxed) {
			break;
		}
		compact_if_needed(session, &system, &provider, tx);
		let messages = session.lock().api_messages(&system);
		let result = llm::stream(&provider, &messages, &tool_defs, cancel, |d| {
			let _ = tx.send(match d {
				Delta::Text(t) => AgentEvent::TextDelta(t),
				Delta::Reasoning(t) => AgentEvent::ReasoningDelta(t),
			});
		});
		let completion = match result {
			Ok(c) => c,
			Err(e) if e == "cancelled" => break,
			Err(e) => {
				failures_in_a_row += 1;
				if failures_in_a_row >= 2 {
					let _ = tx.send(AgentEvent::Error(e));
					break;
				}
				std::thread::sleep(std::time::Duration::from_millis(1200));
				continue;
			}
		};
		failures_in_a_row = 0;
		steps += 1;
		let _ = tx.send(AgentEvent::Usage { prompt_tokens: completion.prompt_tokens, completion_tokens: completion.completion_tokens });
		{
			let mut s = session.lock();
			s.prompt_tokens = completion.prompt_tokens.max(s.prompt_tokens);
			s.completion_tokens += completion.completion_tokens;
			s.messages.push(Msg::Assistant { text: completion.text.clone(), reasoning: completion.reasoning.clone(), tool_calls: completion.tool_calls.clone() });
		}
		if completion.tool_calls.is_empty() {
			break;
		}
		for call in &completion.tool_calls {
			if cancel.load(Ordering::Relaxed) {
				// Every tool call needs a result, or the next request is invalid.
				session.lock().messages.push(Msg::Tool { call_id: call.id.clone(), name: call.name.clone(), text: "Cancelled by the user.".into(), ok: false });
				continue;
			}
			let args: Value = serde_json::from_str(&call.arguments).unwrap_or_else(|_| json!({"_raw": call.arguments}));
			let _ = tx.send(AgentEvent::ToolStarted { call_id: call.id.clone(), name: call.name.clone(), args: args.clone() });
			let (ok, mut text) = if args.get("_raw").is_some() {
				(false, format!("Your arguments for {} were not valid JSON: {}", call.name, call.arguments.chars().take(300).collect::<String>()))
			} else {
				match toolbox.call(&call.name, args) {
					Ok(t) => (true, t),
					Err(e) => (false, format!("Error: {e}")),
				}
			};
			clip_tool_text(&mut text);
			let summary = text.lines().next().unwrap_or("").chars().take(300).collect::<String>();
			let _ = tx.send(AgentEvent::ToolFinished { call_id: call.id.clone(), name: call.name.clone(), ok, summary });
			session.lock().messages.push(Msg::Tool { call_id: call.id.clone(), name: call.name.clone(), text, ok });
		}
	}
	if steps >= MAX_STEPS {
		let _ = tx.send(AgentEvent::Error(format!("Stopped after {MAX_STEPS} steps. Say \"continue\" to carry on.")));
	}
	steps
}

/// Summarise older turns when the next request would pass 70% of the window.
fn compact_if_needed(session: &Arc<Mutex<ChatSession>>, system: &str, p: &crate::ProviderConfig, tx: &Sender<AgentEvent>) {
	let limit = (p.context_tokens.max(4096) as f64 * 0.7) as u64;
	let (est, msgs) = {
		let s = session.lock();
		let m = s.api_messages(system);
		(estimate_tokens(&m).max(s.prompt_tokens.min(estimate_tokens(&m) * 2)), s.messages.clone())
	};
	if est <= limit || msgs.len() < 6 {
		return;
	}
	// Keep the newest turns that fit in ~35% of the window, cut at a user message.
	let budget = (p.context_tokens as f64 * 0.35) as u64;
	let mut keep_from = msgs.len();
	let mut acc = 0;
	for i in (0..msgs.len()).rev() {
		acc += msg_tokens(&msgs[i]);
		if acc > budget {
			break;
		}
		if matches!(msgs[i], Msg::User { .. }) {
			keep_from = i;
		}
	}
	if keep_from == msgs.len() {
		keep_from = msgs.iter().rposition(|m| matches!(m, Msg::User { .. })).unwrap_or(0);
	}
	if keep_from == 0 {
		return;
	}
	let old = &msgs[..keep_from];
	let mut transcript = String::new();
	if let Some(s) = &session.lock().summary {
		transcript.push_str(&format!("Earlier summary:\n{s}\n\n"));
	}
	for m in old {
		match m {
			Msg::User { text, .. } => transcript.push_str(&format!("PERSON: {text}\n")),
			Msg::Assistant { text, tool_calls, .. } => {
				if !text.trim().is_empty() {
					transcript.push_str(&format!("AGENT: {text}\n"));
				}
				for c in tool_calls {
					transcript.push_str(&format!("  call {}({})\n", c.name, c.arguments.chars().take(200).collect::<String>()));
				}
			}
			Msg::Tool { name, text, .. } => transcript.push_str(&format!("  {name} → {}\n", text.chars().take(600).collect::<String>())),
		}
	}
	let req = vec![json!({"role": "system", "content": SUMMARY_PROMPT}), json!({"role": "user", "content": transcript})];
	let summary = match llm::complete_with(p, &req, Some(1200), true) {
		Ok((t, _, _)) if !t.trim().is_empty() => t,
		_ => format!("(Earlier turns were dropped to fit the model's context. {} messages removed.)", old.len()),
	};
	let mut s = session.lock();
	let n = keep_from.min(s.messages.len());
	s.messages.drain(..n);
	s.summary = Some(summary);
	s.prompt_tokens = 0;
	let _ = tx.send(AgentEvent::TextDelta(String::new()));
}

fn msg_tokens(m: &Msg) -> u64 {
	match m {
		Msg::User { text, context } => (text.len() + context.as_ref().map_or(0, |c| c.len())) as u64 / 4 + 4,
		Msg::Assistant { text, tool_calls, .. } => (text.len() + tool_calls.iter().map(|c| c.arguments.len() + c.name.len()).sum::<usize>()) as u64 / 4 + 4,
		Msg::Tool { text, .. } => text.len() as u64 / 4 + 4,
	}
}
