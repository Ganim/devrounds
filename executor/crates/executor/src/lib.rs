//! The DevRounds executor. Later tasks add pairing, the connection to the
//! control plane, admission, isolation and the run loop here.

#[cfg(windows)]
mod sampler;

#[cfg(windows)]
pub use sampler::{IDLE_INTERVAL, SLOT_INTERVAL, Sampler};
