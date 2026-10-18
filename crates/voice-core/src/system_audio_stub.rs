//! System audio capture is macOS-only for now; elsewhere this reports so.

use crossbeam_channel::Sender;

use crate::audio::EchoGate;
use crate::service::Command;
use crate::{Error, Result};

pub struct SystemAudioCapture;

impl SystemAudioCapture {
	pub fn new(_commands: Sender<Command>, _gate: EchoGate) -> Self {
		Self
	}

	pub fn is_running(&self) -> bool {
		false
	}

	pub fn level(&self) -> f32 {
		0.0
	}

	pub fn start(&mut self) -> Result<()> {
		Err(Error::Other("system audio capture isn't supported on this platform yet".into()))
	}

	pub fn stop(&mut self) -> Result<()> {
		Ok(())
	}
}
