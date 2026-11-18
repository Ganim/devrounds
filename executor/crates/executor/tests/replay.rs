//! The outbox across a dropped session, against a fake control plane on
//! `127.0.0.1:0`: what the control plane did not ack arrives once, in order,
//! after the reconnect.
#![cfg(windows)]

use std::{future::Future, time::Duration};

use devrounds_core::gate::MemoryPressure;
use devrounds_executor::{
    admission::AdmissionConfig,
    config::ExecutorConfig,
    connection::{Connection, Handler},
};
use devrounds_protocol::{
    Ack, ClientMessage, HelloAck, MachineReport, PROTOCOL, Resync, RunEvent, ServerMessage,
    decode_client, encode_server,
};
use devrounds_store::Store;
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{WebSocketStream, tungstenite::Message};

const LIMIT: Duration = Duration::from_secs(20);
/// How long the server listens for an event that must not come.
const QUIET: Duration = Duration::from_millis(500);
const TOKEN: &str = "drm_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async fn bounded<T, F: Future<Output = T>>(body: F) -> T {
    tokio::time::timeout(LIMIT, body)
        .await
        .expect("test timed out")
}

struct Quiet;

impl Handler for Quiet {
    fn boot_id(&self) -> String {
        "boot-1".to_owned()
    }

    fn report(&mut self) -> MachineReport {
        MachineReport {
            total_memory: 16 << 30,
            available_memory: 8 << 30,
            commit_total: 10 << 30,
            commit_limit: 32 << 30,
            cpu_percent: 1.0,
            memory_pressure: MemoryPressure::Normal,
            running: 0,
            executor_private_bytes: 20_000_000,
        }
    }

    fn on_message(&mut self, _message: ServerMessage) {}
}

type Socket = WebSocketStream<TcpStream>;

/// Accepts one session, reads its `Hello` and answers `HelloAck { last_seq }`.
async fn accept(listener: &TcpListener, last_seq: u64) -> Socket {
    let (stream, _) = listener.accept().await.expect("accept");
    let mut socket = tokio_tungstenite::accept_async(stream)
        .await
        .expect("handshake");
    assert!(matches!(
        next(&mut socket).await,
        Some(ClientMessage::Hello(_))
    ));
    send(
        &mut socket,
        ServerMessage::HelloAck(HelloAck {
            protocol: PROTOCOL,
            features: vec!["seq".to_owned()],
            machine_id: "m-1".to_owned(),
            last_seq,
        }),
    )
    .await;
    socket
}

async fn send(socket: &mut Socket, message: ServerMessage) {
    socket
        .send(Message::text(encode_server(&message).expect("encode")))
        .await
        .expect("send");
}

/// The next message other than a `MachineReport`; None when the socket ends.
async fn next(socket: &mut Socket) -> Option<ClientMessage> {
    loop {
        match socket.next().await? {
            Ok(Message::Text(text)) => match decode_client(&text).expect("decode") {
                ClientMessage::MachineReport(_) => {}
                message => return Some(message),
            },
            Ok(_) => {}
            Err(error) => panic!("socket failed: {error}"),
        }
    }
}

/// The seqs of the next `count` events, and the run each carries.
async fn events(socket: &mut Socket, count: usize) -> Vec<(u64, String)> {
    let mut seen = Vec::new();
    while seen.len() < count {
        match next(socket).await {
            Some(ClientMessage::Event(event)) => {
                let RunEvent::Admitted { run } = event.event else {
                    panic!("unexpected event {:?}", event.event);
                };
                seen.push((event.seq, run));
            }
            other => panic!("expected an Event, got {other:?}"),
        }
    }
    seen
}

/// Nothing but reports arrives for a while.
async fn nothing_more(socket: &mut Socket) {
    if let Ok(message) = tokio::time::timeout(QUIET, next(socket)).await {
        panic!("expected nothing more, got {message:?}");
    }
}

fn admitted(run: &str) -> RunEvent {
    RunEvent::Admitted {
        run: run.to_owned(),
    }
}

fn expected(seqs: &[u64]) -> Vec<(u64, String)> {
    seqs.iter().map(|seq| (*seq, format!("r{seq}"))).collect()
}

#[tokio::test]
async fn a_fresh_store_continues_after_the_control_planes_last_seq() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
    let store = Store::open(&dir.path().join("executor.db"))
        .await
        .expect("store");
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let config = ExecutorConfig {
        url: format!("http://{}", listener.local_addr().expect("addr")),
        machine_id: "m-1".to_owned(),
        admission: AdmissionConfig::default(),
        otlp_endpoint: None,
    };
    let connection = Connection::new(store.clone());
    let mut connected = connection.connected();
    let client = tokio::spawn(async move { connection.run(&config, TOKEN, &mut Quiet).await });

    bounded(async {
        // The control plane applied seqs up to 7 from this machine's previous store.
        let mut socket = accept(&listener, 7).await;
        connected.wait_for(|up| *up).await.expect("connected");
        let seq = store.append_event(admitted("r8")).await.expect("append");
        assert_eq!(seq, 8);
        assert_eq!(events(&mut socket, 1).await, expected(&[8]));
        send(&mut socket, ServerMessage::Ack(Ack { seq: 8 })).await;
        while !store.pending_after(0).await.expect("pending").is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    client.abort();
}

#[tokio::test]
async fn a_backlog_of_large_segments_is_resent_whole_and_in_order() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
    let store = Store::open(&dir.path().join("executor.db"))
        .await
        .expect("store");
    // About 12 MiB of segments left by a long disconnect: several resend pages.
    for first in 0..12u64 {
        let event = RunEvent::LogSegment {
            run: "r1".to_owned(),
            first_seq: first * 10 + 1,
            last_seq: first * 10 + 10,
            records: 10,
            zstd_base64: "A".repeat(1024 * 1024),
        };
        store.append_event(event).await.expect("append");
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let config = ExecutorConfig {
        url: format!("http://{}", listener.local_addr().expect("addr")),
        machine_id: "m-1".to_owned(),
        admission: AdmissionConfig::default(),
        otlp_endpoint: None,
    };
    let connection = Connection::new(store.clone());
    let client = tokio::spawn(async move { connection.run(&config, TOKEN, &mut Quiet).await });

    bounded(async {
        let mut socket = accept(&listener, 0).await;
        let mut seen = Vec::new();
        while seen.len() < 12 {
            match next(&mut socket).await {
                Some(ClientMessage::Event(event)) => {
                    let RunEvent::LogSegment { first_seq, .. } = event.event else {
                        panic!("unexpected event {:?}", event.event);
                    };
                    seen.push((event.seq, first_seq));
                }
                other => panic!("expected an Event, got {other:?}"),
            }
        }
        let expected: Vec<(u64, u64)> = (1..=12).map(|seq| (seq, (seq - 1) * 10 + 1)).collect();
        assert_eq!(seen, expected);
        nothing_more(&mut socket).await;
    })
    .await;
    client.abort();
}

#[tokio::test]
async fn reconnect_replays_unacked_events_in_order() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
    let store = Store::open(&dir.path().join("executor.db"))
        .await
        .expect("store");
    // Two events wait in the outbox before any session; three more come live.
    for seq in 1..=2 {
        store
            .append_event(admitted(&format!("r{seq}")))
            .await
            .expect("append");
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let config = ExecutorConfig {
        url: format!("http://{}", listener.local_addr().expect("addr")),
        machine_id: "m-1".to_owned(),
        admission: AdmissionConfig::default(),
        otlp_endpoint: None,
    };
    let connection = Connection::new(store.clone());
    let mut connected = connection.connected();
    let client = tokio::spawn(async move { connection.run(&config, TOKEN, &mut Quiet).await });

    bounded(async {
        let mut first = accept(&listener, 0).await;
        assert_eq!(events(&mut first, 2).await, expected(&[1, 2]));
        connected.wait_for(|up| *up).await.expect("connected");
        for seq in 3..=5 {
            store
                .append_event(admitted(&format!("r{seq}")))
                .await
                .expect("append");
        }
        assert_eq!(events(&mut first, 3).await, expected(&[3, 4, 5]));
        // The control plane applies two, then goes away mid-session.
        send(&mut first, ServerMessage::Ack(Ack { seq: 2 })).await;
        drop(first);
        connected.wait_for(|up| !*up).await.expect("disconnected");

        // After its restart it has applied through 2.
        let mut second = accept(&listener, 2).await;
        assert_eq!(events(&mut second, 3).await, expected(&[3, 4, 5]));
        nothing_more(&mut second).await;

        // A Resync resends from its seq; an Ack empties the outbox.
        send(&mut second, ServerMessage::Resync(Resync { from_seq: 4 })).await;
        assert_eq!(events(&mut second, 2).await, expected(&[4, 5]));
        nothing_more(&mut second).await;
        send(&mut second, ServerMessage::Ack(Ack { seq: 5 })).await;
        while !store.pending_after(0).await.expect("pending").is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    client.abort();
}
