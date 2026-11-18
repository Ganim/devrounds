//! The run loop: turns `Offer` and `Stop` from the control plane into runs.
//! Each offered run is one task: store it, prepare it, wait for admission,
//! spawn it, follow it until it exits, times out or is stopped, and report
//! every step as an event through the store outbox.

use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};

use devrounds_core::{
    JobSpec, LaunchSpec, StopPolicy,
    gate::{Release, StartSlot},
};
use devrounds_protocol::{FinishReason, Offer, RunEvent, ServerMessage};
use devrounds_runner_windows::{ExitReport, WindowsRunner, WindowsUnit};
use devrounds_store::{RunIdentity, Store, StoredRun};
use tokio::sync::{mpsc, watch};

use crate::{
    Sampler,
    admission::{Admission, AdmissionStep, DelayReason},
    isolation::{Isolation, NoneIsolation, PrepareError},
    output::OutputTail,
};

/// How often a running run's visible windows are counted.
const WINDOWS_EVERY: Duration = Duration::from_secs(1);

/// What the run loop needs. `machine_env` is the executor's environment, of
/// which a run gets only its job's allowlist; it is never logged.
pub struct RunLoopDeps {
    pub store: Store,
    pub admission: Arc<Admission>,
    pub runner: WindowsRunner,
    /// The connection's `connected` flag.
    pub connected: watch::Receiver<bool>,
    /// Each run writes into `<runs_dir>/<run id>`.
    pub runs_dir: PathBuf,
    pub machine_env: BTreeMap<String, String>,
}

/// Runs offered to this machine. Clones share the runs.
#[derive(Clone)]
pub struct RunLoop {
    shared: Arc<Shared>,
}

struct Shared {
    store: Store,
    admission: Arc<Admission>,
    runner: WindowsRunner,
    connected: watch::Receiver<bool>,
    runs_dir: PathBuf,
    machine_env: Arc<BTreeMap<String, String>>,
    /// Runs offered and not finished yet, each with its stop flag.
    active: Mutex<HashMap<String, watch::Sender<bool>>>,
    /// Runs with a live process.
    running: AtomicU32,
}

/// How a run ended, before it becomes `RunFinished`.
struct Ending {
    reason: FinishReason,
    exit_code: Option<i64>,
    peak: u64,
    p95: u64,
    p50: u64,
    cpu_seconds: f64,
    swept: u32,
    visible_windows: u32,
    tail: Vec<String>,
    summary: Option<String>,
}

impl Ending {
    /// A run that never got a process.
    fn before_start(reason: FinishReason, summary: Option<String>) -> Self {
        Self {
            reason,
            exit_code: None,
            peak: 0,
            p95: 0,
            p50: 0,
            cpu_seconds: 0.0,
            swept: 0,
            visible_windows: 0,
            tail: Vec::new(),
            summary,
        }
    }
}

impl RunLoop {
    pub fn new(deps: RunLoopDeps) -> Self {
        Self {
            shared: Arc::new(Shared {
                store: deps.store,
                admission: deps.admission,
                runner: deps.runner,
                connected: deps.connected,
                runs_dir: deps.runs_dir,
                machine_env: Arc::new(deps.machine_env),
                active: Mutex::new(HashMap::new()),
                running: AtomicU32::new(0),
            }),
        }
    }

    /// Runs with a live process, for `MachineReport.running`.
    pub fn running(&self) -> u32 {
        self.shared.running.load(Ordering::SeqCst)
    }

    /// Acts on one control plane message; returns at once. `Offer` starts a
    /// run task (a repeated offer of a run still active is ignored), `Stop`
    /// asks an active run to stop (an unknown run is ignored). Must be called
    /// inside a tokio runtime.
    pub fn handle(&self, message: ServerMessage) {
        match message {
            ServerMessage::Offer(offer) => {
                let mut active = self.active();
                if active.contains_key(&offer.run) {
                    tracing::warn!(run = %offer.run, "offer of a run already active ignored");
                    return;
                }
                let (stop, stopped) = watch::channel(false);
                active.insert(offer.run.clone(), stop);
                drop(active);
                tokio::spawn(run_task(Arc::clone(&self.shared), offer, stopped));
            }
            ServerMessage::Stop(stop) => match self.active().get(&stop.run) {
                Some(flag) => {
                    flag.send_replace(true);
                }
                None => tracing::debug!(run = %stop.run, "stop of a run not active ignored"),
            },
            _ => {}
        }
    }

    fn active(&self) -> std::sync::MutexGuard<'_, HashMap<String, watch::Sender<bool>>> {
        self.shared
            .active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

async fn run_task(shared: Arc<Shared>, offer: Offer, stopped: watch::Receiver<bool>) {
    let run = offer.run.clone();
    let ending = run_once(&shared, offer, stopped).await;
    let stored = emit(
        &shared.store,
        RunEvent::RunFinished {
            run: run.clone(),
            reason: ending.reason,
            exit_code: ending.exit_code,
            peak: ending.peak,
            p95: ending.p95,
            p50: ending.p50,
            cpu_seconds: ending.cpu_seconds,
            swept: ending.swept,
            visible_windows: ending.visible_windows,
            tail: ending.tail,
            summary: ending.summary,
        },
    )
    .await;
    // After RunFinished is in the outbox: a crash in between leaves the run in
    // flight for the next start to look at, never a run nobody reports. For
    // the same reason a RunFinished that was not stored keeps the run.
    if !stored {
        tracing::error!(%run, "RunFinished not stored; the run stays in the store");
    } else if let Err(error) = shared.store.forget_run(&run).await {
        tracing::warn!(%run, %error, "finished run not removed from the store");
    }
    shared
        .active
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&run);
}

/// Resolves once a stop was asked for; never if the flag's sender is gone.
async fn stop_asked(stopped: &mut watch::Receiver<bool>) {
    if stopped.wait_for(|stop| *stop).await.is_err() {
        std::future::pending::<()>().await;
    }
}

/// Appends `event`; false (logged) when the store refused it.
async fn emit(store: &Store, event: RunEvent) -> bool {
    match store.append_event(event).await {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(%error, "run event not stored");
            false
        }
    }
}

/// Run ids name directories, so only letters, digits, `-` and `_`.
fn usable_run_id(run: &str) -> bool {
    !run.is_empty()
        && run.len() <= 100
        && run
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

async fn run_once(shared: &Shared, offer: Offer, mut stopped: watch::Receiver<bool>) -> Ending {
    let Offer {
        run,
        job,
        memory_need,
        ..
    } = offer;
    if !usable_run_id(&run) {
        let summary = format!("run id {run:?} is not a usable directory name");
        return Ending::before_start(FinishReason::SpawnFailed, Some(summary));
    }
    let run_dir = shared.runs_dir.join(&run);
    let stored = StoredRun {
        run_id: run.clone(),
        job: job.clone(),
        state: "offered".to_owned(),
        identity: None,
        run_dir: run_dir.clone(),
        members: Vec::new(),
    };
    if let Err(error) = shared.store.put_run(stored).await {
        return Ending::before_start(FinishReason::Infra, Some(error.to_string()));
    }
    let spec = match prepare(shared, &run, &job, run_dir).await {
        Ok(spec) => spec,
        Err(ending) => return ending,
    };

    let Some(slot) = admit(shared, &run, &job, memory_need, &mut stopped).await else {
        return Ending::before_start(FinishReason::Stopped, None);
    };

    // Spawn only on a live session. Store::raise_floor (Task 12) detects a
    // control plane that lost its events from HelloAck.last_seq, so the
    // events of a run must not run ahead of the first HelloAck.
    let mut connected = shared.connected.clone();
    tokio::select! {
        biased;
        () = stop_asked(&mut stopped) => {
            slot.release(Release::Failed);
            return Ending::before_start(FinishReason::Stopped, None);
        }
        ready = connected.wait_for(|connected| *connected) => {
            if ready.is_err() {
                slot.release(Release::Failed);
                return Ending::before_start(FinishReason::Infra, Some("the connection ended".to_owned()));
            }
        }
    }
    emit(&shared.store, RunEvent::Admitted { run: run.clone() }).await;

    let output = spec.output.clone();
    // Not cancellation safe, so never raced against a stop: a stop asked
    // meanwhile is seen once the unit exists.
    let unit = match shared.runner.spawn_unit(spec).await {
        Ok(unit) => unit,
        Err(error) => {
            slot.release(Release::Failed);
            let summary = format!("{} could not start: {error}", job.program);
            return Ending::before_start(FinishReason::SpawnFailed, Some(summary));
        }
    };
    shared.running.fetch_add(1, Ordering::SeqCst);
    let ending = follow(shared, &run, &job, unit, slot, output, stopped).await;
    shared.running.fetch_sub(1, Ordering::SeqCst);
    ending
}

/// The run directory and the launch spec, off the async threads.
async fn prepare(
    shared: &Shared,
    run: &str,
    job: &JobSpec,
    run_dir: PathBuf,
) -> Result<LaunchSpec, Ending> {
    let env = Arc::clone(&shared.machine_env);
    let (run, job) = (run.to_owned(), job.clone());
    let prepared = tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&run_dir).map_err(|error| {
            let summary = format!("run directory {} not created: {error}", run_dir.display());
            Ending::before_start(FinishReason::Infra, Some(summary))
        })?;
        NoneIsolation.prepare(&run, &job, &run_dir, &env).map_err(
            |PrepareError::Environment { summary }| {
                Ending::before_start(FinishReason::SpawnFailed, Some(summary))
            },
        )
    })
    .await;
    prepared.unwrap_or_else(|error| {
        Err(Ending::before_start(
            FinishReason::Infra,
            Some(format!("prepare failed: {error}")),
        ))
    })
}

/// Waits for a start slot, reporting each `Delayed`. `None` when a stop came
/// first; the run then left the queue.
async fn admit(
    shared: &Shared,
    run: &str,
    job: &JobSpec,
    need: u64,
    stopped: &mut watch::Receiver<bool>,
) -> Option<StartSlot> {
    let mut admitting = shared.admission.admit(run, &job.job_type, need);
    loop {
        let step = tokio::select! {
            biased;
            () = stop_asked(stopped) => return None,
            step = admitting.next() => step,
        };
        match step {
            AdmissionStep::Admitted(slot) => return Some(slot),
            AdmissionStep::Delayed {
                reason,
                position,
                need,
                available,
            } => {
                let event = RunEvent::Delayed {
                    run: run.to_owned(),
                    reason: match reason {
                        DelayReason::Memory => devrounds_protocol::DelayReason::Memory,
                        DelayReason::Concurrency => devrounds_protocol::DelayReason::Concurrency,
                        DelayReason::MemoryCritical => {
                            devrounds_protocol::DelayReason::MemoryCritical
                        }
                    },
                    position: u32::try_from(position).unwrap_or(u32::MAX),
                    need,
                    available,
                };
                emit(&shared.store, event).await;
            }
        }
    }
}

/// From the spawned unit to its ending: identity, sampling and output, then
/// its exit, its timeout or a stop.
async fn follow(
    shared: &Shared,
    run: &str,
    job: &JobSpec,
    unit: Arc<WindowsUnit>,
    slot: StartSlot,
    output: devrounds_core::RunOutput,
    mut stopped: watch::Receiver<bool>,
) -> Ending {
    let identity = unit.run_identity();
    let stored = RunIdentity {
        pid: identity.leader.pid,
        start_time: identity.leader.start_time,
        boot_id: identity.boot_id.clone(),
    };
    if let Err(error) = shared.store.set_identity(run, stored).await {
        tracing::warn!(%run, %error, "run identity not stored");
    }
    emit(
        &shared.store,
        RunEvent::RunStarted {
            run: run.to_owned(),
            pid: identity.leader.pid,
            start_time: identity.leader.start_time,
            boot_id: identity.boot_id,
        },
    )
    .await;
    // Nothing reads the samples yet; the sampler ignores a closed channel.
    let (samples, _) = mpsc::unbounded_channel();
    let sampler = Sampler::spawn(run, Arc::clone(&unit), Some(slot), samples);
    let tail = OutputTail::spawn(run.to_owned(), output, shared.store.clone());

    let timeout = tokio::time::sleep(Duration::from_secs(job.timeout_s.into()));
    tokio::pin!(timeout);
    let mut windows = tokio::time::interval(WINDOWS_EVERY);
    let mut visible_windows = 0;
    let (reason, report) = loop {
        tokio::select! {
            biased;
            report = unit.wait_report() => break (FinishReason::Exited, report),
            () = &mut timeout => {
                break (FinishReason::Timeout, unit.stop_with_report(StopPolicy::default()).await);
            }
            () = stop_asked(&mut stopped) => {
                break (FinishReason::Stopped, unit.stop_with_report(StopPolicy::default()).await);
            }
            _ = windows.tick() => {
                if let Ok(count) = unit.visible_windows().await {
                    visible_windows = visible_windows.max(count);
                }
            }
        }
    };
    let summary = sampler.finish().await;
    let tail = tail.finish().await;
    let mut ending = Ending {
        reason,
        exit_code: None,
        peak: summary.footprint.peak,
        p95: summary.footprint.p95,
        p50: summary.footprint.p50,
        cpu_seconds: summary.cpu_seconds,
        swept: 0,
        visible_windows,
        tail,
        summary: None,
    };
    match report {
        Ok(ExitReport { outcome, swept, .. }) => {
            ending.exit_code = outcome.code.map(i64::from);
            ending.swept = u32::try_from(swept.len()).unwrap_or(u32::MAX);
        }
        Err(error) => {
            ending.reason = FinishReason::Infra;
            ending.summary = Some(format!("the run's exit could not be read: {error}"));
        }
    }
    ending
}
