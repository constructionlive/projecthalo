//! Cuts a continuous 16 kHz stream into utterances with the earshot VAD.

use std::collections::VecDeque;

use earshot::Detector;

/// earshot works on exactly 256-sample (16 ms) frames.
pub const FRAME: usize = 256;
const FRAME_MS: usize = 16;

#[derive(Debug, Clone, Copy)]
pub struct SegmenterConfig {
	/// Voice probability at or above which a frame counts as speech.
	pub threshold: f32,
	/// Audio kept from before speech starts, so first syllables aren't clipped.
	pub pre_roll_ms: usize,
	/// Silence that ends an utterance.
	pub end_silence_ms: usize,
	/// Utterances shorter than this (speech only) are dropped as noise.
	pub min_speech_ms: usize,
	/// An utterance is cut here even if speech continues.
	pub max_utterance_ms: usize,
}

impl Default for SegmenterConfig {
	fn default() -> Self {
		Self { threshold: 0.5, pre_roll_ms: 320, end_silence_ms: 700, min_speech_ms: 250, max_utterance_ms: 30_000 }
	}
}

pub struct Segmenter {
	config: SegmenterConfig,
	detector: Box<Detector>,
	/// Leftover samples that don't fill a frame yet.
	pending: Vec<f32>,
	pre_roll: VecDeque<f32>,
	current: Vec<f32>,
	in_speech: bool,
	speech_frames: usize,
	silent_frames: usize,
}

impl Segmenter {
	pub fn new(config: SegmenterConfig) -> Self {
		Self { config, detector: Detector::default_boxed(), pending: Vec::with_capacity(FRAME), pre_roll: VecDeque::new(), current: Vec::new(), in_speech: false, speech_frames: 0, silent_frames: 0 }
	}

	/// True while an utterance is in progress.
	pub fn in_speech(&self) -> bool {
		self.in_speech
	}

	/// Feeds samples; calls `emit` with each finished utterance.
	pub fn push(&mut self, samples: &[f32], mut emit: impl FnMut(Vec<f32>)) {
		self.pending.extend_from_slice(samples);
		let mut offset = 0;
		while self.pending.len() - offset >= FRAME {
			let frame: [f32; FRAME] = self.pending[offset..offset + FRAME].try_into().unwrap();
			offset += FRAME;
			if let Some(utterance) = self.process_frame(&frame) {
				emit(utterance);
			}
		}
		self.pending.drain(..offset);
	}

	/// Ends the stream: returns the in-progress utterance, if long enough.
	pub fn flush(&mut self) -> Option<Vec<f32>> {
		let out = if self.in_speech {
			self.current.extend_from_slice(&self.pending);
			self.finish()
		} else {
			None
		};
		self.pending.clear();
		self.pre_roll.clear();
		self.detector.reset();
		out
	}

	fn process_frame(&mut self, frame: &[f32; FRAME]) -> Option<Vec<f32>> {
		let voiced = self.detector.predict_f32(frame) >= self.config.threshold;

		if !self.in_speech {
			if voiced {
				self.in_speech = true;
				self.speech_frames = 1;
				self.silent_frames = 0;
				self.current.clear();
				self.current.extend(self.pre_roll.drain(..));
				self.current.extend_from_slice(frame);
			} else {
				self.pre_roll.extend(frame.iter().copied());
				let max = self.config.pre_roll_ms / FRAME_MS * FRAME;
				while self.pre_roll.len() > max {
					self.pre_roll.pop_front();
				}
			}
			return None;
		}

		self.current.extend_from_slice(frame);
		if voiced {
			self.speech_frames += 1;
			self.silent_frames = 0;
		} else {
			self.silent_frames += 1;
		}

		let ended = self.silent_frames * FRAME_MS >= self.config.end_silence_ms;
		let too_long = self.current.len() / FRAME * FRAME_MS >= self.config.max_utterance_ms;
		if ended || too_long {
			return self.finish();
		}
		None
	}

	fn finish(&mut self) -> Option<Vec<f32>> {
		self.in_speech = false;
		self.silent_frames = 0;
		let speech_ms = self.speech_frames * FRAME_MS;
		self.speech_frames = 0;
		let utterance = std::mem::take(&mut self.current);
		(speech_ms >= self.config.min_speech_ms).then_some(utterance)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn silence_emits_nothing() {
		let mut seg = Segmenter::new(SegmenterConfig::default());
		let mut out = Vec::new();
		seg.push(&vec![0.0; 16_000 * 3], |u| out.push(u));
		assert!(out.is_empty());
		assert!(seg.flush().is_none());
	}

	#[test]
	fn partial_frames_are_buffered() {
		let mut seg = Segmenter::new(SegmenterConfig::default());
		seg.push(&[0.0; 100], |_| {});
		assert_eq!(seg.pending.len(), 100);
		seg.push(&[0.0; 200], |_| {});
		assert_eq!(seg.pending.len(), 300 - FRAME);
	}
}
