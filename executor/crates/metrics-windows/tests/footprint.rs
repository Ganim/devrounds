//! A run's footprint is the private bytes (commit) of its whole job, never
//! its working set, and its peak is exact even between samples (spec §16.5).
//! Each test runs `tree-fixture` in a job of its own.
#![cfg(windows)]

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use devrounds_core::{LaunchSpec, RunOutput};
use devrounds_metrics::{RunTracker, Sample, Subject, unix_ms};
use devrounds_metrics_windows::WindowsSource;
use devrounds_runner_windows::{WindowsRunner, WindowsUnit};
use devrounds_sys_windows::usage::process_usage;

/// Upper bound for each test body.
const LIMIT: Duration = Duration::from_secs(60);

/// Ends the run's job when the test is done, passed or failed, then removes
/// its run directory once the job's processes are gone.
struct Cleanup(Arc<WindowsUnit>, PathBuf);

impl Drop for Cleanup {
    fn drop(&mut self) {
        self.0.terminate();
        // Every process holds the run's output files until it has exited, so
        // wait (bounded) for the terminated tree to end.
        let deadline = Instant::now() + Duration::from_secs(5);
        while std::fs::remove_dir_all(&self.1).is_err()
            && self.1.exists()
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

/// Runs `body` with the test's time limit. The fixture is built first, so a
/// cold build is not charged to the limit.
async fn bounded(body: impl Future<Output = ()>) {
    devrounds_test_fixtures::tree_fixture_path();
    tokio::time::timeout(LIMIT, body).await.expect("bounded");
}

/// A run directory under Cargo's per-target temp dir, never the system one.
fn run_dir() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir")
}

/// Starts `tree-fixture` with `args` in `dir`, with only the variables
/// Windows programs need.
async fn start(dir: &Path, args: &[&str]) -> (Arc<WindowsUnit>, Cleanup) {
    let env: BTreeMap<String, String> = ["SystemRoot", "windir", "TEMP", "TMP", "PATH"]
        .iter()
        .filter_map(|name| Some(((*name).to_owned(), std::env::var(name).ok()?)))
        .collect();
    let spec = LaunchSpec {
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
    };
    let unit = WindowsRunner::default()
        .spawn_unit(spec)
        .await
        .expect("spawn");
    let cleanup = Cleanup(Arc::clone(&unit), dir.to_path_buf());
    (unit, cleanup)
}

/// Waits up to 10 s until the run's stdout holds `count` `ready` lines.
async fn wait_ready(dir: &Path, count: usize) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let out = std::fs::read_to_string(dir.join("stdout.raw")).unwrap_or_default();
        if out.lines().filter(|line| *line == "ready").count() >= count {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{count} × ready not seen within 10 s; stdout: {out:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 256 MiB committed and never written count in full, though almost none of
/// it is resident.
#[tokio::test]
async fn footprint_counts_commit_not_working_set() {
    bounded(async {
        let dir = run_dir();
        let (unit, _cleanup) = start(
            dir.path(),
            &["--alloc-mb", "256", "--run-ms", "30000", "--ready"],
        )
        .await;
        wait_ready(dir.path(), 1).await;
        let members = unit.job_members().await.expect("members");
        let sample = WindowsSource::new().sample_run(&members);
        assert!(sample.footprint_bytes >= 256 << 20, "{sample:?}");
        let leader = unit.identity();
        let usage = process_usage(leader.pid, leader.start_time)
            .expect("usage")
            .expect("leader alive");
        assert!(usage.working_set < 64 << 20, "{usage:?}");
    })
    .await;
}

/// Two children holding 100 MiB each after their leader exited: the run's
/// footprint is their sum.
#[tokio::test]
async fn tree_footprint_sums_members() {
    bounded(async {
        let dir = run_dir();
        let (unit, _cleanup) = start(
            dir.path(),
            &[
                "--children",
                "2",
                "--alloc-mb",
                "100",
                "--linger-ms",
                "3000",
                "--ready",
            ],
        )
        .await;
        // The leader and both children.
        wait_ready(dir.path(), 3).await;
        let members = unit.job_members().await.expect("members");
        let sample = WindowsSource::new().sample_run(&members);
        assert!(
            sample.footprint_bytes >= 200 << 20,
            "{sample:?} of {members:?}"
        );
    })
    .await;
}

/// 300 MiB held for 200 ms and sampled every 5 s: no sample sees it, the
/// job's peak does.
#[tokio::test]
async fn peak_is_exact_between_samples() {
    bounded(async {
        let dir = run_dir();
        let (unit, _cleanup) = start(
            dir.path(),
            &[
                "--alloc-mb",
                "300",
                "--alloc-hold-ms",
                "200",
                "--run-ms",
                "6000",
            ],
        )
        .await;
        let source = WindowsSource::new();
        let mut tracker = RunTracker::default();
        tracker.start("peak".into(), unix_ms(std::time::SystemTime::now()));
        let cadence = Duration::from_secs(5);
        let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + cadence, cadence);
        loop {
            tokio::select! {
                report = unit.wait_report() => {
                    report.expect("report");
                    break;
                }
                _ = ticks.tick() => {
                    let members = unit.job_members().await.expect("members");
                    let reading = source.sample_run(&members);
                    tracker.observe(&Sample {
                        subject: Subject::Run { run: "peak".into() },
                        cpu_percent: reading.cpu_percent,
                        footprint_bytes: reading.footprint_bytes,
                        rss_bytes: reading.rss_bytes,
                        ts_ms: unix_ms(std::time::SystemTime::now()),
                    });
                }
            }
        }
        let sampled = tracker.current("peak").expect("tracked");
        assert!(sampled.samples >= 1, "{sampled:?}");
        assert!(sampled.footprint.peak < 300_000_000, "{sampled:?}");
        let job_peak = unit.peak_memory().await.expect("job peak");
        let summary = tracker
            .finish("peak", unix_ms(std::time::SystemTime::now()), job_peak)
            .expect("summary");
        assert!(summary.footprint.peak >= 300_000_000, "{summary:?}");
    })
    .await;
}
