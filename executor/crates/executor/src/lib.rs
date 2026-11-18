//! The DevRounds executor. Later tasks add pairing, the connection to the
//! control plane, isolation and the run loop here.

pub mod admission;
#[cfg(windows)]
mod sampler;

#[cfg(windows)]
pub use sampler::{IDLE_INTERVAL, SLOT_INTERVAL, Sampler};
