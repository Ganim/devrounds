//! Job Object supervision of runs on DevRounds' tree fixture: every
//! descendant is a job member and cannot break away, stops are graceful
//! first and end the whole tree within the grace period, handles can be
//! dropped without stopping the run, members outliving the leader are swept,
//! and output lands in files the run owns.
#![cfg(windows)]

use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use devrounds_core::{LaunchSpec, ProcessIdentity, RunOutput, StopPolicy};
use devrounds_runner_windows::{ConsoleHelper, HELPER_ARG, WindowsRunner, WindowsUnit};
use devrounds_sys_windows::proc;

/// Upper bound for each test body; the sweep and stop tests wait out the
/// 10 s grace.
const LIMIT: Duration = Duration::from_secs(60);

/// Not a test of its own: started with [`HELPER_ARG`] among its arguments,
/// this binary is the runner's console helper, as `devrounds-executor
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
fn runner() -> WindowsRunner {
    let helper = ConsoleHelper {
        program: std::env::current_exe().expect("test binary path"),
        args: ["--exact", "helper_entry", "--nocapture", HELPER_ARG]
            .map(OsString::from)
            .into(),
    };
    WindowsRunner::default().with_console_helper(helper)
}

/// A run directory under Cargo's per-target temp dir, never the system one.
fn run_dir() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir")
}

/// A tree-fixture launch with `args`, writing to `dir`'s `stdout.raw` and
/// `stderr.raw`.
fn fixture(dir: &Path, args: &[&str]) -> LaunchSpec {
    let env: BTreeMap<String, String> = ["SystemRoot", "windir", "TEMP", "TMP", "PATH"]
        .iter()
        .filter_map(|name| Some(((*name).to_owned(), std::env::var(name).ok()?)))
        .collect();
    LaunchSpec {
        program: devrounds_test_fixtures::tree_fixture_path()
            .to_string_lossy()
            .into_owned(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        cwd: dir.to_path_buf(),
        env,
        output: RunOutput {
            stdout: dir.join("stdout.raw"),
            stderr: dir.join("stderr.raw"),
        },
    }
}

/// The run's stdout so far.
fn stdout(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("stdout.raw")).expect("stdout.raw")
}

/// Ends the run's job when the test is done, passed or failed.
struct Cleanup(Arc<WindowsUnit>);

impl Drop for Cleanup {
    fn drop(&mut self) {
        self.0.terminate();
    }
}

/// Ends recorded processes when the test is done, for runs whose handles the
/// test dropped on purpose.
struct KillOnDrop(Vec<ProcessIdentity>);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = proc::terminate_verified(p.pid, p.start_time, 1);
        }
    }
}

/// Whether `p` is still the process that was recorded.
fn alive(p: &ProcessIdentity) -> bool {
    proc::matches(p.pid, p.start_time).expect("process lookup")
}

/// Runs inherit the ignore-Ctrl-C flag, which the terminal that started the
/// tests may have set; the executor clears it at startup the same way.
fn accept_ctrl_c() {
    devrounds_sys_windows::console::set_ctrl_c_ignored(false).expect("accept Ctrl-C");
}

/// Runs `body` with the test's time limit.
async fn bounded(body: impl Future<Output = ()>) {
    tokio::time::timeout(LIMIT, body).await.expect("bounded");
}

/// A leader with two children of two children each: seven processes, all of
/// them in the job (the console host is left out).
#[tokio::test]
async fn every_descendant_is_a_job_member() {
    bounded(async {
        let dir = run_dir();
        let spec = fixture(
            dir.path(),
            &[
                "--children",
                "2",
                "--depth",
                "2",
                "--linger-ms",
                "5000",
                "--run-ms",
                "5000",
            ],
        );
        let unit = runner().spawn_unit(spec).await.expect("spawn");
        let _cleanup = Cleanup(unit.clone());
        let started = Instant::now();
        let mut members = Vec::new();
        while started.elapsed() < Duration::from_secs(3) {
            members = unit.job_members().await.expect("members");
            if members.len() == 7 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(members.len(), 7, "{members:?}");
        assert!(members.contains(&unit.run_identity().leader));
    })
    .await;
}

/// The job does not allow breakaway, so a member asking for it is refused.
#[tokio::test]
async fn breakaway_is_refused() {
    bounded(async {
        let dir = run_dir();
        let unit = runner()
            .spawn_unit(fixture(dir.path(), &["--breakaway"]))
            .await
            .expect("spawn");
        let _cleanup = Cleanup(unit.clone());
        let report = unit.wait_report().await.expect("report");
        assert_eq!(report.outcome.code, Some(0));
        let out = stdout(dir.path());
        assert!(out.contains("breakaway: denied"), "{out}");
    })
    .await;
}

/// SIGTERM goes out as Ctrl-C first; a run that handles it exits on its own
/// without escalation.
#[tokio::test]
async fn graceful_stop_lets_ctrl_c_handlers_run() {
    accept_ctrl_c();
    bounded(async {
        let dir = run_dir();
        let unit = runner()
            .spawn_unit(fixture(dir.path(), &["--ctrl-c", "bye"]))
            .await
            .expect("spawn");
        let _cleanup = Cleanup(unit.clone());
        // Let the fixture install its handler.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let report = unit
            .stop_with_report(StopPolicy::default())
            .await
            .expect("stop");
        let stop = report.stop.expect("stop outcome");
        assert!(!stop.escalated, "{report:?}");
        let out = stdout(dir.path());
        assert!(out.contains("bye"), "{out}");
    })
    .await;
}

/// A tree that ignores Ctrl-C is terminated at the 10 s grace, and nothing
/// of it survives.
#[tokio::test]
async fn stop_ends_the_tree_within_grace() {
    accept_ctrl_c();
    bounded(async {
        let dir = run_dir();
        let unit = runner()
            .spawn_unit(fixture(
                dir.path(),
                &["--children", "3", "--ctrl-c", "ignore"],
            ))
            .await
            .expect("spawn");
        let _cleanup = Cleanup(unit.clone());
        let mut members = Vec::new();
        for _ in 0..50 {
            members = unit.job_members().await.expect("members");
            if members.len() == 4 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(members.len(), 4, "{members:?}");
        tokio::time::sleep(Duration::from_millis(500)).await;
        let started = Instant::now();
        let report = unit
            .stop_with_report(StopPolicy::default())
            .await
            .expect("stop");
        assert!(started.elapsed() < Duration::from_secs(12));
        assert!(report.stop.expect("stop outcome").escalated, "{report:?}");
        let survivors: Vec<_> = members.iter().filter(|p| alive(p)).collect();
        assert!(survivors.is_empty(), "{survivors:?}");
    })
    .await;
}

/// Handles are not ownership of the run: dropping all of them leaves it
/// running.
#[tokio::test]
async fn dropping_the_handles_leaves_the_run_running() {
    bounded(async {
        let dir = run_dir();
        let unit = runner()
            .spawn_unit(fixture(dir.path(), &["--run-ms", "30000"]))
            .await
            .expect("spawn");
        let leader = unit.run_identity().leader;
        let _kill = KillOnDrop(vec![leader]);
        drop(unit);
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(alive(&leader));
    })
    .await;
}

/// Once the leader exits, members still alive get the 10 s grace, are then
/// terminated and are listed as swept; the leader's code is the run's.
#[tokio::test]
async fn leader_exit_sweeps_lingering_members() {
    bounded(async {
        let dir = run_dir();
        let unit = runner()
            .spawn_unit(fixture(
                dir.path(),
                &["--children", "2", "--linger-ms", "60000", "--exit", "3"],
            ))
            .await
            .expect("spawn");
        let _cleanup = Cleanup(unit.clone());
        let report = unit.wait_report().await.expect("report");
        assert_eq!(report.outcome.code, Some(3));
        assert_eq!(report.swept.len(), 2, "{report:?}");
        assert!(report.escaped.is_empty(), "{report:?}");
        assert!(report.swept.iter().all(|p| !alive(&p.identity())));
    })
    .await;
}

/// Output goes to the run's files, which the executor does not hold: it is
/// all there after the handles were dropped while the run still ran.
#[tokio::test]
async fn output_goes_to_run_owned_files() {
    bounded(async {
        let dir = run_dir();
        let unit = runner()
            .spawn_unit(fixture(dir.path(), &["--print", "100", "--run-ms", "1000"]))
            .await
            .expect("spawn");
        let leader = unit.run_identity().leader;
        let _kill = KillOnDrop(vec![leader]);
        drop(unit);
        assert!(
            alive(&leader),
            "the leader exited before the handles were dropped"
        );
        let waited = tokio::task::spawn_blocking(move || {
            proc::wait_exit(leader.pid, Duration::from_secs(20))
        })
        .await
        .expect("join")
        .expect("wait");
        assert!(waited);
        let out = stdout(dir.path());
        assert_eq!(out.lines().count(), 100, "{out}");
        assert_eq!(out.lines().last(), Some("line 100"));
    })
    .await;
}

/// The run identity is the leader's `(pid, start time)` plus this boot.
#[tokio::test]
async fn identity_carries_boot_id() {
    bounded(async {
        let dir = run_dir();
        let unit = runner()
            .spawn_unit(fixture(dir.path(), &["--run-ms", "5000"]))
            .await
            .expect("spawn");
        let _cleanup = Cleanup(unit.clone());
        let identity = unit.run_identity();
        assert_eq!(identity.boot_id, proc::boot_id().expect("boot id"));
        assert_eq!(identity.leader, unit.identity());
        assert!(alive(&identity.leader));
    })
    .await;
}
