//! What the live runner tests share: the console helper entry, run
//! directories, launches and cleanup. Every item here is used by each test
//! binary that includes it.

use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use devrounds_core::{LaunchSpec, RunOutput};
use devrounds_runner_windows::{ConsoleHelper, HELPER_ARG, WindowsRunner, WindowsUnit};

/// Upper bound for each test body; the stop tests may wait out the 10 s
/// grace.
const LIMIT: Duration = Duration::from_secs(60);

/// Not a test of its own: started with [`HELPER_ARG`] among its arguments,
/// the test binary is the runner's console helper, as `devrounds-executor
/// __console-ctrl` is in the shipped binary.
#[test]
fn helper_entry() {
    let args: Vec<OsString> = std::env::args_os().collect();
    if let Some(at) = args.iter().position(|arg| arg == HELPER_ARG) {
        let code = devrounds_runner_windows::console_ctrl_main(args[at + 1..].iter().cloned());
        std::process::exit(i32::from(code));
    }
}

/// The runner with this test binary as its console helper.
pub fn runner() -> WindowsRunner {
    let helper = ConsoleHelper {
        program: std::env::current_exe().expect("test binary path"),
        args: [
            "--exact",
            "support::helper_entry",
            "--nocapture",
            HELPER_ARG,
        ]
        .map(OsString::from)
        .into(),
    };
    WindowsRunner::default().with_console_helper(helper)
}

/// A run directory under Cargo's per-target temp dir, never the system one.
pub fn run_dir() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir")
}

/// A launch of `program` with `args` in `dir`, writing to its `stdout.raw`
/// and `stderr.raw`, with only the variables Windows programs need.
pub fn launch(dir: &Path, program: &str, args: &[&str]) -> LaunchSpec {
    let env: BTreeMap<String, String> = ["SystemRoot", "windir", "TEMP", "TMP", "PATH"]
        .iter()
        .filter_map(|name| Some(((*name).to_owned(), std::env::var(name).ok()?)))
        .collect();
    LaunchSpec {
        program: program.to_owned(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        cwd: dir.to_path_buf(),
        env,
        output: RunOutput {
            stdout: dir.join("stdout.raw"),
            stderr: dir.join("stderr.raw"),
        },
    }
}

/// The tree fixture's path as a string.
pub fn tree_fixture() -> String {
    devrounds_test_fixtures::tree_fixture_path()
        .to_string_lossy()
        .into_owned()
}

/// A tree-fixture launch with `args` in `dir`.
pub fn fixture(dir: &Path, args: &[&str]) -> LaunchSpec {
    launch(dir, &tree_fixture(), args)
}

/// The run's stdout so far.
pub fn stdout(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("stdout.raw")).expect("stdout.raw")
}

/// Ends the run's job when the test is done, passed or failed, then removes
/// its run directory once the job's processes are gone.
pub struct Cleanup(pub Arc<WindowsUnit>, pub PathBuf);

impl Drop for Cleanup {
    fn drop(&mut self) {
        self.0.terminate();
        remove_when_released(&self.1);
    }
}

/// Removes `dir`, retrying for up to 5 s. Every process of a run holds its
/// output files until it has exited, so this waits (bounded) for the
/// terminated tree to end; the `TempDir` would otherwise fail to delete it
/// silently and leave it under `CARGO_TARGET_TMPDIR`. Blocks the thread: the
/// processes end in the kernel without the runner's help.
pub fn remove_when_released(dir: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while std::fs::remove_dir_all(dir).is_err() && dir.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Runs `body` with the test's time limit. The fixture is resolved first, so
/// a cold `cargo build` of it is not charged to the limit (`body` is lazy and
/// only calls [`fixture`] once polled).
pub async fn bounded(body: impl Future<Output = ()>) {
    devrounds_test_fixtures::tree_fixture_path();
    tokio::time::timeout(LIMIT, body).await.expect("bounded");
}

/// Waits up to 10 s until the run's stdout holds `count` lines equal to
/// `line`, such as tree-fixture's `--ready` markers; panics with the output
/// on timeout.
pub async fn wait_for_lines(dir: &Path, line: &str, count: usize) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let out = std::fs::read_to_string(dir.join("stdout.raw")).unwrap_or_default();
        if out.lines().filter(|l| *l == line).count() >= count {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{count} × {line:?} not seen within 10 s; stdout: {out:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
