//! Orphans: runs a previous executor process left in the store. Executor A
//! runs in a tokio runtime of its own that the test drops without stopping
//! anything, as a crash would; executor B then opens the same home. Runs are
//! real `tree-fixture` processes, as in `run_loop.rs`.
#![cfg(windows)]

use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::Read,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use base64::Engine;
use devrounds_core::{
    Error, JobSpec, ProcessIdentity,
    clock::{Clock, TokioClock},
    gate::{MemoryPressure, PressureSample, PressureSource},
};
use devrounds_executor::{
    admission::{Admission, AdmissionConfig, DEFAULT_MEMORY_NEED},
    orphans::{scan_orphans, sweep_run_dirs},
    runs::{RunLoop, RunLoopDeps, run_log_options},
};
use devrounds_logs::LogLine;
use devrounds_protocol::{
    ClientMessage, FinishReason, Offer, Orphan, RunEvent, ServerMessage, Stop, StopReason,
    decode_client,
};
use devrounds_runner_windows::{ConsoleHelper, HELPER_ARG, WindowsRunner};
use devrounds_store::{Store, StoredRun};
use devrounds_sys_windows::proc;
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

/// One executor process's run loop over the store in `home`.
struct Executor {
    store: Store,
    runs: RunLoop,
    _connected: watch::Sender<bool>,
}

async fn executor(home: &Path) -> Executor {
    devrounds_runner_windows::prepare_executor_process().expect("prepare");
    let store = Store::open(&home.join("executor.db")).await.expect("store");
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
        runs_dir: home.join("runs"),
        machine_env: std::env::vars().collect::<BTreeMap<_, _>>(),
        log_options: run_log_options(),
        telemetry: None,
    });
    Executor {
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
        },
        memory_need: DEFAULT_MEMORY_NEED,
        trace_parent: None,
    })
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

/// The stored run `run` once `ready` holds for it.
async fn stored_when(store: &Store, run: &str, ready: impl Fn(&StoredRun) -> bool) -> StoredRun {
    loop {
        let found = store
            .runs_in_flight()
            .await
            .expect("runs")
            .into_iter()
            .find(|stored| stored.run_id == run);
        if let Some(stored) = found.filter(|stored| ready(stored)) {
            return stored;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Executor A: offers `run` with `args`, waits until `ready` holds for its
/// stored record, then drops the runtime without stopping anything. Returns
/// what A recorded.
fn crash_after(
    home: &Path,
    run: &str,
    args: &[&str],
    ready: impl Fn(&StoredRun) -> bool,
) -> StoredRun {
    let runtime = tokio::runtime::Runtime::new().expect("runtime A");
    let stored = runtime.block_on(async {
        tokio::time::timeout(LIMIT, async {
            let a = executor(home).await;
            a.runs.handle(offer(run, args, home));
            stored_when(&a.store, run, ready).await
        })
        .await
        .expect("bounded")
    });
    // Blocking reads finish; the run's processes do not belong to the runtime.
    runtime.shutdown_timeout(Duration::from_secs(5));
    stored
}

/// The leader and every recorded member.
fn identities(stored: &StoredRun) -> Vec<ProcessIdentity> {
    let identity = stored.identity.as_ref().expect("leader recorded");
    let mut all = vec![ProcessIdentity {
        pid: identity.pid,
        sid: 0,
        start_time: identity.start_time,
    }];
    all.extend(stored.members.iter().copied());
    all
}

fn alive(identities: &[ProcessIdentity]) -> Vec<u32> {
    identities
        .iter()
        .filter(|identity| proc::matches(identity.pid, identity.start_time).unwrap_or(false))
        .map(|identity| identity.pid)
        .collect()
}

/// Polls until none of `identities` runs any more, or `within` passed;
/// returns the ones still alive.
async fn gone_within(identities: &[ProcessIdentity], within: Duration) -> Vec<u32> {
    let deadline = Instant::now() + within;
    loop {
        let left = alive(identities);
        if left.is_empty() || Instant::now() >= deadline {
            return left;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Every line text of the run's `LogSegment` events, in order.
fn shipped_lines(events: &[(u64, RunEvent)]) -> Vec<String> {
    let mut texts = Vec::new();
    for (_, event) in events {
        let RunEvent::LogSegment { zstd_base64, .. } = event else {
            continue;
        };
        let compressed = base64::engine::general_purpose::STANDARD
            .decode(zstd_base64)
            .expect("base64");
        let mut text = String::new();
        zstd::stream::read::Decoder::new(compressed.as_slice())
            .expect("zstd")
            .read_to_string(&mut text)
            .expect("zstd text");
        for line in text.lines() {
            let line: LogLine = serde_json::from_str(line).expect("a LogLine");
            texts.push(line.text);
        }
    }
    texts
}

/// Acks every event in the outbox, as the control plane would.
async fn ack_all(store: &Store) {
    if let Some((seq, _)) = outbox(store).await.last() {
        store.ack_through(*seq).await.expect("ack");
    }
}

async fn forgotten(store: &Store, run: &str) {
    while store
        .runs_in_flight()
        .await
        .expect("runs")
        .iter()
        .any(|stored| stored.run_id == run)
    {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// A leader and child with recorded members that outlive executor A: B
/// reports them alive and does nothing else for the run, whose processes
/// keep running untouched.
#[test]
fn restart_reports_a_surviving_run_as_orphaned_and_never_readopts() {
    let home = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
    let stored = crash_after(
        home.path(),
        "orphan-1",
        &[
            "--children",
            "1",
            "--run-ms",
            "30000",
            "--linger-ms",
            "30000",
            "--ctrl-c",
            "bye",
            "--ready",
        ],
        |stored| stored.identity.is_some() && stored.members.len() >= 2,
    );
    let tree = identities(&stored);

    let runtime = tokio::runtime::Runtime::new().expect("runtime B");
    runtime.block_on(async {
        tokio::time::timeout(LIMIT, async {
            let b = executor(home.path()).await;
            let before = outbox(&b.store).await.last().map_or(0, |(seq, _)| *seq);
            let orphans = scan_orphans(&b.store).await.expect("scan");
            assert_eq!(
                orphans
                    .iter()
                    .map(|(run, alive)| (run.run_id.as_str(), *alive))
                    .collect::<Vec<_>>(),
                [("orphan-1", true)]
            );
            b.runs.report_orphans(orphans).await.expect("report");
            // A repeated offer of the orphan is ignored too.
            b.runs.handle(offer("orphan-1", &[], home.path()));
            tokio::time::sleep(Duration::from_secs(2)).await;

            let after: Vec<_> = outbox(&b.store)
                .await
                .into_iter()
                .filter(|(seq, _)| *seq > before)
                .map(|(_, event)| event)
                .collect();
            assert_eq!(
                after,
                [RunEvent::Orphans {
                    runs: vec![Orphan {
                        run: "orphan-1".to_owned(),
                        alive: true,
                    }],
                }]
            );
            assert_eq!(b.runs.running(), 0);
            assert_eq!(alive(&tree).len(), tree.len(), "the tree was touched");

            // Cleanup: the kill policy's path, tested on its own below.
            b.runs.handle(ServerMessage::Stop(Stop {
                run: "orphan-1".to_owned(),
                reason: StopReason::OrphanPolicy,
            }));
            assert_eq!(gone_within(&tree, Duration::from_secs(12)).await, [0u32; 0]);
        })
        .await
        .expect("bounded");
    });
}

/// `Stop { orphan_policy }` ends the whole recorded tree from its identities,
/// ships the output left and forgets the run once that is acked.
#[test]
fn kill_policy_ends_the_orphan_tree() {
    let home = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
    let stored = crash_after(
        home.path(),
        "orphan-2",
        &[
            "--children",
            "1",
            "--print",
            "2",
            "--run-ms",
            "30000",
            "--linger-ms",
            "30000",
            "--ctrl-c",
            "bye",
            "--ready",
        ],
        |stored| stored.identity.is_some() && stored.members.len() >= 2,
    );
    let tree = identities(&stored);

    let runtime = tokio::runtime::Runtime::new().expect("runtime B");
    runtime.block_on(async {
        tokio::time::timeout(LIMIT, async {
            let b = executor(home.path()).await;
            let orphans = scan_orphans(&b.store).await.expect("scan");
            b.runs.report_orphans(orphans).await.expect("report");
            b.runs.handle(ServerMessage::Stop(Stop {
                run: "orphan-2".to_owned(),
                reason: StopReason::OrphanPolicy,
            }));
            assert_eq!(gone_within(&tree, Duration::from_secs(12)).await, [0u32; 0]);

            // The output written while A ran, and after, ships once.
            let mut appended = b.store.appended();
            let lines = loop {
                let lines = shipped_lines(&outbox(&b.store).await);
                if lines.iter().any(|line| line == "bye") {
                    break lines;
                }
                appended.changed().await.expect("store alive");
            };
            for expected in ["line 1", "line 2"] {
                assert_eq!(
                    lines.iter().filter(|line| *line == expected).count(),
                    1,
                    "{lines:?}"
                );
            }
            ack_all(&b.store).await;
            forgotten(&b.store, "orphan-2").await;
        })
        .await
        .expect("bounded");
    });
}

/// A leader that exited while its child lives on: the run is alive, since a
/// recorded member still runs, and the kill policy ends that member.
#[test]
fn a_run_whose_leader_exited_but_a_member_lives_is_alive() {
    let home = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
    let stored = crash_after(
        home.path(),
        "orphan-5",
        &[
            "--children",
            "1",
            "--run-ms",
            "1500",
            "--linger-ms",
            "30000",
        ],
        |stored| stored.identity.is_some() && stored.members.len() >= 2,
    );
    let tree = identities(&stored);
    let leader = tree[..1].to_vec();

    let runtime = tokio::runtime::Runtime::new().expect("runtime B");
    runtime.block_on(async {
        tokio::time::timeout(LIMIT, async {
            assert_eq!(
                gone_within(&leader, Duration::from_secs(10)).await,
                [0u32; 0]
            );
            assert!(
                !alive(&tree).is_empty(),
                "the child must outlive the leader"
            );
            let b = executor(home.path()).await;
            let orphans = scan_orphans(&b.store).await.expect("scan");
            assert_eq!(
                orphans
                    .iter()
                    .map(|(run, alive)| (run.run_id.as_str(), *alive))
                    .collect::<Vec<_>>(),
                [("orphan-5", true)]
            );
            b.runs.report_orphans(orphans).await.expect("report");
            b.runs.handle(ServerMessage::Stop(Stop {
                run: "orphan-5".to_owned(),
                reason: StopReason::OrphanPolicy,
            }));
            assert_eq!(gone_within(&tree, Duration::from_secs(12)).await, [0u32; 0]);
        })
        .await
        .expect("bounded");
    });
}

/// A run whose leader exited while no executor ran: reported dead, its
/// output shipped once, then forgotten after the ack.
#[test]
fn a_run_that_ended_while_down_is_reported_dead() {
    let home = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
    let stored = crash_after(
        home.path(),
        "orphan-3",
        &["--print", "3", "--run-ms", "1500"],
        |stored| stored.identity.is_some(),
    );
    let tree = identities(&stored);

    let runtime = tokio::runtime::Runtime::new().expect("runtime B");
    runtime.block_on(async {
        tokio::time::timeout(LIMIT, async {
            assert_eq!(gone_within(&tree, Duration::from_secs(10)).await, [0u32; 0]);
            let b = executor(home.path()).await;
            let orphans = scan_orphans(&b.store).await.expect("scan");
            assert_eq!(
                orphans
                    .iter()
                    .map(|(run, alive)| (run.run_id.as_str(), *alive))
                    .collect::<Vec<_>>(),
                [("orphan-3", false)]
            );
            b.runs.report_orphans(orphans).await.expect("report");

            let mut appended = b.store.appended();
            let events = loop {
                let events = outbox(&b.store).await;
                if shipped_lines(&events).iter().any(|line| line == "line 3") {
                    break events;
                }
                appended.changed().await.expect("store alive");
            };
            assert!(events.iter().any(|(_, event)| *event
                == RunEvent::Orphans {
                    runs: vec![Orphan {
                        run: "orphan-3".to_owned(),
                        alive: false,
                    }],
                }));
            assert_eq!(
                shipped_lines(&events),
                ["line 1", "line 2", "line 3"],
                "each line once"
            );
            // A's own events stay before B's report.
            let reported = events
                .iter()
                .find(|(_, event)| matches!(event, RunEvent::Orphans { .. }))
                .map(|(seq, _)| *seq)
                .expect("Orphans");
            assert!(
                !events.iter().any(|(seq, event)| *seq > reported
                    && matches!(
                        event,
                        RunEvent::Admitted { .. }
                            | RunEvent::RunStarted { .. }
                            | RunEvent::RunFinished { .. }
                    )),
                "B never adopts the run: {events:?}"
            );
            ack_all(&b.store).await;
            forgotten(&b.store, "orphan-3").await;
        })
        .await
        .expect("bounded");
    });
}

/// An Offer of a run this executor already knows (still in its store, or
/// whose events still wait in the outbox) never starts it again: the
/// control plane re-sends Offers of runs it still sees offered after every
/// Hello.
#[tokio::test]
async fn an_offer_for_a_run_already_known_is_ignored() {
    tokio::time::timeout(LIMIT, async {
        let home = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
        let x = executor(home.path()).await;
        let ServerMessage::Offer(stored_offer) = offer("known-1", &[], home.path()) else {
            unreachable!()
        };
        x.store
            .put_run(StoredRun {
                run_id: "known-1".to_owned(),
                job: stored_offer.job,
                state: "offered".to_owned(),
                identity: None,
                run_dir: home.path().join("runs").join("known-1"),
                members: Vec::new(),
            })
            .await
            .expect("put");
        // Ended and forgotten, its RunFinished not acked yet.
        x.store
            .append_event(RunEvent::RunFinished {
                run: "known-2".to_owned(),
                reason: FinishReason::Exited,
                exit_code: Some(0),
                peak: 0,
                p95: 0,
                p50: 0,
                cpu_seconds: 0.0,
                swept: 0,
                visible_windows: 0,
                tail: Vec::new(),
                summary: None,
            })
            .await
            .expect("append");
        let before = outbox(&x.store).await.len();

        x.runs.handle(offer("known-1", &[], home.path()));
        x.runs.handle(offer("known-2", &[], home.path()));
        tokio::time::sleep(Duration::from_secs(1)).await;

        assert_eq!(outbox(&x.store).await.len(), before);
        assert!(!home.path().join("runs").join("known-2").exists());
    })
    .await
    .expect("bounded");
}

/// The orphan pass removes `runs/<id>/` left behind once the run is
/// forgotten, its events acked and the directory past the retention window;
/// a run still in the store or the outbox, or a recent directory, stays.
#[tokio::test]
async fn leftover_run_dirs_are_swept_after_the_retention_window() {
    tokio::time::timeout(LIMIT, async {
        let home = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
        let x = executor(home.path()).await;
        let runs = home.path().join("runs");
        let leftover = |name: &str| {
            let dir = runs.join(name);
            std::fs::create_dir_all(dir.join("segments")).expect("dirs");
            std::fs::write(dir.join("stdout.raw"), "out\n").expect("raw");
            std::fs::write(dir.join("segments").join("00000000000000000001.zst"), "z")
                .expect("segment");
            dir
        };
        let done = leftover("done-1");
        let in_store = leftover("in-store-1");
        let in_outbox = leftover("in-outbox-1");
        let ServerMessage::Offer(stored_offer) = offer("in-store-1", &[], home.path()) else {
            unreachable!()
        };
        x.store
            .put_run(StoredRun {
                run_id: "in-store-1".to_owned(),
                job: stored_offer.job,
                state: "offered".to_owned(),
                identity: None,
                run_dir: in_store.clone(),
                members: Vec::new(),
            })
            .await
            .expect("put");
        x.store
            .append_event(RunEvent::Admitted {
                run: "in-outbox-1".to_owned(),
            })
            .await
            .expect("append");
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let recent = leftover("recent-1");

        let swept = sweep_run_dirs(&x.store, &runs, Duration::from_secs(1))
            .await
            .expect("sweep");

        assert_eq!(swept, std::slice::from_ref(&done));
        assert!(!done.exists());
        for kept in [in_store, in_outbox, recent] {
            assert!(kept.join("stdout.raw").exists(), "{}", kept.display());
        }
    })
    .await
    .expect("bounded");
}

/// The seq of the latest `Orphans` event in the outbox.
async fn reported_seq(store: &Store) -> u64 {
    outbox(store)
        .await
        .iter()
        .rev()
        .find(|(_, event)| matches!(event, RunEvent::Orphans { .. }))
        .map(|(seq, _)| *seq)
        .expect("Orphans reported")
}

/// Ends what is left of `tree` directly, so a test leaves no process behind.
fn cleanup(tree: &[ProcessIdentity]) {
    let runner = WindowsRunner::default();
    devrounds_runner_windows::stop_orphan(
        None,
        runner.runtimes(),
        tree[0],
        &tree[1..],
        Duration::from_millis(100),
    );
}

const LINGERING_TREE: [&str; 11] = [
    "--children",
    "1",
    "--print",
    "2",
    "--run-ms",
    "30000",
    "--linger-ms",
    "30000",
    "--ctrl-c",
    "bye",
    "--ready",
];

/// The Orphans event was applied and acked, but the session dropped before
/// the Stop went out: the next HelloAck acks the report through `last_seq`
/// with no `Ack` frame. That is no let_finish answer; the Stop the control
/// plane sends again after that HelloAck still ends the tree.
#[test]
fn a_report_acked_through_hello_still_takes_the_stop_sent_after_it() {
    let home = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
    let stored = crash_after(home.path(), "orphan-4", &LINGERING_TREE, |stored| {
        stored.identity.is_some() && stored.members.len() >= 2
    });
    let tree = identities(&stored);

    let runtime = tokio::runtime::Runtime::new().expect("runtime B");
    runtime.block_on(async {
        tokio::time::timeout(LIMIT, async {
            let b = executor(home.path()).await;
            let orphans = scan_orphans(&b.store).await.expect("scan");
            b.runs.report_orphans(orphans).await.expect("report");
            let reported = reported_seq(&b.store).await;
            // HelloAck: the connection acks through last_seq and hands HelloAck on.
            b.store.ack_through(reported).await.expect("ack");
            tokio::time::sleep(Duration::from_secs(1)).await;
            assert_eq!(alive(&tree).len(), tree.len(), "the tree was touched");

            b.runs.handle(ServerMessage::Stop(Stop {
                run: "orphan-4".to_owned(),
                reason: StopReason::OrphanPolicy,
            }));
            let left = gone_within(&tree, Duration::from_secs(12)).await;
            if !left.is_empty() {
                cleanup(&tree);
            }
            assert_eq!(left, [0u32; 0], "the Stop was not honoured");
        })
        .await
        .expect("bounded");
    });
}

/// let_finish: the live `Ack` of the report comes with no Stop before it.
/// The tree keeps running, the output it left ships, and the run is
/// forgotten once that is acked.
#[test]
fn an_ack_with_no_stop_lets_the_orphan_finish_and_forgets_it() {
    let home = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
    let stored = crash_after(home.path(), "orphan-5", &LINGERING_TREE, |stored| {
        stored.identity.is_some() && stored.members.len() >= 2
    });
    let tree = identities(&stored);

    let runtime = tokio::runtime::Runtime::new().expect("runtime B");
    runtime.block_on(async {
        tokio::time::timeout(LIMIT, async {
            let b = executor(home.path()).await;
            let orphans = scan_orphans(&b.store).await.expect("scan");
            b.runs.report_orphans(orphans).await.expect("report");
            let reported = reported_seq(&b.store).await;
            b.store.ack_through(reported).await.expect("ack");
            b.runs.handle(ServerMessage::Ack(devrounds_protocol::Ack {
                seq: reported,
            }));

            let mut appended = b.store.appended();
            let lines = loop {
                let lines = shipped_lines(&outbox(&b.store).await);
                if lines.iter().any(|line| line == "line 2") {
                    break lines;
                }
                appended.changed().await.expect("store alive");
            };
            // The `ready` lines of the leader and its child ship with them.
            let printed: Vec<&String> = lines
                .iter()
                .filter(|line| line.starts_with("line "))
                .collect();
            assert_eq!(printed, ["line 1", "line 2"]);
            ack_all(&b.store).await;
            forgotten(&b.store, "orphan-5").await;
            let running = alive(&tree).len();
            cleanup(&tree);
            assert_eq!(running, tree.len(), "let_finish touched the tree");
        })
        .await
        .expect("bounded");
    });
}

/// Executor B recovers a dead orphan's output and crashes before the ack;
/// executor C recovers it again. The lines B already put into the log are
/// not read again under new seqs: by `first_seq`, as the control plane keeps
/// segments, each line arrives once.
#[test]
fn a_second_restart_ships_no_line_twice() {
    let home = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
    let stored = crash_after(
        home.path(),
        "orphan-6",
        &["--print", "3", "--run-ms", "1500"],
        |stored| stored.identity.is_some(),
    );
    let tree = identities(&stored);
    let shipped_by = |runtime: &tokio::runtime::Runtime| {
        runtime.block_on(async {
            tokio::time::timeout(LIMIT, async {
                assert_eq!(gone_within(&tree, Duration::from_secs(10)).await, [0u32; 0]);
                let x = executor(home.path()).await;
                let orphans = scan_orphans(&x.store).await.expect("scan");
                x.runs.report_orphans(orphans).await.expect("report");
                let reported = reported_seq(&x.store).await;
                // Wait until this executor's shipping is done: a segment after its report.
                let mut appended = x.store.appended();
                while !outbox(&x.store).await.iter().any(|(seq, event)| {
                    *seq > reported && matches!(event, RunEvent::LogSegment { .. })
                }) {
                    appended.changed().await.expect("store alive");
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
            })
            .await
            .expect("bounded");
        });
    };
    let b = tokio::runtime::Runtime::new().expect("runtime B");
    shipped_by(&b);
    b.shutdown_timeout(Duration::from_secs(5));
    let c = tokio::runtime::Runtime::new().expect("runtime C");
    shipped_by(&c);

    let events = c.block_on(async {
        let store = Store::open(&home.path().join("executor.db"))
            .await
            .expect("store");
        outbox(&store).await
    });
    let mut kept: BTreeMap<u64, (u64, RunEvent)> = BTreeMap::new();
    for (seq, event) in events {
        if let RunEvent::LogSegment { first_seq, .. } = &event {
            kept.entry(*first_seq).or_insert((seq, event));
        }
    }
    let unique: Vec<(u64, RunEvent)> = kept.into_values().collect();
    assert_eq!(shipped_lines(&unique), ["line 1", "line 2", "line 3"]);
}
