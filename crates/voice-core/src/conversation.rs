use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::Speaker;

/// One line of a conversation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Utterance {
	pub speaker: Speaker,
	pub text: String,
	/// When the speech started, unix milliseconds.
	pub at_ms: u64,
	/// Length of the audio, 0 for text added directly (agent replies).
	pub audio_ms: u64,
}

/// A speaker-tagged transcript, in the order lines were spoken.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Conversation {
	pub utterances: Vec<Utterance>,
}

impl Conversation {
	/// Inserts by start time, so a long utterance that finishes transcribing
	/// late still lands where it was spoken.
	pub fn push(&mut self, utterance: Utterance) {
		let at = self.utterances.partition_point(|u| u.at_ms <= utterance.at_ms);
		self.utterances.insert(at, utterance);
	}

	/// Adds text that never was audio, e.g. your own agent's reply.
	pub fn add_text(&mut self, speaker: Speaker, text: impl Into<String>) {
		self.push(Utterance { speaker, text: text.into(), at_ms: now_ms(), audio_ms: 0 });
	}

	pub fn clear(&mut self) {
		self.utterances.clear();
	}

	pub fn is_empty(&self) -> bool {
		self.utterances.is_empty()
	}

	/// `Speaker: text` lines, the shape an LLM prompt wants.
	pub fn to_plain_text(&self) -> String {
		self.utterances.iter().map(|u| format!("{}: {}", u.speaker.label(), u.text)).collect::<Vec<_>>().join("\n")
	}
}

pub fn now_ms() -> u64 {
	SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn line(speaker: Speaker, at_ms: u64, text: &str) -> Utterance {
		Utterance { speaker, text: text.into(), at_ms, audio_ms: 0 }
	}

	#[test]
	fn late_results_sort_by_start_time() {
		let mut c = Conversation::default();
		c.push(line(Speaker::User, 100, "first"));
		c.push(line(Speaker::User, 300, "third"));
		c.push(line(Speaker::System, 200, "second"));
		let texts: Vec<_> = c.utterances.iter().map(|u| u.text.as_str()).collect();
		assert_eq!(texts, ["first", "second", "third"]);
		assert_eq!(c.to_plain_text(), "You: first\nAI: second\nYou: third");
	}
}
