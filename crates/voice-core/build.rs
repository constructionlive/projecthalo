fn main() {
	// ScreenCaptureKit's Swift glue links libswift_Concurrency via @rpath; the
	// screencapturekit crate's own rpath doesn't reach dependent binaries.
	if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
		println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
	}
}
