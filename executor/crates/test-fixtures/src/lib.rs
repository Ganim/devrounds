//! Test programs for the executor crates. Other crates take this crate as a
//! dev-dependency and call [`tree_fixture_path`]: Cargo sets
//! `CARGO_BIN_EXE_<name>` only for a package's own tests, and a
//! dev-dependency's binaries are not built.

use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

/// The `tree-fixture` executable (usage in `src/bin/tree-fixture.rs`),
/// built on the first call in each test process.
///
/// It is built by `cargo build` into `target/fixture`, a target directory of
/// its own: Cargo may still hold the lock on the main one while tests run.
/// Runs from the workspace, so the pinned toolchain applies. Panics when the
/// build fails, which fails the calling test.
pub fn tree_fixture_path() -> PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(build).clone()
}

/// Builds `tree-fixture` and returns its path.
fn build() -> PathBuf {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let target = workspace.join("target").join("fixture");
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let status = Command::new(cargo)
        .current_dir(&workspace)
        .args([
            "build",
            "--quiet",
            // Never rewrite Cargo.lock or reach the network from a test run;
            // the outer build already fetched every dependency.
            "--locked",
            "--offline",
            "-p",
            env!("CARGO_PKG_NAME"),
            "--bin",
            "tree-fixture",
        ])
        .arg("--target-dir")
        .arg(&target)
        .status()
        .expect("cargo runs");
    assert!(status.success(), "building tree-fixture failed: {status}");
    target
        .join("debug")
        .join(format!("tree-fixture{}", std::env::consts::EXE_SUFFIX))
}
