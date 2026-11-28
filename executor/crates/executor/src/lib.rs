//! The DevRounds executor: pairing, the session with the control plane,
//! admission, isolation, sampling and the run loop.

pub mod admission;
#[cfg(windows)]
pub mod config;
#[cfg(windows)]
pub mod connection;
#[cfg(windows)]
mod environment;
pub mod isolation;
#[cfg(windows)]
pub mod orphans;
#[cfg(windows)]
mod output;
#[cfg(windows)]
pub mod pair;
#[cfg(windows)]
pub mod runs;
#[cfg(windows)]
mod sampler;
#[cfg(windows)]
pub mod service;
pub mod stall;
pub mod steps;
#[cfg(windows)]
pub mod supervise;
pub mod telemetry;

#[cfg(windows)]
pub use sampler::{IDLE_INTERVAL, SLOT_INTERVAL, Sampler};
