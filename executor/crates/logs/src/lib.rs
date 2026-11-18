//! Synchronous, single-writer per-run log storage.
//!
//! The executor must own each [`UnitLog`] on a writer thread or call it through
//! `spawn_blocking`; opening, ingestion, compression and retention perform disk
//! I/O. A lock file keeps a second writer out of a directory, and
//! [`LogReader::open`] reads a directory's segment metadata without modifying
//! it. Use one stream identifier per stdout/stderr byte stream. Copied from
//! devlanes-logs without its query engine (see `executor/NOTICE`).
//!
//! ```
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! use devrounds_logs::{LogOptions, UnitLog};
//! let tmp = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
//! std::fs::create_dir_all(&tmp)?;
//! let run = tempfile::tempdir_in(tmp)?;
//! let mut logs = UnitLog::open(run.path(), "api", LogOptions::default())?;
//! logs.ingest(b"\x1b[31mERROR unavailable\x1b[0m\n", 1_000)?;
//! assert_eq!(logs.next_sequence(), 2);
//! logs.finish(1_001)?;
//! # Ok(()) }
//! ```

mod framing;
mod level;
mod storage;

pub use framing::{Frame, Framer, MAX_LINE_BYTES, PARTIAL_FLUSH_MS, SGR_RESET};
pub use level::extract_level;
use serde::{Deserialize, Serialize};
pub use storage::{
    IndexEntry, LogOptions, LogReader, SegmentMetadata, UnitLog, line_records, read_segment,
    strip_sgr,
};

/// One stored log line. Moved here from devlanes-proto, which DevRounds does
/// not copy; devlanes' `unit` field is the run id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogLine {
    pub run: String,
    pub seq: u64,
    pub timestamp_ms: u64,
    /// The line without terminal escapes; what `level` looks at.
    pub text: String,
    pub level: Option<String>,
    /// `text` with the run's SGR color sequences, ending in a reset so nothing
    /// carries into the next line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub styled: Option<String>,
}

/// Expected failures are suitable for conversion into executor errors.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("log I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("log metadata: {0}")]
    Metadata(#[from] serde_json::Error),
    #[error("invalid log options: {0}")]
    Options(&'static str),
    #[error("corrupt log record: {0}")]
    Corrupt(String),
    #[error("log sequence exhausted")]
    SequenceExhausted,
    #[error("log writer failed previously; reopen the run to recover")]
    WriterFailed,
    /// Another writer holds the directory, usually a previous run still closing it.
    #[error("log directory is in use by another writer")]
    Locked,
}

/// Library operations never hide filesystem failures.
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests;
