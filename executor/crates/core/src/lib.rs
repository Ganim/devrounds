//! Domain contracts shared by the executor crates: process lifecycle, start
//! gate, clock, stop signals and DevRounds errors. Copied from devlanes-core
//! and trimmed (see `executor/NOTICE`).

pub mod clock;
pub mod env;
mod error;
pub mod gate;
mod job;
pub mod paths;
pub mod runtime;
mod stop;

pub use error::DrError;
pub use job::JobSpec;
pub use runtime::*;
pub use stop::StopSignal;
#[cfg(windows)]
pub use stop::WindowsStop;

/// Domain and integration failures without presentation-layer diagnostics.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("operation unsupported: {0}")]
    Unsupported(String),
    #[error("unit is no longer running")]
    Exited,
    #[error("I/O failure: {0}")]
    Io(#[from] std::io::Error),
    #[error("integration failed: {0}")]
    Integration(String),
}
