//! The sampler feeds a held start slot every second and ends with the run's
//! summary. Runs `tree-fixture` in a job of its own.
#![cfg(windows)]

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use devrounds_core::{
    LaunchSpec, RunOutput,
    gate::{Release, SlotHandle, StartSlot},
};
use devrounds_executor::Sampler;
use devrounds_metrics::Subject;
use devrounds_runner_windows::{WindowsRunner, WindowsUnit};

/// Upper bound for the test body.
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

/// What the sampler reported to the slot.
#[derive(Default)]
struct Reports {
    memory: Mutex<Vec<u64>>,
    cpu: Mutex<Vec<f64>>,
}

/// A slot handle that records the reports and is never released.
struct Recorder(Arc<Reports>);

impl SlotHandle for Recorder {
    fn release(&self, _reason: Release) {}

    fn report_cpu(&self, cpu_percent: f64) {
        let mut cpu = self.0.cpu.lock().unwrap_or_else(PoisonError::into_inner);
        cpu.push(cpu_percent);
    }

    fn report_memory(&self, footprint_bytes: u64) {
        let mut memory = self.0.memory.lock().unwrap_or_else(PoisonError::into_inner);
        memory.push(footprint_bytes);
    }

    fn released(&self) -> Option<Release> {
        None
    }
}

/// Starts `tree-fixture` with `args` in `dir`, with only the variables
/// Windows programs need.
async fn start(dir: &Path, args: &[&str]) -> Arc<WindowsUnit> {
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
    WindowsRunner::default()
        .spawn_unit(spec)
        .await
        .expect("spawn")
}

/// A 3 s run holding 64 MiB under a held slot: sampled about every second,
/// each reading reported to the slot and the channel, and summarised with
/// the job's peak.
#[tokio::test]
async fn sampler_feeds_a_held_slot_every_second() {
    devrounds_test_fixtures::tree_fixture_path();
    tokio::time::timeout(LIMIT, async {
        let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
        let unit = start(dir.path(), &["--alloc-mb", "64", "--run-ms", "3000"]).await;
        let _cleanup = Cleanup(Arc::clone(&unit), dir.path().to_path_buf());
        let reports = Arc::new(Reports::default());
        let slot = StartSlot::new(Recorder(Arc::clone(&reports)));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let sampler = Sampler::spawn("run-1", Arc::clone(&unit), Some(slot), tx);
        unit.wait_report().await.expect("report");
        let summary = sampler.finish().await;

        // A 5 s cadence would have sampled once.
        assert!(summary.samples >= 2, "{summary:?}");
        assert!(summary.footprint.peak >= 64 << 20, "{summary:?}");
        assert_eq!(summary.run, "run-1");
        let memory = reports
            .memory
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        assert_eq!(memory.len() as u64, summary.samples, "{memory:?}");
        let cpu = reports.cpu.lock().unwrap_or_else(PoisonError::into_inner);
        // The first reading's CPU is a first-sight 0 and is not reported.
        assert_eq!(cpu.len() + 1, memory.len(), "{cpu:?}");
        let mut sent = 0;
        while let Ok(sample) = rx.try_recv() {
            assert_eq!(
                sample.subject,
                Subject::Run {
                    run: "run-1".into()
                }
            );
            sent += 1;
        }
        assert_eq!(sent, summary.samples);
    })
    .await
    .expect("bounded");
}
