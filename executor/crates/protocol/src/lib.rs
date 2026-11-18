//! Wire messages between the executor and the control plane: JSON text
//! frames over WebSocket, the message type in the envelope field `type`.
//! `control-plane/src/executor/protocol.ts` mirrors every type here 1:1, and
//! both sides test against the files in `fixtures/`.
//!
//! Field names are the JSON keys (snake_case). The executor sends
//! [`ClientMessage`] and receives [`ServerMessage`].

use devrounds_core::{DrError, JobSpec, gate::MemoryPressure};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

/// The protocol version both sides send in `Hello` and `HelloAck`.
pub const PROTOCOL: u32 = 1;

/// Optional capabilities this build speaks; a session uses the intersection.
pub const FEATURES: [&str; 5] = ["seq", "steps", "log-segments", "orphans", "trace-context"];

/// The features both sides speak, in the order of `ours`.
pub fn negotiate<A: AsRef<str>, B: AsRef<str>>(ours: &[A], theirs: &[B]) -> Vec<String> {
    ours.iter()
        .map(AsRef::as_ref)
        .filter(|feature| theirs.iter().any(|their| their.as_ref() == *feature))
        .map(str::to_owned)
        .collect()
}

/// Executor → control plane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    Hello(Hello),
    MachineReport(MachineReport),
    LogChunk(LogChunk),
    Event(Event),
    /// A type this build does not know, sent by a newer executor; the
    /// control plane ignores it.
    #[serde(other)]
    Unknown,
}

/// Control plane → executor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    HelloAck(HelloAck),
    Offer(Offer),
    Stop(Stop),
    Ack(Ack),
    Resync(Resync),
    /// A type this build does not know, sent by a newer control plane; the
    /// executor ignores it.
    #[serde(other)]
    Unknown,
}

/// The first message of every session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub protocol: u32,
    /// The executor's release version.
    pub version: String,
    pub features: Vec<String>,
    pub boot_id: String,
}

/// Machine state, sent periodically. Memory figures are bytes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineReport {
    pub total_memory: u64,
    pub available_memory: u64,
    pub commit_total: u64,
    pub commit_limit: u64,
    /// Busy share of all CPUs, 0-100.
    pub cpu_percent: f64,
    pub memory_pressure: MemoryPressure,
    pub running: u32,
    /// Private bytes of the executor's own processes.
    pub executor_private_bytes: u64,
}

/// Live output for watchers. Not sequenced and never acked: the durable copy
/// travels as `LogSegment` events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogChunk {
    pub run: String,
    pub stream: LogStream,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogStream {
    Stdout,
    Stderr,
}

/// A durable run event. `seq` grows by one per event of the executor; the
/// control plane acks it and answers a gap with one `Resync`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub seq: u64,
    /// RFC 3339 UTC.
    pub at: String,
    pub event: RunEvent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum RunEvent {
    Admitted {
        run: String,
    },
    Delayed {
        run: String,
        reason: DelayReason,
        /// 1-based place among the runs waiting.
        position: u32,
        /// Bytes.
        need: u64,
        /// Bytes; `None` before the first memory reading.
        available: Option<u64>,
    },
    RunStarted {
        run: String,
        pid: u32,
        /// The process birth token of [`devrounds_core::ProcessIdentity`].
        /// A Windows FILETIME exceeds 2^53, so it travels as a decimal string
        /// that a JavaScript number cannot round.
        #[serde(with = "decimal")]
        start_time: u64,
        boot_id: String,
    },
    StepStarted {
        run: String,
        step: u32,
        name: String,
    },
    StepFinished {
        run: String,
        step: u32,
        outcome: StepOutcome,
    },
    LogSegment {
        run: String,
        first_seq: u64,
        last_seq: u64,
        records: u32,
        zstd_base64: String,
    },
    RunFinished {
        run: String,
        reason: FinishReason,
        exit_code: Option<i64>,
        /// Footprint in private bytes: exact peak, then percentiles of the samples.
        peak: u64,
        p95: u64,
        p50: u64,
        cpu_seconds: f64,
        /// Processes still alive at the end and killed with the job.
        swept: u32,
        visible_windows: u32,
        /// Last output lines.
        tail: Vec<String>,
        summary: Option<String>,
    },
    /// Runs found from a previous executor process at start.
    Orphans {
        runs: Vec<Orphan>,
    },
    /// A kind this build does not know; the receiver ignores it.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DelayReason {
    Memory,
    Concurrency,
    MemoryCritical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepOutcome {
    Finished,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    Exited,
    Stopped,
    Timeout,
    SpawnFailed,
    Infra,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Orphan {
    pub run: String,
    pub alive: bool,
}

/// The control plane's answer to `Hello`: the negotiated features and the last
/// event seq it applied, after which the executor resends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloAck {
    pub protocol: u32,
    pub features: Vec<String>,
    pub machine_id: String,
    pub last_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Offer {
    pub run: String,
    pub job: JobSpec,
    /// Bytes the run is expected to need.
    pub memory_need: u64,
    /// W3C `traceparent` of the dispatch span.
    pub trace_parent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stop {
    pub run: String,
    pub reason: StopReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    Cancel,
    OrphanPolicy,
}

/// Every event up to and including `seq` is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ack {
    pub seq: u64,
}

/// Resend every event from `from_seq` on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resync {
    pub from_seq: u64,
}

/// Decodes a control plane frame. An unknown `type` decodes to
/// [`ServerMessage::Unknown`]; a known one with a bad shape answers DR150.
pub fn decode_server(text: &str) -> Result<ServerMessage, DrError> {
    decode(text)
}

/// Decodes an executor frame, the control plane's direction; used by tests and tools.
pub fn decode_client(text: &str) -> Result<ClientMessage, DrError> {
    decode(text)
}

pub fn encode_client(message: &ClientMessage) -> Result<String, DrError> {
    encode(message)
}

pub fn encode_server(message: &ServerMessage) -> Result<String, DrError> {
    encode(message)
}

// Through a Value first so DR150 can name the message type. serde reports no
// JSON pointer, so `path` is `/` unless the envelope itself is wrong.
fn decode<T: DeserializeOwned>(text: &str) -> Result<T, DrError> {
    let value: Value = serde_json::from_str(text)
        .map_err(|error| invalid(None, "/", &format!("not JSON: {error}")))?;
    let Some(kind) = value.get("type").and_then(Value::as_str).map(str::to_owned) else {
        return Err(invalid(None, "/type", "missing or not a string"));
    };
    serde_json::from_value(value).map_err(|error| invalid(Some(&kind), "/", &error.to_string()))
}

fn encode<T: Serialize>(message: &T) -> Result<String, DrError> {
    serde_json::to_string(message).map_err(|error| invalid(None, "/", &error.to_string()))
}

fn invalid(kind: Option<&str>, path: &str, reason: &str) -> DrError {
    let mut data = json!({ "path": path, "reason": reason });
    if let Some(kind) = kind {
        data["type"] = json!(kind);
    }
    DrError::new("DR150", data)
}

/// `u64` as a decimal JSON string.
mod decimal {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(value)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let text = String::deserialize(deserializer)?;
        text.parse().map_err(D::Error::custom)
    }
}
