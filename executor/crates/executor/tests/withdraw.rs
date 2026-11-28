//! `HelloAck.withdrawn` against the run loop, without a socket: the control
//! plane withdrew an offer (it ran out, or a stop came while the machine was
//! offline) and requeued its job, so the executor must not run it.
#![cfg(windows)]

use std::{collections::BTreeMap, ffi::OsString, path::Path, sync::Arc, time::Duration};

use async_trait::async_trait;
use devrounds_core::{
    Error, JobSpec,
    clock::{Clock, TokioClock},
    gate::{MemoryPressure, PressureSample, PressureSource, StartSlot},
};
use devrounds_executor::{
    admission::{Admission, AdmissionConfig, AdmissionStep, DEFAULT_MEMORY_NEED},
    runs::{RunLoop, RunLoopDeps, run_log_options},
};
use devrounds_protocol::{
    ClientMessage, FinishReason, HelloAck, Offer, PROTOCOL, RunEvent, ServerMessage, decode_client,
};
use devrounds_runner_windows::{ConsoleHelper, HELPER_ARG, WindowsRunner};
use devrounds_store::Store;
use tokio::sync::watch;

const LIMIT: Duration = Duration::from_secs(60);
const GIB: u64 = 1 << 30;
const ENV_ALLOW: [&str; 5] = ["SystemRoot", "windir", "TEMP", "TMP", "PATH"];

/// Started with [`HELPER_ARG`], the test binary is the runner's console
/// helper (see `run_loop.rs`).
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
    _connected: watch::Sender<bool>,
}

/// A run loop whose admission window takes one start at a time.
async fn harness() -> Harness {
    devrounds_runner_windows::prepare_executor_process().expect("prepare");
    let home = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
    let store = Store::open(&home.path().join("executor.db"))
        .await
        .expect("store");
    let clock: Arc<dyn Clock> = Arc::new(TokioClock::new());
    let config = AdmissionConfig {
        initial_window: 1,
        ..AdmissionConfig::default()
    };
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
        log_options: run_log_options(),
        telemetry: None,
    });
    Harness {
        home,
        store,
        admission,
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
        },
        memory_need: DEFAULT_MEMORY_NEED,
        trace_parent: None,
    })
}

fn hello_ack(withdrawn: &[&str]) -> ServerMessage {
    ServerMessage::HelloAck(HelloAck {
        protocol: PROTOCOL,
        features: vec!["seq".to_owned(), "withdraw".to_owned()],
        machine_id: "m-1".to_owned(),
        last_seq: 0,
        withdrawn: withdrawn.iter().map(|run| (*run).to_owned()).collect(),
    })
}

/// The kinds of the outbox events of `run`, in seq order.
async fn kinds_of(store: &Store, run: &str) -> Vec<&'static str> {
    let mut kinds = Vec::new();
    for (_, frame) in store.pending_after(0).await.expect("outbox") {
        let ClientMessage::Event(event) = decode_client(&frame).expect("frame") else {
            panic!("the outbox holds only events");
        };
        let (of, kind) = match &event.event {
            RunEvent::Admitted { run } => (run, "Admitted"),
            RunEvent::Delayed { run, .. } => (run, "Delayed"),
            RunEvent::RunStarted { run, .. } => (run, "RunStarted"),
            RunEvent::StepStarted { run, .. } => (run, "StepStarted"),
            RunEvent::StepFinished { run, .. } => (run, "StepFinished"),
            RunEvent::LogSegment { run, .. } => (run, "LogSegment"),
            RunEvent::RunFinished { run, .. } => (run, "RunFinished"),
            RunEvent::Orphans { .. } | RunEvent::Unknown => continue,
        };
        if of == run {
            kinds.push(kind);
        }
    }
    kinds
}

/// Waits until an event of `run` of kind `kind` is in the outbox.
async fn until_kind(store: &Store, run: &str, kind: &str) {
    let mut appended = store.appended();
    while !kinds_of(store, run).await.contains(&kind) {
        appended.changed().await.expect("store alive");
    }
}

async fn in_flight(store: &Store, run: &str) -> bool {
    store
        .runs_in_flight()
        .await
        .expect("runs in flight")
        .iter()
        .any(|stored| stored.run_id == run)
}

/// Holds the only slot of the window.
async fn hold_the_window(admission: &Admission) -> StartSlot {
    match admission.admit("holder", "check", GIB).next().await {
        AdmissionStep::Admitted(slot) => slot,
        other => panic!("the first start of a busy period is admitted, got {other:?}"),
    }
}

#[tokio::test]
async fn withdrawn_run_waiting_in_the_gate_never_spawns_and_emits_nothing() {
    tokio::time::timeout(LIMIT, async {
        let h = harness().await;
        let held = hold_the_window(&h.admission).await;
        h.runs
            .handle(offer("run-w", &["--print", "1"], h.home.path()));
        until_kind(&h.store, "run-w", "Delayed").await;
        assert!(h.home.path().join("runs").join("run-w").exists());

        h.runs.handle(hello_ack(&["run-w"]));
        while in_flight(&h.store, "run-w").await {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // The slot it waited for frees: a run offered after it takes it, and
        // the withdrawn one is gone from the gate.
        drop(held);
        h.runs
            .handle(offer("run-next", &["--print", "1"], h.home.path()));
        until_kind(&h.store, "run-next", "RunFinished").await;

        assert_eq!(
            kinds_of(&h.store, "run-w").await,
            ["Delayed"],
            "no event after the withdrawal"
        );
        assert!(h.admission.snapshot().queued.is_empty(), "left the gate");
        assert!(
            !h.home.path().join("runs").join("run-w").exists(),
            "run directory removed"
        );
        assert!(!in_flight(&h.store, "run-w").await, "the store forgot it");
    })
    .await
    .expect("bounded");
}

#[tokio::test]
async fn withdrawn_unknown_run_is_ignored() {
    tokio::time::timeout(LIMIT, async {
        let h = harness().await;
        let held = hold_the_window(&h.admission).await;
        h.runs
            .handle(offer("run-kept", &["--print", "1"], h.home.path()));
        until_kind(&h.store, "run-kept", "Delayed").await;

        h.runs.handle(hello_ack(&["run-elsewhere"]));
        drop(held);
        until_kind(&h.store, "run-kept", "RunFinished").await;

        assert_eq!(
            kinds_of(&h.store, "run-kept").await,
            [
                "Delayed",
                "Admitted",
                "RunStarted",
                "LogSegment",
                "RunFinished"
            ]
        );
    })
    .await
    .expect("bounded");
}

#[tokio::test]
/// Its process may already have done work, so it ends as for a Stop cancel:
/// the tree is stopped and RunFinished reports it, which the control plane
/// refuses for a run it already ended.
async fn spawned_withdrawn_run_is_stopped() {
    tokio::time::timeout(LIMIT, async {
        let h = harness().await;
        h.runs.handle(offer(
            "run-s",
            &["--run-ms", "60000", "--ctrl-c", "bye"],
            h.home.path(),
        ));
        until_kind(&h.store, "run-s", "RunStarted").await;

        h.runs.handle(hello_ack(&["run-s"]));
        until_kind(&h.store, "run-s", "RunFinished").await;

        let finished = h
            .store
            .pending_after(0)
            .await
            .expect("outbox")
            .into_iter()
            .find_map(|(_, frame)| match decode_client(&frame).expect("frame") {
                ClientMessage::Event(event) => match event.event {
                    RunEvent::RunFinished { run, reason, .. } if run == "run-s" => Some(reason),
                    _ => None,
                },
                _ => None,
            });
        assert_eq!(finished, Some(FinishReason::Stopped));
    })
    .await
    .expect("bounded");
}
