//! A run's output leaves the executor as `LogSegment` events through the
//! store outbox: every line once, in seq order, and the local copies go
//! once the control plane acked them. Runs are real `tree-fixture`
//! processes, as in `run_loop.rs`; here the test plays the control plane and
//! acks through the store.
#![cfg(windows)]

use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use base64::Engine;
use devrounds_core::{
    Error, JobSpec,
    clock::{Clock, TokioClock},
    gate::{MemoryPressure, PressureSample, PressureSource},
};
use devrounds_executor::{
    admission::{Admission, AdmissionConfig, DEFAULT_MEMORY_NEED},
    runs::{RunLoop, RunLoopDeps, SegmentOptions, run_log_options},
};
use devrounds_logs::{LogLine, LogOptions};
use devrounds_protocol::{ClientMessage, Offer, RunEvent, ServerMessage, decode_client};
use devrounds_runner_windows::{ConsoleHelper, HELPER_ARG, WindowsRunner};
use devrounds_store::Store;
use tokio::sync::watch;

const LIMIT: Duration = Duration::from_secs(60);
const GIB: u64 = 1 << 30;
const ENV_ALLOW: [&str; 5] = ["SystemRoot", "windir", "TEMP", "TMP", "PATH"];

/// The test binary doubles as the runner's console helper (see `run_loop.rs`).
#[test]
fn helper_entry() {
    let args: Vec<OsString> = std::env::args_os().collect();
    if let Some(at) = args.iter().position(|arg| arg == HELPER_ARG) {
        let code = devrounds_runner_windows::console_ctrl_main(args[at + 1..].iter().cloned());
        std::process::exit(i32::from(code));
    }
}

struct Roomy;

#[async_trait]
impl PressureSource for Roomy {
    fn name(&self) -> &'static str {
        "roomy"
    }

    async fn sample(&self) -> Result<PressureSample, Error> {
        Ok(PressureSample {
            cpu_percent: Some(5.0),
            memory: Some(MemoryPressure::Normal),
            cpu_stall_percent: None,
        })
    }

    async fn available_memory(&self) -> Result<Option<u64>, Error> {
        Ok(Some(64 * GIB))
    }
}

struct Harness {
    home: tempfile::TempDir,
    store: Store,
    runs: RunLoop,
    _connected: watch::Sender<bool>,
}

async fn harness(log_options: SegmentOptions) -> Harness {
    devrounds_runner_windows::prepare_executor_process().expect("prepare");
    let home = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
    let store = Store::open(&home.path().join("executor.db"))
        .await
        .expect("store");
    let clock: Arc<dyn Clock> = Arc::new(TokioClock::new());
    let admission = Arc::new(Admission::new(
        AdmissionConfig::default(),
        Arc::new(Roomy),
        clock,
    ));
    let helper = ConsoleHelper {
        program: std::env::current_exe().expect("test binary path"),
        args: ["--exact", "helper_entry", "--nocapture", HELPER_ARG]
            .map(OsString::from)
            .into(),
    };
    let (connected, connected_rx) = watch::channel(true);
    let runs = RunLoop::new(RunLoopDeps {
        store: store.clone(),
        admission,
        runner: WindowsRunner::default().with_console_helper(helper),
        connected: connected_rx,
        runs_dir: home.path().join("runs"),
        machine_env: std::env::vars().collect::<BTreeMap<_, _>>(),
        log_options,
        telemetry: None,
    });
    Harness {
        home,
        store,
        runs,
        _connected: connected,
    }
}

fn offer(run: &str, args: &[&str], cwd: &Path) -> ServerMessage {
    ServerMessage::Offer(Offer {
        run: run.to_owned(),
        job: JobSpec {
            job_type: "check".to_owned(),
            program: devrounds_test_fixtures::tree_fixture_path()
                .to_string_lossy()
                .into_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            cwd: cwd.display().to_string(),
            env_allow: ENV_ALLOW.map(str::to_owned).into(),
            timeout_s: 600,
            env_set: Default::default(),
            environment_probe: None,
            stall_s: None,
        },
        memory_need: DEFAULT_MEMORY_NEED,
        trace_parent: None,
    })
}

/// Every event in the outbox, in seq order, once `RunFinished` is there.
async fn until_finished(store: &Store) -> Vec<(u64, RunEvent)> {
    let mut appended = store.appended();
    loop {
        let events: Vec<(u64, RunEvent)> = store
            .pending_after(0)
            .await
            .expect("outbox")
            .into_iter()
            .map(|(seq, frame)| match decode_client(&frame).expect("frame") {
                ClientMessage::Event(event) => (seq, event.event),
                other => panic!("the outbox holds only events, got {other:?}"),
            })
            .collect();
        if events
            .iter()
            .any(|(_, event)| matches!(event, RunEvent::RunFinished { .. }))
        {
            return events;
        }
        appended.changed().await.expect("store alive");
    }
}

/// A segment as the control plane reads it: zstd JSON lines, one `LogLine` each.
struct Segment {
    first_seq: u64,
    last_seq: u64,
    records: u32,
    lines: Vec<LogLine>,
}

fn segments(events: &[(u64, RunEvent)]) -> Vec<Segment> {
    events
        .iter()
        .filter_map(|(_, event)| match event {
            RunEvent::LogSegment {
                first_seq,
                last_seq,
                records,
                zstd_base64,
                ..
            } => {
                let compressed = base64::engine::general_purpose::STANDARD
                    .decode(zstd_base64)
                    .expect("base64");
                let mut text = String::new();
                zstd::stream::read::Decoder::new(compressed.as_slice())
                    .expect("zstd")
                    .read_to_string(&mut text)
                    .expect("zstd text");
                let lines = text
                    .lines()
                    .map(|line| serde_json::from_str(line).expect("a LogLine"))
                    .collect();
                Some(Segment {
                    first_seq: *first_seq,
                    last_seq: *last_seq,
                    records: *records,
                    lines,
                })
            }
            _ => None,
        })
        .collect()
}

/// 64 KiB segments: 20000 short lines (about 700 KiB of records) make several.
fn small_segments() -> SegmentOptions {
    let production = run_log_options();
    SegmentOptions {
        log: LogOptions {
            segment_bytes: 64 * 1024,
            ..production.log.clone()
        },
        ..production
    }
}

/// Segment files (`*.log`, `*.log.zst`) left under `dir`.
fn segment_files(dir: &Path) -> Vec<PathBuf> {
    match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                name.ends_with(".log") || name.ends_with(".log.zst")
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[tokio::test]
async fn segments_ship_through_the_outbox_and_are_deleted_after_ack() {
    tokio::time::timeout(LIMIT, async {
        // 20000 short lines are about 700 KiB of records: small segments make several.
        let h = harness(small_segments()).await;
        h.runs
            .handle(offer("run-s1", &["--print", "20000"], h.home.path()));
        let events = until_finished(&h.store).await;

        let shipped = segments(&events);
        assert!(shipped.len() >= 2, "{} segments", shipped.len());
        // The last segment is sealed before the run reports its end.
        let last_segment = events
            .iter()
            .rposition(|(_, event)| matches!(event, RunEvent::LogSegment { .. }))
            .expect("a LogSegment");
        let finished = events
            .iter()
            .position(|(_, event)| matches!(event, RunEvent::RunFinished { .. }))
            .expect("RunFinished");
        assert!(last_segment < finished);

        let mut seqs = Vec::new();
        for segment in &shipped {
            assert_eq!(segment.records as usize, segment.lines.len());
            assert_eq!(
                segment.lines.first().map(|l| l.seq),
                Some(segment.first_seq)
            );
            assert_eq!(segment.lines.last().map(|l| l.seq), Some(segment.last_seq));
            for line in &segment.lines {
                assert_eq!(line.text, format!("line {}", line.seq));
                seqs.push(line.seq);
            }
        }
        assert_eq!(seqs, (1..=20000).collect::<Vec<u64>>());

        let run_dir = h.home.path().join("runs").join("run-s1");
        let segment_dir = run_dir.join("segments");
        assert!(!segment_files(&segment_dir).is_empty(), "kept until acked");
        assert!(run_dir.join("stdout.raw").exists(), "kept until acked");

        let highest = events.last().map(|(seq, _)| *seq).expect("events");
        h.store.ack_through(highest).await.expect("ack");
        while !segment_files(&segment_dir).is_empty() || run_dir.join("stdout.raw").exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("bounded");
}

#[tokio::test]
async fn a_segment_that_cannot_ship_keeps_the_run_output_on_disk() {
    tokio::time::timeout(LIMIT, async {
        // No segment fits the frame limit: each is lost to the control plane.
        let h = harness(SegmentOptions {
            max_event_bytes: 1024,
            ..small_segments()
        })
        .await;
        h.runs
            .handle(offer("run-s3", &["--print", "20000"], h.home.path()));
        let events = until_finished(&h.store).await;
        assert!(segments(&events).is_empty(), "nothing over the limit ships");

        // Everything is acked and the run is over; its output is the only copy left.
        let highest = events.last().map(|(seq, _)| *seq).expect("events");
        h.store.ack_through(highest).await.expect("ack");
        tokio::time::sleep(Duration::from_millis(500)).await;
        let run_dir = h.home.path().join("runs").join("run-s3");
        assert!(run_dir.join("stdout.raw").exists(), "raw output kept");
        assert!(
            !segment_files(&run_dir.join("segments")).is_empty(),
            "segments kept"
        );
    })
    .await
    .expect("bounded");
}

#[tokio::test]
async fn partial_last_line_and_invalid_utf8_are_kept() {
    tokio::time::timeout(LIMIT, async {
        let h = harness(run_log_options()).await;
        // `ok\n` then 0xFF 0xFE (never UTF-8) and `partial`, with no newline.
        h.runs.handle(offer(
            "run-s2",
            &["--raw-hex", "6f6b0afffe7061727469616c"],
            h.home.path(),
        ));
        let events = until_finished(&h.store).await;

        let lines: Vec<String> = segments(&events)
            .into_iter()
            .flat_map(|segment| segment.lines)
            .map(|line| line.text)
            .collect();
        assert!(lines.len() >= 2, "{lines:?}");
        assert_eq!(
            lines[lines.len() - 2..],
            ["ok".to_owned(), "\u{fffd}\u{fffd}partial".to_owned()]
        );
    })
    .await
    .expect("bounded");
}
