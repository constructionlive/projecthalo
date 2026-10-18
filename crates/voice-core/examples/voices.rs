//! List the system voices reading aloud can use.
//!
//!     cargo run -p voice-core --example voices

fn main() {
	for v in voice_core::tts::voices() {
		println!("{:<24} {}", v.name, v.language);
	}
}
