//! The run loop end to end without a socket: messages go straight to
//! `RunLoop::handle`, and the events come back through the store's outbox,
//! which nothing acks here. Every run is a real `tree-fixture` in a job of
//! its own, spawned by the Windows runner.
#![cfg(windows)]

use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use devrounds_core::{
    Error, JobSpec,
    clock::{Clock, TokioClock},
    gate::{MemoryPressure, PressureSample, PressureSource, StartSlot},
};
use devrounds_executor::{
    admission::{Admission, AdmissionConfig, AdmissionStep, DEFAULT_MEMORY_NEED},
    runs::{RunLoop, RunLoopDeps},
};
use devrounds_protocol::{
    ClientMessage, FinishReason, Offer, RunEvent, ServerMessage, StepOutcome, Stop, StopReason,
    decode_client,
};
use devrounds_runner_windows::{ConsoleHelper, HELPER_ARG, WindowsRunner};
use devrounds_store::Store;
use tokio::sync::watch;

/// Upper bound for each test body; a stop may wait out part of its 10 s grace.
const LIMIT: Duration = Duration::from_secs(60);
const GIB: u64 = 1 << 30;
/// Variables Windows programs need; the job's allowlist.
const ENV_ALLOW: [&str; 5] = ["SystemRoot", "windir", "TEMP", "TMP", "PATH"];

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

/// Plenty of memory and an idle CPU, so only the window can hold a start.
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
    admission: Arc<Admission>,
    runs: RunLoop,
    // Held so the loop sees a session that stays connected.
    _connected: watch::Sender<bool>,
}

async fn harness(config: AdmissionConfig) -> Harness {
    // As the executor's main does: a test runner started by a shell may pass
    // its ignore-Ctrl-C flag on, and every graceful stop would escalate.
    devrounds_runner_windows::prepare_executor_process().expect("prepare");
    let home = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
    let store = Store::open(&home.path().join("executor.db"))
        .await
        .expect("store");
    let clock: Arc<dyn Clock> = Arc::new(TokioClock::new());
    let admission = Arc::new(Admission::new(config, Arc::new(Roomy), clock));
    let helper = ConsoleHelper {
        program: std::env::current_exe().expect("test binary path"),
        args: ["--exact", "helper_entry", "--nocapture", HELPER_ARG]
            .map(OsString::from)
            .into(),
    };
    let (connected, connected_rx) = watch::channel(true);
    let runs = RunLoop::new(RunLoopDeps {
        store: store.clone(),
        admission: Arc::clone(&admission),
        runner: WindowsRunner::default().with_console_helper(helper),
        connected: connected_rx,
        runs_dir: home.path().join("runs"),
        machine_env: std::env::vars().collect::<BTreeMap<_, _>>(),
    });
    Harness {
        home,
        store,
        admission,
        runs,
        _connected: connected,
    }
}

/// An `Offer` of `tree-fixture` with `args`, run in `cwd`.
fn offer(run: &str, program: String, args: &[&str], cwd: &Path, timeout_s: u32) -> ServerMessage {
    ServerMessage::Offer(Offer {
        run: run.to_owned(),
        job: JobSpec {
            job_type: "check".to_owned(),
            program,
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            cwd: cwd.display().to_string(),
            env_allow: ENV_ALLOW.map(str::to_owned).into(),
            timeout_s,
        },
        memory_need: DEFAULT_MEMORY_NEED,
        trace_parent: None,
    })
}

fn fixture() -> String {
    devrounds_test_fixtures::tree_fixture_path()
        .to_string_lossy()
        .into_owned()
}

fn run_of(event: &RunEvent) -> Option<&str> {
    match event {
        RunEvent::Admitted { run }
        | RunEvent::Delayed { run, .. }
        | RunEvent::RunStarted { run, .. }
        | RunEvent::StepStarted { run, .. }
        | RunEvent::StepFinished { run, .. }
        | RunEvent::LogSegment { run, .. }
        | RunEvent::RunFinished { run, .. } => Some(run),
        RunEvent::Orphans { .. } | RunEvent::Unknown => None,
    }
}

/// Every event in the outbox, in seq order.
async fn outbox(store: &Store) -> Vec<(u64, RunEvent)> {
    store
        .pending_after(0)
        .await
        .expect("outbox")
        .into_iter()
        .map(|(seq, frame)| match decode_client(&frame).expect("frame") {
            ClientMessage::Event(event) => (seq, event.event),
            other => panic!("the outbox holds only events, got {other:?}"),
        })
        .collect()
}

/// Waits until an event of `run` matches `done`, then returns every event of
/// `run` so far, in seq order.
async fn events_until(
    store: &Store,
    run: &str,
    done: impl Fn(&RunEvent) -> bool,
) -> Vec<(u64, RunEvent)> {
    let mut appended = store.appended();
    loop {
        let events: Vec<_> = outbox(store)
            .await
            .into_iter()
            .filter(|(_, event)| run_of(event) == Some(run))
            .collect();
        if events.iter().any(|(_, event)| done(event)) {
            return events;
        }
        appended.changed().await.expect("store alive");
    }
}

async fn until_finished(store: &Store, run: &str) -> Vec<(u64, RunEvent)> {
    events_until(store, run, |event| {
        matches!(event, RunEvent::RunFinished { .. })
    })
    .await
}

fn kinds(events: &[(u64, RunEvent)]) -> Vec<&'static str> {
    events
        .iter()
        .map(|(_, event)| match event {
            RunEvent::Admitted { .. } => "Admitted",
            RunEvent::Delayed { .. } => "Delayed",
            RunEvent::RunStarted { .. } => "RunStarted",
            RunEvent::StepStarted { .. } => "StepStarted",
            RunEvent::StepFinished { .. } => "StepFinished",
            RunEvent::LogSegment { .. } => "LogSegment",
            RunEvent::RunFinished { .. } => "RunFinished",
            RunEvent::Orphans { .. } => "Orphans",
            RunEvent::Unknown => "Unknown",
        })
        .collect()
}

/// The `RunFinished` among `events`.
fn finished(events: &[(u64, RunEvent)]) -> RunEvent {
    events
        .iter()
        .find(|(_, event)| matches!(event, RunEvent::RunFinished { .. }))
        .map(|(_, event)| event.clone())
        .expect("RunFinished")
}

#[tokio::test]
async fn an_offer_reports_admitted_started_finished_in_seq_order() {
    let program = fixture();
    tokio::time::timeout(LIMIT, async {
        let h = harness(AdmissionConfig::default()).await;
        h.runs.handle(offer(
            "run-1",
            program,
            &["--print", "3"],
            h.home.path(),
            600,
        ));
        let events = until_finished(&h.store, "run-1").await;

        assert_eq!(kinds(&events), ["Admitted", "RunStarted", "RunFinished"]);
        let seqs: Vec<u64> = events.iter().map(|(seq, _)| *seq).collect();
        assert!(seqs.windows(2).all(|pair| pair[0] < pair[1]), "{seqs:?}");
        let RunEvent::RunStarted {
            pid,
            start_time,
            boot_id,
            ..
        } = &events[1].1
        else {
            panic!("RunStarted second");
        };
        assert!(*pid > 0 && *start_time > 0 && !boot_id.is_empty());
        let RunEvent::RunFinished {
            reason,
            exit_code,
            peak,
            visible_windows,
            tail,
            summary,
            ..
        } = finished(&events)
        else {
            unreachable!()
        };
        assert_eq!(reason, FinishReason::Exited);
        assert_eq!(exit_code, Some(0));
        assert_eq!(visible_windows, 0);
        assert!(peak > 0, "the job's exact peak is always read");
        assert_eq!(tail, ["line 1", "line 2", "line 3"]);
        assert_eq!(summary, None);
    })
    .await
    .expect("bounded");
}

#[tokio::test]
async fn stop_while_delayed_never_spawns() {
    let program = fixture();
    tokio::time::timeout(LIMIT, async {
        let config = AdmissionConfig {
            initial_window: 1,
            ..AdmissionConfig::default()
        };
        let h = harness(config).await;
        // Takes the only slot of the window.
        let _held: StartSlot = match h.admission.admit("holder", "check", GIB).next().await {
            AdmissionStep::Admitted(slot) => slot,
            other => panic!("the first start of a busy period is admitted, got {other:?}"),
        };
        h.runs.handle(offer(
            "run-2",
            program,
            &["--print", "1"],
            h.home.path(),
            600,
        ));
        events_until(&h.store, "run-2", |event| {
            matches!(event, RunEvent::Delayed { .. })
        })
        .await;
        h.runs.handle(ServerMessage::Stop(Stop {
            run: "run-2".to_owned(),
            reason: StopReason::Cancel,
        }));
        let events = until_finished(&h.store, "run-2").await;

        assert_eq!(kinds(&events), ["Delayed", "RunFinished"]);
        let RunEvent::Delayed { reason, .. } = &events[0].1 else {
            unreachable!()
        };
        assert_eq!(*reason, devrounds_protocol::DelayReason::Concurrency);
        let RunEvent::RunFinished {
            reason, exit_code, ..
        } = finished(&events)
        else {
            unreachable!()
        };
        assert_eq!(reason, FinishReason::Stopped);
        assert_eq!(exit_code, None);
        assert!(h.admission.snapshot().queued.is_empty(), "left the queue");
        assert!(
            !h.home
                .path()
                .join("runs")
                .join("run-2")
                .join("stdout.raw")
                .exists(),
            "nothing was spawned"
        );
    })
    .await
    .expect("bounded");
}

#[tokio::test]
async fn timeout_stops_the_tree_and_reports_timeout() {
    let program = fixture();
    tokio::time::timeout(LIMIT, async {
        let h = harness(AdmissionConfig::default()).await;
        let started = Instant::now();
        // A live leader and a child that would outlive it by a minute. Both
        // print `bye` on Ctrl-C: a process of a new console group ignores
        // Ctrl-C by default, and would only end at the 10 s escalation.
        h.runs.handle(offer(
            "run-3",
            program,
            &[
                "--children",
                "1",
                "--run-ms",
                "60000",
                "--linger-ms",
                "60000",
                "--ctrl-c",
                "bye",
            ],
            h.home.path(),
            1,
        ));
        let events = until_finished(&h.store, "run-3").await;

        assert_eq!(kinds(&events), ["Admitted", "RunStarted", "RunFinished"]);
        let RunEvent::RunFinished {
            reason,
            tail,
            swept,
            ..
        } = finished(&events)
        else {
            unreachable!()
        };
        assert_eq!(reason, FinishReason::Timeout);
        // The stop reached the whole tree, the lingering child included.
        assert_eq!(
            tail.iter().filter(|line| *line == "bye").count(),
            2,
            "{tail:?}"
        );
        assert_eq!(swept, 0);
        // Ctrl-C ends the tree well before the 10 s grace would escalate.
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
    })
    .await
    .expect("bounded");
}

#[tokio::test]
async fn step_markers_become_step_events() {
    let program = fixture();
    tokio::time::timeout(LIMIT, async {
        let h = harness(AdmissionConfig::default()).await;
        h.runs.handle(offer(
            "run-4",
            program,
            &["--steps", "build,test"],
            h.home.path(),
            600,
        ));
        let events = until_finished(&h.store, "run-4").await;

        assert_eq!(
            kinds(&events),
            [
                "Admitted",
                "RunStarted",
                "StepStarted",
                "StepFinished",
                "StepStarted",
                "StepFinished",
                "RunFinished"
            ]
        );
        let steps: Vec<RunEvent> = events[2..6]
            .iter()
            .map(|(_, event)| event.clone())
            .collect();
        let run = "run-4".to_owned();
        assert_eq!(
            steps,
            [
                RunEvent::StepStarted {
                    run: run.clone(),
                    step: 0,
                    name: "build".to_owned()
                },
                RunEvent::StepFinished {
                    run: run.clone(),
                    step: 0,
                    outcome: StepOutcome::Finished
                },
                RunEvent::StepStarted {
                    run: run.clone(),
                    step: 1,
                    name: "test".to_owned()
                },
                RunEvent::StepFinished {
                    run,
                    step: 1,
                    outcome: StepOutcome::Finished
                },
            ]
        );
    })
    .await
    .expect("bounded");
}

#[tokio::test]
async fn missing_program_reports_spawn_failed_with_a_summary() {
    tokio::time::timeout(LIMIT, async {
        let h = harness(AdmissionConfig::default()).await;
        h.runs.handle(offer(
            "run-5",
            "devrounds-no-such-program".to_owned(),
            &[],
            h.home.path(),
            600,
        ));
        let events = until_finished(&h.store, "run-5").await;

        assert!(!kinds(&events).contains(&"RunStarted"), "{events:?}");
        let RunEvent::RunFinished {
            reason,
            summary,
            exit_code,
            ..
        } = finished(&events)
        else {
            unreachable!()
        };
        assert_eq!(reason, FinishReason::SpawnFailed);
        assert_eq!(exit_code, None);
        let summary = summary.expect("a spawn failure says why");
        assert!(summary.contains("devrounds-no-such-program"), "{summary}");
        // The slot went back: the next start is admitted at once.
        assert_eq!(h.admission.snapshot().in_flight, 0);
    })
    .await
    .expect("bounded");
}

/// A job whose program is a `cmd` wrapper, as `pnpm.cmd` is: it runs hidden
/// and gets every argument as given, spaces and `&` included.
#[tokio::test]
async fn a_cmd_wrapper_gets_exact_arguments_and_stays_hidden() {
    tokio::time::timeout(LIMIT, async {
        let h = harness(AdmissionConfig::default()).await;
        let script = h.home.path().join("echo args.cmd");
        // One bracketed line per argument as `%*` passed it; `%%~a` drops the
        // quotes the runner's escaping added.
        std::fs::write(
            &script,
            "@chcp 65001 >nul\r\n@echo off\r\nfor %%a in (%*) do echo [%%~a]\r\n",
        )
        .expect("write the wrapper");
        h.runs.handle(offer(
            "run-cmd",
            script.display().to_string(),
            &["a b", "c&d", "plain"],
            h.home.path(),
            600,
        ));
        let events = until_finished(&h.store, "run-cmd").await;

        assert_eq!(kinds(&events), ["Admitted", "RunStarted", "RunFinished"]);
        let RunEvent::RunFinished {
            reason,
            exit_code,
            visible_windows,
            tail,
            ..
        } = finished(&events)
        else {
            unreachable!()
        };
        assert_eq!(reason, FinishReason::Exited);
        assert_eq!(exit_code, Some(0));
        assert_eq!(tail, ["[a b]", "[c&d]", "[plain]"]);
        assert_eq!(visible_windows, 0);
    })
    .await
    .expect("bounded");
}
