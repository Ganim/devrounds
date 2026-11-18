//! Start admission for runs: one machine-wide [`AdaptiveGate`] whose window
//! follows CPU and memory pressure (AIMD), wrapped so the executor can report
//! why a run waits. Admission never refuses a run for memory; it waits until
//! the need fits or the starts in flight finish, settle or time out.

use std::{sync::Arc, time::Duration};

use devrounds_core::{
    clock::Clock,
    gate::{
        GateSnapshot, HoldReason, PressureSource, StartGate, StartRequest, StartSlot, StartTicket,
    },
};
use devrounds_start_gate::{AdaptiveConfig, AdaptiveGate, GateOptions};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

pub use devrounds_core::gate::DEFAULT_MEMORY_NEED;

/// Admission tuning; executor config `admission.*`. Missing fields take the
/// defaults.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AdmissionConfig {
    /// Window at the start of each busy period.
    pub initial_window: usize,
    /// Largest window the AIMD controller may grow to.
    pub max_window: usize,
    /// System CPU (percent of the whole machine) below which the window grows.
    pub target_cpu: f64,
    /// A start slot is given back after this even if the run never settled or
    /// exited, so a long-starting run cannot hold the queue.
    #[serde(rename = "slot_timeout_s", with = "seconds")]
    pub slot_timeout: Duration,
}

/// A duration as whole seconds in config.json.
mod seconds {
    use std::time::Duration;

    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &Duration, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u64(value.as_secs())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Duration, D::Error> {
        u64::deserialize(deserializer).map(Duration::from_secs)
    }
}

impl Default for AdmissionConfig {
    /// Window 4 up to 16, grow below 80% CPU, 60 s slot timeout.
    fn default() -> Self {
        Self {
            initial_window: 4,
            max_window: 16,
            target_cpu: 80.0,
            slot_timeout: Duration::from_secs(60),
        }
    }
}

/// Why a run is not admitted yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DelayReason {
    /// The run's need does not fit in the available memory yet.
    Memory,
    /// Every slot of the window is taken.
    Concurrency,
    /// System memory pressure is critical; nothing starts until it clears.
    MemoryCritical,
}

impl From<HoldReason> for DelayReason {
    fn from(reason: HoldReason) -> Self {
        match reason {
            HoldReason::Memory => Self::Memory,
            HoldReason::WindowFull => Self::Concurrency,
            HoldReason::MemoryCritical => Self::MemoryCritical,
        }
    }
}

/// One step of [`Admitting::next`].
#[derive(Debug)]
pub enum AdmissionStep {
    /// The run waits. Reported once per change of `reason`.
    Delayed {
        reason: DelayReason,
        /// 1-based place in the machine's queue.
        position: usize,
        /// Bytes the run was admitted with as its memory need.
        need: u64,
        /// The gate's latest available-memory reading, if any.
        available: Option<u64>,
    },
    /// The run may start. The slot is released by the gate's settle rule, the
    /// run's exit (last clone dropped) or `slot_timeout`.
    Admitted(StartSlot),
}

/// The machine's admission gate. One per executor.
pub struct Admission {
    gate: Arc<AdaptiveGate>,
}

impl Admission {
    /// A gate reading `pressure` once a second while runs are queued or starting.
    pub fn new(
        config: AdmissionConfig,
        pressure: Arc<dyn PressureSource>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let adaptive =
            AdaptiveConfig::new(config.initial_window, config.max_window, config.target_cpu);
        let options = GateOptions {
            slot_timeout: config.slot_timeout,
            ..GateOptions::default()
        };
        Self {
            gate: Arc::new(AdaptiveGate::new(adaptive, options, clock, pressure)),
        }
    }

    /// Queues `run` with its memory `need` (its learned need, or
    /// [`DEFAULT_MEMORY_NEED`]). Must be called inside a tokio runtime, which
    /// runs the gate's readings and slot timeouts.
    pub fn admit(&self, run: &str, job_type: &str, need: u64) -> Admitting {
        // Subscribe before queueing so the grant pass of this enqueue counts.
        let changes = self.gate.changes();
        let ticket = self.gate.enqueue(StartRequest {
            run: run.into(),
            job_type: job_type.into(),
            order: 0,
            memory_need: need,
        });
        Admitting {
            gate: self.gate.clone(),
            run: run.into(),
            need,
            ticket: Some(ticket),
            changes,
            reported: None,
        }
    }

    /// Window, holders, queue and the latest readings.
    pub fn snapshot(&self) -> GateSnapshot {
        self.gate.snapshot()
    }
}

/// A run waiting for admission. Dropping it leaves the queue.
pub struct Admitting {
    gate: Arc<AdaptiveGate>,
    run: String,
    need: u64,
    /// `None` once admitted.
    ticket: Option<StartTicket>,
    changes: watch::Receiver<()>,
    reported: Option<DelayReason>,
}

impl Admitting {
    /// The next step: a [`AdmissionStep::Delayed`] when the reason the run
    /// waits changed, or [`AdmissionStep::Admitted`]. After `Admitted` it
    /// never completes. Cancel-safe: dropping the call keeps the place in line.
    pub async fn next(&mut self) -> AdmissionStep {
        let Some(ticket) = self.ticket.as_mut() else {
            return std::future::pending().await;
        };
        loop {
            // Mark the current state seen before reading it, so a change made
            // after the read wakes the wait below.
            self.changes.borrow_and_update();
            // Marks the reason reported even when the ticket wins below: after
            // `Admitted` no delay is reported again.
            let delay = delay(&self.gate.snapshot(), &self.run, &mut self.reported);
            tokio::select! {
                biased;
                slot = &mut *ticket => {
                    self.ticket = None;
                    return AdmissionStep::Admitted(slot);
                }
                () = std::future::ready(()), if delay.is_some() => {
                    if let Some((reason, position, available)) = delay {
                        let need = self.need;
                        return AdmissionStep::Delayed { reason, position, need, available };
                    }
                }
                // The sender lives in the gate, which this holds.
                _ = self.changes.changed() => {}
            }
        }
    }
}

/// Reason, position and available memory to report for `run`, unless the
/// reason was already reported or the gate only waits for its first memory
/// reading. `reported` is the reason last reported: a run seen without a hold
/// (or not queued) clears it, so any later hold reports again, even one with
/// the reason reported before the clear.
fn delay(
    snapshot: &GateSnapshot,
    run: &str,
    reported: &mut Option<DelayReason>,
) -> Option<(DelayReason, usize, Option<u64>)> {
    let (Some(entry), Some(hold)) = (snapshot.find(run), snapshot.hold) else {
        *reported = None;
        return None;
    };
    // A memory hold with no reading yet is the gate fetching its first one
    // (it samples at once), not memory being short: every second start of a
    // busy period passes through it. A failed read or a platform without the
    // number lets starts through, so this never hides a real hold. It counts
    // as no change, neither a report nor a clear.
    if hold == HoldReason::Memory && snapshot.available_memory.is_none() {
        return None;
    }
    let reason = DelayReason::from(hold);
    if *reported == Some(reason) {
        return None;
    }
    *reported = Some(reason);
    Some((reason, entry.position, snapshot.available_memory))
}

#[cfg(test)]
mod tests {
    use devrounds_core::gate::{GateSnapshot, HoldReason, QueuedStart, StartRequest};

    use super::{DelayReason, delay};

    fn held(hold: Option<HoldReason>) -> GateSnapshot {
        GateSnapshot {
            mode: "adaptive".into(),
            window: Some(1),
            in_flight: 1,
            queued: vec![QueuedStart {
                request: StartRequest {
                    run: "run-1".into(),
                    job_type: "check".into(),
                    order: 0,
                    memory_need: 1 << 30,
                },
                position: 1,
            }],
            hold,
            pressure: None,
            available_memory: Some(1 << 20),
            burst: None,
        }
    }

    /// The public gate never shows a queued run without a hold, so the clear
    /// is only reachable on a hand-built snapshot.
    #[test]
    fn a_cleared_hold_reports_the_same_reason_again() {
        let mut reported = None;
        let first = delay(&held(Some(HoldReason::Memory)), "run-1", &mut reported);
        assert_eq!(first.map(|d| d.0), Some(DelayReason::Memory));
        assert_eq!(
            delay(&held(Some(HoldReason::Memory)), "run-1", &mut reported),
            None
        );
        assert_eq!(delay(&held(None), "run-1", &mut reported), None);
        let again = delay(&held(Some(HoldReason::Memory)), "run-1", &mut reported);
        assert_eq!(again.map(|d| d.0), Some(DelayReason::Memory));
    }
}
