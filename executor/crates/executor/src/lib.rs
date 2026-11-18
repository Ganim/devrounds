//! The DevRounds executor: pairing, the session with the control plane,
//! admission, isolation and sampling. Later tasks add the run loop here.

pub mod admission;
#[cfg(windows)]
pub mod config;
#[cfg(windows)]
pub mod connection;
pub mod isolation;
#[cfg(windows)]
pub mod pair;
#[cfg(windows)]
mod sampler;

#[cfg(windows)]
pub use sampler::{IDLE_INTERVAL, SLOT_INTERVAL, Sampler};
