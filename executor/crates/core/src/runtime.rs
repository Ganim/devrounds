//! Process lifecycle contracts; concrete runners own all OS interaction.

use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

use async_trait::async_trait;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::{Error, StopSignal};

/// Complete launch input. Deliberately neither serializable nor debug-printable:
/// the environment can contain secrets and must stay in memory.
pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}

/// Signal and escalation delay for an explicit stop request.
#[derive(Debug, Clone, Copy)]
pub struct StopPolicy {
    pub signal: StopSignal,
    pub timeout: Duration,
}

impl Default for StopPolicy {
    /// Requests SIGTERM followed by SIGKILL after ten seconds.
    fn default() -> Self {
        Self {
            signal: StopSignal::Terminate,
            timeout: Duration::from_secs(10),
        }
    }
}

/// How units deliver stderr.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StderrMode {
    /// Separate pipes; chunks are tagged `Stdout` or `Stderr`.
    #[default]
    Separate,
    /// One shared pipe preserving write order; every chunk is tagged `Stdout`.
    Merged,
}

/// OS identity used to reject PID reuse during reconciliation and signalling.
/// `start_time` is the platform's stable process birth token, not wall-clock time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ProcessIdentity {
    pub pid: u32,
    /// The Unix session; 0 when unknown, and always on Windows, which has none.
    pub sid: u32,
    pub start_time: u64,
}

/// One process-table entry. `start_time` uses the same units as
/// [`ProcessIdentity`]. Moved here from devlanes-sys, which DevRounds does not copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: u32,
    /// Absent when the platform refused to report the session, and always on
    /// Windows, which has none.
    pub sid: Option<u32>,
    pub start_time: u64,
    /// Exited while some process still holds a handle to it.
    pub zombie: bool,
    pub name: String,
}

impl ProcessInfo {
    /// Returns the identity used for PID-reuse-safe signalling; an unknown session is 0.
    pub fn identity(&self) -> ProcessIdentity {
        ProcessIdentity {
            pid: self.pid,
            sid: self.sid.unwrap_or(0),
            start_time: self.start_time,
        }
    }
}

/// Terminal result shared by every waiter, including waiters arriving after exit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExitOutcome {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

/// Source of raw output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputStream {
    Stdout,
    Stderr,
}

/// One bounded output chunk. Lagging consumers must recover from a snapshot/log.
#[derive(Debug, Clone)]
pub struct OutputChunk {
    pub stream: OutputStream,
    pub bytes: Bytes,
}

/// Why a Windows runner did not start a unit, before any process existed.
/// Runners return it as the source of an [`Error::Io`], so the executor can
/// name the case in its `spawn_failed` error without depending on the runner.
#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct SpawnRefusal {
    /// `shell_missing`, `cwd_too_long`, `not_found`, `unsafe_batch_argument`,
    /// `invalid_command` or `invalid_environment`.
    pub code: &'static str,
    pub message: String,
    /// With `not_found`: the `PATH` directories tried for a bare name, or the
    /// directory an explicit path names.
    pub searched: Vec<PathBuf>,
}

/// Launches executor-owned processes without binding callers to a particular runner.
#[async_trait]
pub trait Runner: Send + Sync {
    /// Starts a unit and returns after its identity is available.
    async fn spawn(&self, spec: LaunchSpec) -> Result<Arc<dyn Unit>, Error>;
}

/// A managed process and its tracked descendants; dropping handles must not stop it.
#[async_trait]
pub trait Unit: Send + Sync {
    /// Signals verified members and tracked descendants, escalating on timeout.
    async fn stop(&self, policy: StopPolicy) -> Result<(), Error>;
    /// Waits idempotently for exit. Implementations must support concurrent waiters.
    async fn wait(&self) -> Result<ExitOutcome, Error>;
    /// Subscribes to future raw output without blocking process output draining.
    fn output(&self) -> broadcast::Receiver<OutputChunk>;
    /// Returns the leader and known descendants with PID-reuse-resistant identities.
    async fn subjects(&self) -> Result<Vec<ProcessIdentity>, Error>;
}
