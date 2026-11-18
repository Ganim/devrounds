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
use tokio::sync::watch;

pub use devrounds_core::gate::DEFAULT_MEMORY_NEED;

/// Admission tuning; executor config `admission.*`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AdmissionConfig {
    /// Window at the start of each busy period.
    pub initial_window: usize,
    /// Largest window the AIMD controller may grow to.
    pub max_window: usize,
    /// System CPU (percent of the whole machine) below which the window grows.
    pub target_cpu: f64,
    /// A start slot is given back after this even if the run never settled or
    /// exited, so a long-starting run cannot hold the queue.
    pub slot_timeout: Duration,
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
            let delay = delay(&self.gate.snapshot(), &self.run, self.reported);
            tokio::select! {
                biased;
                slot = &mut *ticket => {
                    self.ticket = None;
                    return AdmissionStep::Admitted(slot);
                }
                () = std::future::ready(()), if delay.is_some() => {
                    if let Some((reason, position, available)) = delay {
                        self.reported = Some(reason);
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

/// Reason, position and available memory to report for `run`, unless it is
/// not queued, the reason was already reported, or the gate only waits for
/// its first memory reading.
fn delay(
    snapshot: &GateSnapshot,
    run: &str,
    reported: Option<DelayReason>,
) -> Option<(DelayReason, usize, Option<u64>)> {
    let entry = snapshot.find(run)?;
    let hold = snapshot.hold?;
    // A memory hold with no reading yet is the gate fetching its first one
    // (it samples at once), not memory being short: every second start of a
    // busy period passes through it. A failed read or a platform without the
    // number lets starts through, so this never hides a real hold.
    if hold == HoldReason::Memory && snapshot.available_memory.is_none() {
        return None;
    }
    let reason = DelayReason::from(hold);
    (reported != Some(reason)).then_some((reason, entry.position, snapshot.available_memory))
}
