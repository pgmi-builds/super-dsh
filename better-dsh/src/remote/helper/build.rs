// Compile-time stamps: version + target triple. Set by build.sh; defaults keep ad-hoc builds honest.
fn main() {
    println!("cargo:rerun-if-env-changed=SUPERD_RUN_VER");
    println!("cargo:rerun-if-env-changed=SUPERD_RUN_TARGET");
    let ver = std::env::var("SUPERD_RUN_VER").unwrap_or_else(|_| "0.0.0-dev".into());
    let target = std::env::var("SUPERD_RUN_TARGET").unwrap_or_else(|_| "unknown".into());
    println!("cargo:rustc-env=SUPERD_RUN_VER={ver}");
    println!("cargo:rustc-env=SUPERD_RUN_TARGET={target}");
}
