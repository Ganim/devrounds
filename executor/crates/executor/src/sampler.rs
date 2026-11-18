//! Samples one run's job: footprint (private bytes of every member) and CPU,
//! every second while the run holds its start slot, every 5 s after. Each
//! sample feeds the slot (so the gate can lower the run's reservation and
//! apply its settle rule), the run's summary and the caller's channel; the
//! run loop's sampler also records the members in the store. Sampling ends
//! on its own when the run exits.

use std::{
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};

use devrounds_core::{ProcessIdentity, gate::StartSlot};
use devrounds_metrics::{JobTotals, RunSample, RunSummary, RunTracker, Sample, Subject, unix_ms};
use devrounds_metrics_windows::WindowsSource;
use devrounds_runner_windows::WindowsUnit;
use devrounds_store::Store;
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

/// Sampling period while the run holds an unreleased start slot: the gate
/// decides on these readings.
pub const SLOT_INTERVAL: Duration = Duration::from_secs(1);
/// Sampling period otherwise.
pub const IDLE_INTERVAL: Duration = Duration::from_secs(5);
/// How often changed members are written to the store.
pub const MEMBERS_EVERY: Duration = Duration::from_secs(5);

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
    /// Readings with no live member are skipped.
    ///
    /// The task ends by itself once the unit has fully finished (its exit
    /// report is out): it then drops its `slot` clone, so a run that exits
    /// while holding its slot does not keep it, and drops `tx`, which tells
    /// a listener that sampling is over. [`Sampler::finish`] still returns
    /// the summary afterwards.
    pub fn spawn(
        run: impl Into<String>,
        unit: Arc<WindowsUnit>,
        slot: Option<StartSlot>,
        tx: mpsc::UnboundedSender<Sample>,
    ) -> Self {
        Self::spawn_inner(run.into(), unit, slot, tx, None)
    }

    /// [`Sampler::spawn`] that also keeps the run's members in `store`
    /// ([`Store::record_members`]): on the first reading, then every
    /// [`MEMBERS_EVERY`] when they changed. A restarted executor stops an
    /// orphaned run from these, since its job cannot be reopened.
    pub fn spawn_recording(
        run: impl Into<String>,
        unit: Arc<WindowsUnit>,
        slot: Option<StartSlot>,
        tx: mpsc::UnboundedSender<Sample>,
        store: Store,
    ) -> Self {
        Self::spawn_inner(run.into(), unit, slot, tx, Some(store))
    }

    fn spawn_inner(
        run: String,
        unit: Arc<WindowsUnit>,
        slot: Option<StartSlot>,
        tx: mpsc::UnboundedSender<Sample>,
        store: Option<Store>,
    ) -> Self {
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
            store,
        ));
        Self {
            run,
            unit,
            started_ms,
            stop,
            task,
        }
    }

    /// Stops sampling (if the run has not ended it already) and returns the
    /// run's summary: its footprint peak raised to the job's exact peak, and
    /// the job's exact CPU time. Call it once the run has exited, so both
    /// cover the whole run.
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
        let peak_bytes = self.unit.peak_memory().await.unwrap_or_else(|error| {
            tracing::warn!(run = %self.run, %error, "job peak unreadable; the sampled peak stands");
            0
        });
        let cpu_seconds = match self.unit.cpu_time().await {
            Ok(cpu) => cpu.as_secs_f64(),
            Err(error) => {
                tracing::warn!(run = %self.run, %error, "job CPU time unreadable");
                0.0
            }
        };
        let job = JobTotals {
            peak_bytes,
            cpu_seconds,
        };
        tracker
            .finish(&self.run, unix_ms(SystemTime::now()), job)
            .expect("the sampler tracks its own run")
    }
}

/// Samples until the unit has finished, `stopped` fires or its sender is
/// dropped; returns the tracker with every sample taken. Returning drops
/// `slot` and `tx`.
async fn sample_loop(
    run: String,
    unit: Arc<WindowsUnit>,
    slot: Option<StartSlot>,
    tx: mpsc::UnboundedSender<Sample>,
    mut stopped: oneshot::Receiver<()>,
    mut tracker: RunTracker,
    store: Option<Store>,
) -> RunTracker {
    // One source per run: its CPU cache holds only this run's members.
    let source = WindowsSource::new();
    let mut first = true;
    let mut recorded: Option<(Instant, Vec<ProcessIdentity>)> = None;
    loop {
        if let Some((reading, members)) = read(&run, &source, &unit).await {
            if let Some(store) = &store {
                let due = recorded
                    .as_ref()
                    .is_none_or(|(at, known)| at.elapsed() >= MEMBERS_EVERY && *known != members);
                if due {
                    if let Err(error) = store.record_members(&run, members.clone()).await {
                        tracing::warn!(%run, %error, "run members not recorded");
                    }
                    recorded = Some((Instant::now(), members));
                }
            }
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
            // An error means the supervisor is gone, which ends the run too.
            _ = unit.wait_report() => return tracker,
            () = tokio::time::sleep(period) => {}
        }
    }
}

/// The slot while it is still held.
fn held(slot: &Option<StartSlot>) -> Option<&StartSlot> {
    slot.as_ref().filter(|slot| slot.released().is_none())
}

/// Reads the run's current members, with the identities read; `None` when
/// none is alive or they cannot be read.
async fn read(
    run: &str,
    source: &WindowsSource,
    unit: &WindowsUnit,
) -> Option<(RunSample, Vec<ProcessIdentity>)> {
    let members = match unit.job_members().await {
        Ok(members) => members,
        Err(error) => {
            tracing::warn!(run, %error, "run members unreadable; sample skipped");
            return None;
        }
    };
    if members.is_empty() {
        return None;
    }
    let source = source.clone();
    match tokio::task::spawn_blocking(move || {
        source
            .sample_run(&members)
            .map(|reading| (reading, members))
    })
    .await
    {
        Ok(reading) => reading,
        Err(error) => {
            tracing::warn!(run, %error, "run sample failed");
            None
        }
    }
}
