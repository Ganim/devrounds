//! Windows process collector for `devrounds-metrics`.
//!
//! CPU is the change in a process's kernel plus user time between samples.
//! Memory is private bytes (commit no other process shares, resident or not)
//! as the footprint, never the working set, which is reported as RSS only
//! (spec §16.5). [`WindowsSource::sample_run`] sums a run's job members.
//!
//! `WindowsPressure` is the start gate's `PressureSource`: system CPU from
//! `GetSystemTimes`, the memory level from Windows' low-memory notification and
//! `GlobalMemoryStatusEx`'s available physical memory.
//!
//! All system calls go through the safe wrappers in `devrounds_sys_windows::usage`.
//! On other platforms this crate is empty.

#![forbid(unsafe_code)]

#[cfg(windows)]
mod collector;
#[cfg(windows)]
mod pressure;

#[cfg(windows)]
pub use collector::{WindowsSource, process_identity};
#[cfg(windows)]
pub use devrounds_sys_windows::usage::self_private_bytes;
#[cfg(windows)]
pub use pressure::WindowsPressure;
