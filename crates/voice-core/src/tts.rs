//! Reading text aloud, for interactive mode (the assistant answers by voice)
//! and "read this to me". macOS's own voices through `say`: on-device, no
//! download, and it can be stopped mid-sentence. Markdown is turned into
//! plain speech first, so "**24 doors**" isn't read as "asterisk asterisk".

use std::io::Write;
use std::process::{Child, Command, Stdio};

use parking_lot::Mutex;

/// A system voice: `name` goes to [`Narrator::set_voice`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemVoice {
	pub name: String,
	/// "en_US", "en_GB"…
	pub language: String,
}

/// The installed voices, English first (`say -v ?`).
pub fn voices() -> Vec<SystemVoice> {
	if !cfg!(target_os = "macos") {
		return vec![];
	}
	let Ok(out) = Command::new("say").args(["-v", "?"]).output() else { return vec![] };
	let mut list: Vec<SystemVoice> = String::from_utf8_lossy(&out.stdout)
		.lines()
		.filter_map(|line| {
			// "Samantha            en_US    # Hello! My name is Samantha."
			let head = line.split('#').next()?.trim_end();
			let lang = head.split_whitespace().last()?.to_string();
			let name = head[..head.len() - lang.len()].trim().to_string();
			(!name.is_empty() && lang.contains('_')).then_some(SystemVoice { name, language: lang })
		})
		.collect();
	list.sort_by_key(|v| (!v.language.starts_with("en"), v.language.clone(), v.name.clone()));
	list
}

/// Speaks one text at a time; a new [`speak`](Self::speak) interrupts the last.
#[derive(Default)]
pub struct Narrator {
	child: Mutex<Option<Child>>,
	voice: Mutex<Option<String>>,
	/// Words per minute; 0 = the system default.
	rate: Mutex<u32>,
}

impl Narrator {
	pub fn new() -> Self {
		Self::default()
	}

	/// `None` = the system voice (System Settings → Accessibility → Spoken Content).
	pub fn set_voice(&self, voice: Option<String>) {
		*self.voice.lock() = voice.filter(|v| !v.trim().is_empty());
	}

	pub fn set_rate(&self, words_per_minute: u32) {
		*self.rate.lock() = words_per_minute;
	}

	/// Starts reading `markdown` aloud and returns at once.
	pub fn speak(&self, markdown: &str) -> Result<(), String> {
		self.stop();
		let text = speakable(markdown);
		if text.trim().is_empty() {
			return Ok(());
		}
		if !cfg!(target_os = "macos") {
			return Err("reading aloud isn't supported on this platform yet".into());
		}
		let mut cmd = Command::new("say");
		if let Some(v) = self.voice.lock().clone() {
			cmd.args(["-v", &v]);
		}
		let rate = *self.rate.lock();
		if rate > 0 {
			cmd.args(["-r", &rate.to_string()]);
		}
		// Text on stdin: no length limit, nothing to escape.
		let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| format!("couldn't start speech: {e}"))?;
		if let Some(mut stdin) = child.stdin.take() {
			let _ = stdin.write_all(text.as_bytes());
		}
		*self.child.lock() = Some(child);
		Ok(())
	}

	pub fn is_speaking(&self) -> bool {
		let mut child = self.child.lock();
		match child.as_mut().map(|c| c.try_wait()) {
			Some(Ok(None)) => true,
			Some(_) => {
				*child = None;
				false
			}
			None => false,
		}
	}

	pub fn stop(&self) {
		if let Some(mut c) = self.child.lock().take() {
			let _ = c.kill();
			let _ = c.wait();
		}
	}
}

impl Drop for Narrator {
	fn drop(&mut self) {
		self.stop();
	}
}

/// Markdown → what a person would say: no markup, code spans read as their
/// words, links as their text, headings and bullets as short sentences.
pub fn speakable(markdown: &str) -> String {
	let mut out = Vec::new();
	let mut in_code_block = false;
	for raw in markdown.lines() {
		let line = raw.trim();
		if line.starts_with("```") {
			in_code_block = !in_code_block;
			continue;
		}
		if in_code_block || line.is_empty() || line.chars().all(|c| matches!(c, '-' | '*' | '_' | '|' | ':' | ' ')) {
			continue;
		}
		let mut l = line.trim_start_matches('#').trim_start();
		l = l.strip_prefix("- ").or_else(|| l.strip_prefix("* ")).or_else(|| l.strip_prefix("> ")).unwrap_or(l);
		// "1. thing" → "thing"
		if let Some((n, rest)) = l.split_once(". ")
			&& !n.is_empty()
			&& n.len() <= 3
			&& n.chars().all(|c| c.is_ascii_digit())
		{
			l = rest;
		}
		let mut s = strip_links(l);
		for mark in ["**", "__", "`", "*"] {
			s = s.replace(mark, "");
		}
		let s = s.replace(" | ", ", ").replace('|', " ");
		let s = s.trim();
		if s.is_empty() {
			continue;
		}
		// Each line ends a sentence, so headings and bullets get a pause.
		if s.ends_with(['.', '!', '?', ':', ';', ',']) {
			out.push(s.to_string());
		} else {
			out.push(format!("{s}."));
		}
	}
	out.join(" ")
}

/// `[text](url)` → `text`.
fn strip_links(s: &str) -> String {
	let mut out = String::with_capacity(s.len());
	let mut rest = s;
	while let Some(open) = rest.find('[') {
		let after = &rest[open + 1..];
		match (after.find("]("), after.find(')')) {
			(Some(close), Some(end)) if close < end => {
				out.push_str(&rest[..open]);
				out.push_str(&after[..close]);
				rest = &after[end + 1..];
			}
			_ => {
				out.push_str(&rest[..=open]);
				rest = after;
			}
		}
	}
	out.push_str(rest);
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn markdown_reads_like_speech() {
		let md = "## Due this week\n- **Harbor Dental**: due Fri\n- Smith kitchen (`A-101`)\n\n```\ncode\n```\nSee [the plan](https://x.y/p).\n| a | b |\n|---|---|";
		assert_eq!(speakable(md), "Due this week. Harbor Dental: due Fri. Smith kitchen (A-101). See the plan. a, b.");
	}

	#[test]
	fn numbered_lists_and_italics() {
		assert_eq!(speakable("1. Call *Ana*\n2. Send the quote!"), "Call Ana. Send the quote!");
	}
}
