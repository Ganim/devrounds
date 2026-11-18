//! Platform-neutral resource monitoring: samples, per-run summaries and
//! baselines. Monitoring only; nothing here limits or signals processes.
//! Copied from devlanes-metrics without its history and roll-ups; the subject
//! of a sample is a run id instead of a lane unit (see `executor/NOTICE`).
//!
//! Collectors (`devrounds-metrics-windows`) implement [`MetricsSource`] and
//! emit leaf samples ([`Subject::Process`], [`Subject::Daemon`]). The executor
//! sums a run's leaves into a [`Subject::Run`] sample and feeds it to
//! [`RunTracker`].
//!
//! ```
//! use devrounds_metrics::{RunTracker, Sample, Subject};
//!
//! let mut tracker = RunTracker::default();
//! tracker.start("run-1".into(), 1_000);
//! tracker.observe(&Sample {
//!     subject: Subject::Run { run: "run-1".into() },
//!     cpu_percent: 12.5,
//!     footprint_bytes: 1 << 20,
//!     rss_bytes: 1 << 19,
//!     ts_ms: 2_000,
//! });
//! let summary = tracker.finish("run-1", 3_000).expect("tracked");
//! assert_eq!(summary.footprint.peak, 1 << 20);
//! ```

mod ring;
mod run;
mod sketch;

pub use ring::Ring;
pub use run::{
    Baseline, BaselinePolicy, ByteSummary, CpuSummary, RunSummary, RunTracker, baseline,
};
pub use sketch::QuantileSketch;

use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use devrounds_core::ProcessIdentity;
use serde::{Deserialize, Serialize};

/// What a sample measures. Collectors emit leaves; the executor sums a run's
/// leaves into its [`Subject::Run`] total.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Subject {
    /// The whole process tree of one run.
    Run { run: String },
    /// One process of a run. `start_time` uses the [`ProcessIdentity`] token.
    Process {
        run: String,
        pid: u32,
        start_time: u64,
    },
    /// The executor's own process.
    Daemon,
}

impl Subject {
    /// Returns the owning run for run and process subjects.
    pub fn run(&self) -> Option<&str> {
        match self {
            Self::Run { run } | Self::Process { run, .. } => Some(run),
            Self::Daemon => None,
        }
    }
}

/// One measurement. CPU is a percentage of one core (200 = two busy cores), the
/// convention shared by `ps`, `top` and Task Manager's details view.
///
/// `footprint_bytes` is the primary memory number; `rss_bytes` is for detail
/// views only, it double counts shared pages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sample {
    pub subject: Subject,
    pub cpu_percent: f64,
    pub footprint_bytes: u64,
    pub rss_bytes: u64,
    /// Unix time in milliseconds when the collector read the value.
    pub ts_ms: u64,
}

/// Processes the executor attributes to one run. The executor owns membership
/// tracking (the run's job); collectors only measure what they are given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitTarget {
    pub run: String,
    /// Session ids whose members belong to the run. Unused on Windows, which
    /// has no sessions; collectors ignore 0 and 1.
    pub sessions: Vec<u32>,
    /// Leader and tracked descendants. Entries whose start time no longer
    /// matches are skipped because the PID was reused.
    pub processes: Vec<ProcessIdentity>,
}

/// Everything to sample in one tick.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SampleRequest {
    pub units: Vec<UnitTarget>,
    /// The executor's own process, sampled alone as [`Subject::Daemon`] and
    /// never part of any run.
    pub daemon: Option<ProcessIdentity>,
}

/// Collector failures. Processes that vanish mid-sample are skipped, not
/// reported, because exits between ticks are normal.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("I/O failure: {0}")]
    Io(#[from] std::io::Error),
    #[error("{source_name} unavailable: {detail}")]
    Unavailable {
        source_name: &'static str,
        detail: String,
    },
    #[error("malformed {what}: {detail}")]
    Malformed { what: &'static str, detail: String },
}

/// A metrics collector. Implementations keep the previous reading per process
/// so CPU percentages are deltas between successive calls. A process's first
/// reading reports 0 on Windows, whose clocks are too coarse for a young
/// process's average.
///
/// Implementations must not block the async executor; blocking OS reads belong in
/// `spawn_blocking`.
#[async_trait]
pub trait MetricsSource: Send + Sync {
    /// Short identifier for diagnostics (`windows`).
    fn name(&self) -> &'static str;

    /// Samples the request's subjects this source understands and returns leaf
    /// samples. Subjects the source cannot see are omitted.
    async fn sample(&self, request: &SampleRequest) -> Result<Vec<Sample>, Error>;
}

/// Converts a wall-clock instant to Unix milliseconds, clamping pre-epoch times to 0.
pub fn unix_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map_or(0, |elapsed| {
        u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
    })
}
