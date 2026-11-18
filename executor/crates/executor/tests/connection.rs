//! Pairing, the home lock and the session against fake control planes on
//! `127.0.0.1:0`.
#![cfg(windows)]

use std::{
    future::Future,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use devrounds_core::{DrError, gate::MemoryPressure};
use devrounds_executor::{
    config::{CONFIG_FILE, ExecutorConfig, HomeLock, TOKEN_FILE},
    connection::{Connection, Handler},
    pair::pair,
};
use devrounds_protocol::{
    ClientMessage, HelloAck, MachineReport, PROTOCOL, ServerMessage, decode_client, encode_server,
};
use devrounds_sys_windows::security::check_private_file;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        Message,
        handshake::server::{Callback, ErrorResponse, Request, Response},
    },
};

const LIMIT: Duration = Duration::from_secs(20);
const TOKEN: &str = "drm_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async fn bounded<T, F: Future<Output = T>>(body: F) -> T {
    tokio::time::timeout(LIMIT, body)
        .await
        .expect("test timed out")
}

fn home() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir")
}

#[derive(Default)]
struct Recorder {
    messages: Arc<Mutex<Vec<ServerMessage>>>,
}

fn report() -> MachineReport {
    MachineReport {
        total_memory: 16 << 30,
        available_memory: 8 << 30,
        commit_total: 10 << 30,
        commit_limit: 32 << 30,
        cpu_percent: 7.5,
        memory_pressure: MemoryPressure::Normal,
        running: 0,
        executor_private_bytes: 20_000_000,
    }
}

impl Handler for Recorder {
    fn boot_id(&self) -> String {
        "boot-1".to_owned()
    }

    fn report(&mut self) -> MachineReport {
        report()
    }

    fn on_message(&mut self, message: ServerMessage) {
        self.messages
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(message);
    }
}

#[tokio::test]
async fn ws_to_a_non_loopback_host_is_refused() {
    for url in [
        "http://example.com",
        "http://10.0.0.5:4992",
        "ftp://127.0.0.1",
    ] {
        let config = ExecutorConfig {
            url: url.to_owned(),
            machine_id: "m".to_owned(),
        };
        let error = bounded(Connection::run(&config, TOKEN, &mut Recorder::default()))
            .await
            .expect_err(url);
        assert_eq!(error.code, "DR551", "{url}: {error}");
    }
}

/// Answers one HTTP request with `status` and `body` and hands back the
/// request body.
fn fake_pair_server(status: u16, body: Value) -> (String, std::thread::JoinHandle<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!("http://{}", listener.local_addr().expect("addr"));
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept");
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        let mut length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("header");
            if line == "\r\n" {
                break;
            }
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse().expect("length");
            }
        }
        let mut request = vec![0; length];
        reader.read_exact(&mut request).expect("body");
        let text = body.to_string();
        let mut stream = stream;
        write!(
            stream,
            "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
            text.len()
        )
        .expect("respond");
        serde_json::from_slice(&request).expect("request json")
    });
    (url, server)
}

#[tokio::test]
async fn pair_writes_an_owner_only_token_file() {
    let dir = home();
    let home = dir.path().join("executor");
    let answer = json!({ "machineId": "m-1", "machineName": "build-01", "token": TOKEN });
    let (url, server) = fake_pair_server(200, answer);

    bounded(pair(&home, &url, "ABCD1234")).await.expect("pair");

    let sent = server.join().expect("server");
    assert_eq!(sent["code"], "ABCD1234");
    assert_eq!(sent["os"], "windows");
    let token_path = home.join(TOKEN_FILE);
    assert_eq!(
        check_private_file(&token_path).expect("check"),
        Ok(()),
        "the token file must be private to this user"
    );
    assert_eq!(std::fs::read_to_string(&token_path).expect("token"), TOKEN);
    let config: ExecutorConfig =
        serde_json::from_slice(&std::fs::read(home.join(CONFIG_FILE)).expect("config"))
            .expect("config json");
    assert_eq!(
        config,
        ExecutorConfig {
            url,
            machine_id: "m-1".to_owned()
        }
    );
    let config_text = std::fs::read_to_string(home.join(CONFIG_FILE)).expect("config");
    assert!(
        !config_text.contains(TOKEN),
        "the token stays out of config.json"
    );
}

#[tokio::test]
async fn a_refused_code_writes_nothing_and_carries_the_server_code() {
    let dir = home();
    let home = dir.path().join("executor");
    let refused = json!({ "code": "DR450", "text": "x", "hint": "y", "data": {} });
    let (url, server) = fake_pair_server(401, refused);

    let error = bounded(pair(&home, &url, "ABCD1234"))
        .await
        .expect_err("refused");
    server.join().expect("server");
    assert_eq!(error, DrError::new("DR450", json!({})));
    assert!(!home.join(TOKEN_FILE).exists());
    assert!(!home.join(CONFIG_FILE).exists());
}

#[tokio::test]
async fn a_second_executor_on_the_same_home_fails_with_dr352() {
    let dir = home();
    let first = HomeLock::acquire(dir.path()).await.expect("first");
    let error = HomeLock::acquire(dir.path()).await.expect_err("second");
    assert_eq!(error.code, "DR352");
    assert_eq!(error.data["pid"], std::process::id().to_string());
    assert_eq!(error.data["home"], dir.path().display().to_string());
    drop(first);
    HomeLock::acquire(dir.path())
        .await
        .expect("free again after the holder drops it");
}

#[tokio::test]
async fn hello_then_machine_report_reach_the_server() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let config = ExecutorConfig {
        url: format!("http://{}", listener.local_addr().expect("addr")),
        machine_id: "m-1".to_owned(),
    };
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("accept");
        let authorization = Arc::new(Mutex::new(None));
        let callback = CaptureAuthorization(Arc::clone(&authorization));
        let mut socket = tokio_tungstenite::accept_hdr_async(stream, callback)
            .await
            .expect("handshake");
        let hello = next_message(&mut socket).await;
        let ack = ServerMessage::HelloAck(HelloAck {
            protocol: PROTOCOL,
            features: vec!["seq".to_owned()],
            machine_id: "m-1".to_owned(),
            last_seq: 0,
        });
        socket
            .send(Message::text(encode_server(&ack).expect("encode")))
            .await
            .expect("ack");
        let sent = next_message(&mut socket).await;
        let authorization = authorization
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        (authorization, hello, sent)
    });

    let mut recorder = Recorder::default();
    let messages = Arc::clone(&recorder.messages);
    let client = tokio::spawn(async move { Connection::run(&config, TOKEN, &mut recorder).await });
    let (authorization, hello, sent) = bounded(server).await.expect("server");
    client.abort();

    assert_eq!(authorization, Some(format!("Bearer {TOKEN}")));
    let ClientMessage::Hello(hello) = hello else {
        panic!("first message must be Hello, got {hello:?}");
    };
    assert_eq!(hello.protocol, PROTOCOL);
    assert_eq!(hello.boot_id, "boot-1");
    assert_eq!(sent, ClientMessage::MachineReport(report()));
    let messages = messages.lock().unwrap_or_else(PoisonError::into_inner);
    assert!(matches!(messages.first(), Some(ServerMessage::HelloAck(_))));
}

async fn next_message(socket: &mut WebSocketStream<tokio::net::TcpStream>) -> ClientMessage {
    match socket.next().await {
        Some(Ok(Message::Text(text))) => decode_client(&text).expect("decode"),
        other => panic!("expected a text frame, got {other:?}"),
    }
}

/// Keeps the `Authorization` header of the upgrade request.
struct CaptureAuthorization(Arc<Mutex<Option<String>>>);

impl Callback for CaptureAuthorization {
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        assert_eq!(request.uri().path(), "/api/executor/connect");
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = request
            .headers()
            .get("authorization")
            .map(|value| value.to_str().expect("ascii").to_owned());
        Ok(response)
    }
}
