//! The store on a real SQLite file under Cargo's target directory.

use std::path::PathBuf;

use devrounds_core::{JobSpec, ProcessIdentity};
use devrounds_protocol::{ClientMessage, RunEvent, decode_client};
use devrounds_store::{RunIdentity, Store, StoredRun};

fn dir() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir")
}

fn admitted(run: &str) -> RunEvent {
    RunEvent::Admitted {
        run: run.to_owned(),
    }
}

fn seqs(pending: &[(u64, String)]) -> Vec<u64> {
    pending.iter().map(|(seq, _)| *seq).collect()
}

#[tokio::test]
async fn events_survive_reopening_the_store() {
    let dir = dir();
    let path = dir.path().join("executor.db");
    let store = Store::open(&path).await.expect("open");
    for run in ["r1", "r2", "r3"] {
        store.append_event(admitted(run)).await.expect("append");
    }
    drop(store);

    let store = Store::open(&path).await.expect("reopen");
    let pending = store.pending_after(0).await.expect("pending");
    assert_eq!(seqs(&pending), [1, 2, 3]);
    // Each row is the wire frame, its seq inside.
    let ClientMessage::Event(event) = decode_client(&pending[2].1).expect("decode") else {
        panic!("not an Event frame: {}", pending[2].1);
    };
    assert_eq!(event.seq, 3);
    assert_eq!(event.event, admitted("r3"));
    assert!(event.at.ends_with('Z'), "{}", event.at);
}

#[tokio::test]
async fn ack_drops_events_through_seq() {
    let dir = dir();
    let store = Store::open(&dir.path().join("executor.db"))
        .await
        .expect("open");
    for run in ["r1", "r2", "r3", "r4"] {
        store.append_event(admitted(run)).await.expect("append");
    }
    store.ack_through(2).await.expect("ack");
    assert_eq!(
        seqs(&store.pending_after(0).await.expect("pending")),
        [3, 4]
    );
    assert_eq!(seqs(&store.pending_after(3).await.expect("pending")), [4]);

    // Seqs keep growing after acked rows are gone.
    store.ack_through(4).await.expect("ack");
    assert_eq!(store.append_event(admitted("r5")).await.expect("append"), 5);
}

#[tokio::test]
async fn pending_pages_stay_within_their_byte_budget_and_cover_every_frame_in_order() {
    let dir = dir();
    let store = Store::open(&dir.path().join("executor.db"))
        .await
        .expect("open");
    // Twelve frames of about 300 KiB, the size class of a shipped log segment.
    for first in 0..12u64 {
        let event = RunEvent::LogSegment {
            run: "r1".to_owned(),
            first_seq: first * 10 + 1,
            last_seq: first * 10 + 10,
            records: 10,
            zstd_base64: "A".repeat(300 * 1024),
        };
        store.append_event(event).await.expect("append");
    }
    const BUDGET: usize = 1024 * 1024;
    let mut after = 0;
    let mut seen = Vec::new();
    let mut pages = 0;
    loop {
        let page = store.pending_page(after, BUDGET).await.expect("page");
        let Some((last, _)) = page.last() else { break };
        after = *last;
        pages += 1;
        let bytes: usize = page.iter().map(|(_, frame)| frame.len()).sum();
        assert!(bytes <= BUDGET, "page {pages} holds {bytes} bytes");
        seen.extend(seqs(&page));
    }
    assert_eq!(seen, (1..=12).collect::<Vec<u64>>());
    assert!(pages >= 4, "{pages} pages");

    // A frame larger than the budget still comes, alone, so paging moves on.
    let alone = store.pending_page(0, 1).await.expect("page");
    assert_eq!(seqs(&alone), [1]);
}

#[tokio::test]
async fn a_store_behind_the_control_plane_moves_its_events_after_last_seq() {
    let dir = dir();
    let store = Store::open(&dir.path().join("executor.db"))
        .await
        .expect("open");
    for run in ["r1", "r2"] {
        store.append_event(admitted(run)).await.expect("append");
    }
    assert!(store.raise_floor(7).await.expect("raise"));
    let pending = store.pending_after(0).await.expect("pending");
    assert_eq!(seqs(&pending), [8, 9]);
    let ClientMessage::Event(event) = decode_client(&pending[0].1).expect("decode") else {
        panic!("not an Event frame: {}", pending[0].1);
    };
    assert_eq!((event.seq, event.event), (8, admitted("r1")));
    assert_eq!(
        store.append_event(admitted("r3")).await.expect("append"),
        10
    );
    // Already past it: nothing moves.
    assert!(!store.raise_floor(9).await.expect("raise"));
    assert_eq!(
        seqs(&store.pending_after(0).await.expect("pending")),
        [8, 9, 10]
    );
}

#[tokio::test]
async fn runs_in_flight_keep_their_identity_and_members_until_forgotten() {
    let dir = dir();
    let path = dir.path().join("executor.db");
    let store = Store::open(&path).await.expect("open");
    let run = StoredRun {
        run_id: "r1".to_owned(),
        job: job("PATH"),
        state: "admitted".to_owned(),
        identity: None,
        run_dir: PathBuf::from(r"C:\runs\r1"),
        members: Vec::new(),
    };
    store.put_run(run.clone()).await.expect("put");
    // A FILETIME passes i64::MAX / 2; it must come back exact.
    let identity = RunIdentity {
        pid: 4242,
        start_time: 133_000_000_000_000_000,
        boot_id: "boot-1".to_owned(),
    };
    store
        .set_identity("r1", identity.clone())
        .await
        .expect("identity");
    let members = vec![ProcessIdentity {
        pid: 4243,
        sid: 0,
        start_time: 133_000_000_000_000_001,
    }];
    store
        .record_members("r1", members.clone())
        .await
        .expect("members");
    drop(store);

    let store = Store::open(&path).await.expect("reopen");
    assert_eq!(
        store.runs_in_flight().await.expect("runs"),
        [StoredRun {
            identity: Some(identity),
            members,
            ..run
        }]
    );
    store.forget_run("r1").await.expect("forget");
    assert_eq!(store.runs_in_flight().await.expect("runs"), []);
}

fn job(variable: &str) -> JobSpec {
    JobSpec {
        job_type: "check".to_owned(),
        program: "pnpm".to_owned(),
        args: vec!["check".to_owned()],
        cwd: r"C:\work".to_owned(),
        env_allow: vec![variable.to_owned()],
        timeout_s: 600,
    }
}

#[tokio::test]
async fn env_values_never_reach_the_store_file() {
    // An allowlisted variable this process already has: edition 2024 makes
    // set_var unsafe, and the workspace denies unsafe code.
    const VARIABLE: &str = "PATH";
    let value = std::env::var(VARIABLE).expect("PATH is set");
    assert!(value.len() > 8, "PATH is too short to be a telling probe");
    let dir = dir();
    let path = dir.path().join("executor.db");
    let store = Store::open(&path).await.expect("open");
    store
        .put_run(StoredRun {
            run_id: "r1".to_owned(),
            job: job(VARIABLE),
            state: "admitted".to_owned(),
            identity: None,
            run_dir: dir.path().join("r1"),
            members: Vec::new(),
        })
        .await
        .expect("put");
    store.append_event(admitted("r1")).await.expect("append");
    drop(store);
    // Reopening waits for the first connection's thread to finish its work.
    let store = Store::open(&path).await.expect("reopen");
    assert_eq!(store.runs_in_flight().await.expect("runs").len(), 1);
    drop(store);

    for entry in std::fs::read_dir(dir.path()).expect("dir") {
        let file = entry.expect("entry").path();
        if file.is_dir() {
            continue;
        }
        let bytes = std::fs::read(&file).expect("read");
        assert!(
            !bytes
                .windows(value.len())
                .any(|window| window == value.as_bytes()),
            "{} holds an env value",
            file.display()
        );
        if file == path {
            assert!(
                bytes
                    .windows(VARIABLE.len())
                    .any(|window| window == VARIABLE.as_bytes()),
                "the allowlisted name is stored"
            );
        }
    }
}

#[tokio::test]
async fn a_file_that_is_not_a_database_is_dr550() {
    let dir = dir();
    let path = dir.path().join("executor.db");
    std::fs::write(&path, vec![b'x'; 4096]).expect("write");
    let error = Store::open(&path).await.err().expect("refused");
    assert_eq!(error.code, "DR550");
    assert_eq!(error.data["path"], path.display().to_string());
}
