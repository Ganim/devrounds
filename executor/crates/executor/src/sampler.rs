//! Samples one run's job: footprint (private bytes of every member) and CPU,
//! every second while the run holds its start slot, every 5 s after. Each
//! sample feeds the slot (so the gate can lower the run's reservation and
//! apply its settle rule), the run's summary and the caller's channel.

use std::{
    sync::Arc,
    time::{Duration, SystemTime},
};

use devrounds_core::gate::StartSlot;
use devrounds_metrics::{RunSample, RunSummary, RunTracker, Sample, Subject, unix_ms};
use devrounds_metrics_windows::WindowsSource;
use devrounds_runner_windows::WindowsUnit;
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

/// Sampling period while the run holds an unreleased start slot: the gate
/// decides on these readings.
pub const SLOT_INTERVAL: Duration = Duration::from_secs(1);
/// Sampling period otherwise.
pub const IDLE_INTERVAL: Duration = Duration::from_secs(5);

/// The sampling task of one run. Dropping it stops sampling; [`Sampler::finish`]
/// also returns the run's summary.
#[derive(Debug)]
pub struct Sampler {
    run: String,
    unit: Arc<WindowsUnit>,
    started_ms: u64,
    stop: oneshot::Sender<()>,
    task: JoinHandle<RunTracker>,
}

impl Sampler {
    /// Starts sampling `unit` as run `run` right away. While `slot` is held
    /// and unreleased, every sample reports the footprint and (from the
    /// second sample on, the first CPU reading being 0 by design) the CPU to
    /// it. Each sample is also sent on `tx`; a closed channel is ignored.
    /// The sampler keeps a clone of `slot`, so the slot outlives the caller's
    /// copy until sampling stops. Readings with no live member are skipped.
    pub fn spawn(
        run: impl Into<String>,
        unit: Arc<WindowsUnit>,
        slot: Option<StartSlot>,
        tx: mpsc::UnboundedSender<Sample>,
    ) -> Self {
        let run = run.into();
        let started_ms = unix_ms(SystemTime::now());
        let mut tracker = RunTracker::default();
        tracker.start(run.clone(), started_ms);
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(sample_loop(
            run.clone(),
            Arc::clone(&unit),
            slot,
            tx,
            stopped,
            tracker,
        ));
        Self {
            run,
            unit,
            started_ms,
            stop,
            task,
        }
    }

    /// Stops sampling and returns the run's summary, its footprint peak
    /// raised to the job's exact peak. Call it once the run has exited, so
    /// the peak covers the whole run.
    pub async fn finish(self) -> RunSummary {
        // The task may have ended already; then the send has no receiver.
        let _ = self.stop.send(());
        let mut tracker = match self.task.await {
            Ok(tracker) => tracker,
            Err(error) => {
                tracing::warn!(run = %self.run, %error, "sampler task failed");
                let mut tracker = RunTracker::default();
                tracker.start(self.run.clone(), self.started_ms);
                tracker
            }
        };
        let job_peak = self.unit.peak_memory().await.unwrap_or_else(|error| {
            tracing::debug!(run = %self.run, %error, "job peak unreadable");
            0
        });
        tracker
            .finish(&self.run, unix_ms(SystemTime::now()), job_peak)
            .expect("the sampler tracks its own run")
    }
}

/// Samples until `stopped` fires or its sender is dropped; returns the
/// tracker with every sample taken.
async fn sample_loop(
    run: String,
    unit: Arc<WindowsUnit>,
    slot: Option<StartSlot>,
    tx: mpsc::UnboundedSender<Sample>,
    mut stopped: oneshot::Receiver<()>,
    mut tracker: RunTracker,
) -> RunTracker {
    // One source per run: its CPU cache holds only this run's members.
    let source = WindowsSource::new();
    let mut first = true;
    loop {
        if let Some(reading) = read(&source, &unit).await {
            if let Some(slot) = held(&slot) {
                slot.report_memory(reading.footprint_bytes);
                // Every member reads 0 CPU on first sight, which must not
                // count toward the settle rule.
                if !first {
                    slot.report_cpu(reading.cpu_percent);
                }
            }
            first = false;
            let sample = Sample {
                subject: Subject::Run { run: run.clone() },
                cpu_percent: reading.cpu_percent,
                footprint_bytes: reading.footprint_bytes,
                rss_bytes: reading.rss_bytes,
                ts_ms: unix_ms(SystemTime::now()),
            };
            tracker.observe(&sample);
            // Nobody listening is fine: the summary still has the sample.
            let _ = tx.send(sample);
        }
        let period = if held(&slot).is_some() {
            SLOT_INTERVAL
        } else {
            IDLE_INTERVAL
        };
        tokio::select! {
            _ = &mut stopped => return tracker,
            () = tokio::time::sleep(period) => {}
        }
    }
}

/// The slot while it is still held.
fn held(slot: &Option<StartSlot>) -> Option<&StartSlot> {
    slot.as_ref().filter(|slot| slot.released().is_none())
}

/// Reads the run's current members; `None` when none is alive or they
/// cannot be read.
async fn read(source: &WindowsSource, unit: &WindowsUnit) -> Option<RunSample> {
    let members = match unit.job_members().await {
        Ok(members) => members,
        Err(error) => {
            tracing::debug!(%error, "run members unreadable");
            return None;
        }
    };
    if members.is_empty() {
        return None;
    }
    let source = source.clone();
    match tokio::task::spawn_blocking(move || source.sample_run(&members)).await {
        Ok(reading) => Some(reading),
        Err(error) => {
            tracing::debug!(%error, "run sample failed");
            None
        }
    }
}
