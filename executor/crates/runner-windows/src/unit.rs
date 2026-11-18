//! Unit handle and the per-unit supervisor task that waits for, tracks and
//! stops it.

use std::{
    fmt, io,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use devrounds_core::{
    Error, ExitOutcome, LaunchSpec, ProcessIdentity, ProcessInfo, RunIdentity, StopPolicy,
    StopSignal, Unit, WindowsStop,
};
use devrounds_sys_windows::{
    console::CtrlEvent,
    job::Job,
    proc::{self, Held, ProcessEntry},
    spawn::Child,
    window::{self, close_windows},
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task,
    time::{self, Instant, MissedTickBehavior},
};

use crate::{
    ConsoleHelper, WindowsRunner,
    exit::{self, Leader},
    runtime::Runtimes,
    spawn::{self, is_console_host},
    stop::{Ask, StopPlan},
};

/// Poll period while waiting for members to exit after the leader.
const EXIT_POLL: Duration = Duration::from_millis(50);
/// Poll period while waiting for a terminated job to empty.
const SWEEP_POLL: Duration = Duration::from_millis(25);
/// Exit code of processes the runner ends by terminating the job.
const TERMINATED: u32 = 1;

/// Everything known about a finished unit. Shared by all waiters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitReport {
    /// The leader's exit, decoded as on Unix: signal 9 when the runner
    /// terminated the job before the leader exited, signal 2 for a leader a
    /// console event ended (`STATUS_CONTROL_C_EXIT`), signal `s` for an MSYS
    /// leader that reports `s << 8`, otherwise the code. Both `None` when the
    /// code could not be read.
    pub outcome: ExitOutcome,
    /// Present when an explicit stop ended the unit.
    pub stop: Option<StopOutcome>,
    /// Members still running after the leader's exit and its grace (the
    /// stop's, or [`WindowsRunner::exit_grace`]) that the final sweep ended.
    pub swept: Vec<ProcessInfo>,
    /// Processes still running after the sweep's timeout.
    pub escaped: Vec<ProcessInfo>,
}

/// How an explicit stop ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopOutcome {
    /// The first requested stop signal.
    pub signal: StopSignal,
    /// The job was terminated because the timeout elapsed first.
    pub escalated: bool,
}

/// Concrete unit handle. Clones of the `Arc` share one supervisor; dropping
/// every handle leaves the processes running until they exit on their own.
pub struct WindowsUnit {
    inner: Arc<Inner>,
}

/// State shared between handles and the supervisor task.
struct Inner {
    identity: ProcessIdentity,
    /// The boot the unit started in, read once at spawn.
    boot_id: String,
    /// What the leader is, which decides how its exit code reads.
    leader_kind: Leader,
    /// The runner terminated the job while the leader still ran.
    terminated: AtomicBool,
    /// Which programs link the MSYS runtime, shared with the runner.
    runtimes: Runtimes,
    job: Job,
    /// Held so the leader's PID stays its own until the unit is dropped.
    leader: Arc<Child>,
    /// Live members other than the console host, as of the last refresh.
    members: Mutex<Vec<ProcessInfo>>,
    /// Members seen at a refresh that had not exited then, each held open:
    /// a terminated process leaves the job's list and count a moment before
    /// it has fully exited, and only its handle tells when it has.
    held: Mutex<Vec<(ProcessInfo, Held)>>,
    leader_exited: AtomicBool,
    /// Set when the supervisor ended without publishing a real report.
    crashed: AtomicBool,
    stops: mpsc::UnboundedSender<StopRequest>,
    exit: watch::Sender<Option<ExitReport>>,
    timing: Timing,
    helper: Option<ConsoleHelper>,
}

/// Supervisor tuning copied from the runner.
#[derive(Debug, Clone, Copy)]
struct Timing {
    track_interval: Duration,
    exit_grace: Duration,
    sweep_timeout: Duration,
}

impl Timing {
    /// Upper bound for a stop beyond its policy timeout: the sweep and slack
    /// for a loaded machine.
    fn stop_margin(&self) -> Duration {
        self.sweep_timeout + Duration::from_secs(5)
    }
}

/// A stop request sent to the supervisor.
#[derive(Debug, Clone, Copy)]
struct StopRequest {
    signal: StopSignal,
    timeout: Duration,
}

/// Stop progress owned by the supervisor.
#[derive(Debug, Clone, Copy)]
struct Stopping {
    signal: StopSignal,
    deadline: Instant,
    escalated: bool,
}

/// Result of the final sweep.
#[derive(Debug, Default)]
struct Sweep {
    swept: Vec<ProcessInfo>,
    escaped: Vec<ProcessInfo>,
}

/// Launches the leader, starts its waiter, then its supervisor.
pub(crate) async fn spawn(
    runner: &WindowsRunner,
    spec: LaunchSpec,
) -> Result<Arc<WindowsUnit>, Error> {
    let shell = runner.shell.clone();
    let runtimes = runner.runtimes.clone();
    let (boot_id, launched) = blocking(move || {
        // Read first: a failure here must not leave an untracked leader.
        let boot_id = proc::boot_id()?;
        let launched = spawn::launch(spec, shell.as_deref(), &runtimes)?;
        Ok::<_, Error>((boot_id, launched))
    })
    .await??;
    let identity = ProcessIdentity {
        pid: launched.child.pid(),
        sid: 0,
        start_time: launched.child.start_time(),
    };
    let leader = Arc::new(launched.child);
    let (exit_tx, exit_rx) = oneshot::channel();
    let waiting = Arc::clone(&leader);
    let started = std::thread::Builder::new()
        .name("unit-wait".into())
        .spawn(move || {
            let _ = exit_tx.send(waiting.wait());
        });
    if let Err(error) = started {
        // Nothing would see it exit.
        let _ = launched.job.terminate(TERMINATED);
        return Err(error.into());
    }

    let (stops, requests) = mpsc::unbounded_channel();
    let inner = Arc::new(Inner {
        identity,
        boot_id,
        leader_kind: launched.leader_kind,
        terminated: AtomicBool::new(false),
        runtimes: runner.runtimes.clone(),
        job: launched.job,
        leader,
        members: Mutex::new(Vec::new()),
        held: Mutex::new(Vec::new()),
        leader_exited: AtomicBool::new(false),
        crashed: AtomicBool::new(false),
        stops,
        exit: watch::channel(None).0,
        timing: Timing {
            track_interval: runner.track_interval,
            exit_grace: runner.exit_grace,
            sweep_timeout: runner.sweep_timeout,
        },
        helper: runner.helper.clone(),
    });
    // The guard is an argument, not a local, so it is dropped (and publishes) even if
    // the task is cancelled before its first poll.
    let publish = PublishOnDrop(Arc::clone(&inner));
    tokio::spawn(supervise(Arc::clone(&inner), publish, requests, exit_rx));
    Ok(Arc::new(WindowsUnit { inner }))
}

/// Owns the unit lifecycle: the leader's exit, membership refreshes, stop
/// escalation, the grace for members outliving the leader and the final
/// sweep. Stops run here so a cancelled `stop()` caller cannot abandon an
/// escalation halfway.
async fn supervise(
    inner: Arc<Inner>,
    _publish: PublishOnDrop,
    mut requests: mpsc::UnboundedReceiver<StopRequest>,
    mut exited: oneshot::Receiver<io::Result<u32>>,
) {
    let timing = inner.timing;
    let mut tick = time::interval(timing.track_interval);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut stopping: Option<Stopping> = None;

    let code = loop {
        let deadline = stopping.filter(|s| !s.escalated).map(|s| s.deadline);
        tokio::select! {
            result = &mut exited => break exit_code(result),
            _ = tick.tick() => {
                inner.track().await;
            }
            Some(request) = requests.recv() => inner.request_stop(&mut stopping, request),
            () = until(deadline) => {
                inner.terminate_job();
                if let Some(current) = &mut stopping {
                    current.escalated = true;
                }
            }
        }
    };
    inner.leader_exited.store(true, Ordering::Release);

    // The run ended with its leader. Members that outlive it get the rest of
    // a stop's grace period, or the exit grace; a stop requested meanwhile
    // can only shorten it. At the deadline a stop escalates, and without one
    // the sweep below ends them. The console host stays until its last
    // client is gone and is not waited for.
    let mut deadline = stopping.map_or(Instant::now() + timing.exit_grace, |s| s.deadline);
    while !stopping.is_some_and(|s| s.escalated) && !inner.live_members().await.is_empty() {
        if Instant::now() >= deadline {
            if let Some(current) = &mut stopping {
                inner.terminate_job();
                current.escalated = true;
            }
            break;
        }
        tokio::select! {
            () = time::sleep(EXIT_POLL) => {}
            Some(request) = requests.recv() => {
                inner.request_stop(&mut stopping, request);
                deadline = deadline.min(stopping.map_or(deadline, |s| s.deadline));
            }
        }
    }
    let sweep = inner.sweep().await;
    let stop = stopping.map(|s| StopOutcome {
        signal: s.signal,
        escalated: s.escalated,
    });
    let outcome = inner.outcome(code);
    if code.is_some_and(|code| outcome.code != Some(code.cast_signed())) {
        tracing::debug!(
            pid = inner.identity.pid,
            code,
            ?outcome,
            "leader exit decoded"
        );
    }
    inner.finish(ExitReport {
        outcome,
        stop,
        swept: sweep.swept,
        escaped: sweep.escaped,
    });
}

/// The leader's exit code from the waiter thread, `None` when it was lost.
fn exit_code(result: Result<io::Result<u32>, oneshot::error::RecvError>) -> Option<u32> {
    match result {
        Ok(Ok(code)) => Some(code),
        Ok(Err(error)) => {
            tracing::warn!(%error, "waiting for a unit leader failed");
            None
        }
        Err(_) => None,
    }
}

/// Publishes a status-less report if the supervisor ends early (panic or runtime
/// shutdown), so waiters on other runtimes are not left hanging, and marks the unit
/// so a later stop terminates its job directly.
struct PublishOnDrop(Arc<Inner>);

impl Drop for PublishOnDrop {
    fn drop(&mut self) {
        if self.0.exit.borrow().is_none() {
            self.0.crashed.store(true, Ordering::SeqCst);
            self.0.finish(ExitReport {
                outcome: self.0.leader_outcome(),
                stop: None,
                swept: Vec::new(),
                escaped: Vec::new(),
            });
        }
    }
}

/// Sleeps until `deadline`, or forever when there is none.
async fn until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// Runs blocking Win32 work off the async executor.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Error> {
    task::spawn_blocking(work)
        .await
        .map_err(|error| Error::Integration(format!("blocking task failed: {error}")))
}

/// Locks a std mutex, ignoring poisoning: the guarded data stays consistent per call.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A job member as a process-table entry; Windows has no sessions.
fn info(entry: ProcessEntry) -> ProcessInfo {
    ProcessInfo {
        pid: entry.pid,
        ppid: entry.ppid,
        sid: None,
        start_time: entry.start_time,
        zombie: entry.exited,
        name: entry.name,
    }
}

impl Inner {
    /// Live members other than the console host, read from the job now, and
    /// remembered for [`Unit::subjects`]. Members seen before that have not
    /// fully exited count too, through their held handles. Blocking.
    fn refresh_blocking(&self) -> Result<Vec<ProcessInfo>, Error> {
        let entries = self.job.processes()?;
        let mut held = lock(&self.held);
        held.retain(|(_, handle)| !handle.exited());
        let mut unheld = Vec::new();
        for entry in entries {
            if entry.exited
                || is_console_host(&entry.name)
                || held
                    .iter()
                    .any(|(p, _)| p.pid == entry.pid && p.start_time == entry.start_time)
            {
                continue;
            }
            // One that refuses to be held (or exited just now) is listed while
            // the job lists it.
            match Held::open(entry.pid, entry.start_time) {
                Ok(Some(handle)) => held.push((info(entry), handle)),
                Ok(None) | Err(_) => unheld.push(info(entry)),
            }
        }
        let live: Vec<ProcessInfo> = held.iter().map(|(p, _)| p.clone()).chain(unheld).collect();
        drop(held);
        lock(&self.members).clone_from(&live);
        Ok(live)
    }

    /// See [`WindowsUnit::visible_windows`]. Blocking.
    fn visible_windows_blocking(&self) -> Result<u32, Error> {
        // `None`: the member exited since the job was read, so it owns no
        // window. A failed open is an error, never a member to skip.
        let mut members = Vec::new();
        for p in self.job.processes()? {
            if let Some(held) = Held::open(p.pid, p.start_time)? {
                members.push(held);
            }
        }
        let count = window::visible_windows()
            .iter()
            .filter(|w| members.iter().any(|m| m.pid() == w.pid))
            .count();
        Ok(u32::try_from(count).unwrap_or(u32::MAX))
    }

    /// [`Inner::refresh_blocking`] for supervisor paths, where a failed read
    /// must not abort cleanup: the last known members stand in.
    async fn live_members(self: &Arc<Self>) -> Vec<ProcessInfo> {
        let inner = Arc::clone(self);
        match blocking(move || inner.refresh_blocking()).await {
            Ok(Ok(live)) => live,
            Ok(Err(error)) | Err(error) => {
                tracing::warn!(%error, pid = self.identity.pid, "reading the unit's job failed");
                lock(&self.members).clone()
            }
        }
    }

    /// The supervisor's periodic refresh of the members.
    async fn track(self: &Arc<Self>) {
        let inner = Arc::clone(self);
        let tracked = blocking(move || inner.refresh_blocking().map(drop)).await;
        if let Ok(Err(error)) | Err(error) = tracked {
            tracing::warn!(%error, pid = self.identity.pid, "reading the unit's job failed");
        }
    }

    /// Handles a stop request: the first one begins the stop; a repeated stop
    /// can only shorten the grace period and sends no second event.
    fn request_stop(self: &Arc<Self>, stopping: &mut Option<Stopping>, request: StopRequest) {
        let deadline = Instant::now() + request.timeout;
        match stopping {
            Some(current) => current.deadline = current.deadline.min(deadline),
            None => {
                self.begin_stop(request.signal, deadline);
                *stopping = Some(Stopping {
                    signal: request.signal,
                    deadline,
                    escalated: false,
                });
            }
        }
    }

    /// Starts a stop: terminates the job for SIGKILL, otherwise asks politely
    /// in the background so the supervisor keeps watching the deadline. The
    /// background task reads the job once and sends one console event as its
    /// [`StopPlan`] says.
    fn begin_stop(self: &Arc<Self>, signal: StopSignal, deadline: Instant) {
        if signal.windows_stop() == WindowsStop::Terminate {
            self.terminate_job();
            return;
        }
        let deadline = deadline.into_std();
        let inner = Arc::clone(self);
        tokio::spawn(async move {
            let planning = Arc::clone(&inner);
            let plan = match blocking(move || planning.plan_stop(signal)).await {
                Ok(Ok(plan)) => plan,
                Ok(Err(error)) | Err(error) => {
                    tracing::warn!(%error, pid = inner.identity.pid, "reading the unit's job failed");
                    return;
                }
            };
            let event = match plan.ask {
                Ask::Terminate => {
                    inner.terminate_job();
                    return;
                }
                Ask::Event(event) => Some(event),
            };
            let _ = blocking(move || inner.ask_to_close(plan.targets, event, deadline)).await;
        });
    }

    /// Reads the job once and plans the stop for `signal` from its members.
    /// Blocking.
    fn plan_stop(&self, signal: StopSignal) -> Result<StopPlan, Error> {
        Ok(StopPlan::new(signal, self.job.processes()?, &self.runtimes))
    }

    /// Posts `WM_CLOSE` to the visible windows of `live`, the stop plan's
    /// targets, and sends `event`, if any, once to the unit's console, through
    /// the leader while it runs, else through another of them. Waits for the
    /// helper until `deadline`. Blocking.
    fn ask_to_close(
        &self,
        live: Vec<ProcessEntry>,
        event: Option<CtrlEvent>,
        deadline: std::time::Instant,
    ) {
        let targets: Vec<(u32, u64)> = live.iter().map(|p| (p.pid, p.start_time)).collect();
        match close_windows(&targets) {
            Ok(0) => {}
            Ok(closed) => {
                tracing::debug!(closed, pid = self.identity.pid, "asked windows to close")
            }
            Err(error) => tracing::debug!(%error, "closing windows failed"),
        }
        let (Some(event), Some(helper)) = (event, &self.helper) else {
            return;
        };
        let is_leader = |p: &&ProcessEntry| {
            p.pid == self.identity.pid && p.start_time == self.identity.start_time
        };
        let held = live
            .iter()
            .filter(is_leader)
            .chain(live.iter().filter(|p| !is_leader(p)))
            .find_map(|p| Held::open(p.pid, p.start_time).ok().flatten());
        let Some(target) = held else {
            tracing::debug!(
                pid = self.identity.pid,
                "no live process to send a console event to"
            );
            return;
        };
        match helper.send(&target, event, deadline) {
            Ok(()) => {
                tracing::debug!(?event, pid = target.pid(), "console event sent");
            }
            Err(error) => {
                tracing::warn!(%error, ?event, pid = target.pid(), "console event not sent")
            }
        }
    }

    /// Ends every process in the job, the console host included. Records it
    /// when the leader still ran, so its exit reads as SIGKILL; checked on
    /// the leader's own handle, since the waiter thread reports an exit a
    /// moment late.
    fn terminate_job(&self) {
        if matches!(self.leader.exit_code(), Ok(None)) {
            self.terminated.store(true, Ordering::Release);
        }
        if let Err(error) = self.job.terminate(TERMINATED) {
            tracing::warn!(%error, pid = self.identity.pid, "terminating the unit's job failed");
        }
    }

    /// [`Inner::sweep_blocking`] off the executor.
    async fn sweep(self: &Arc<Self>) -> Sweep {
        let inner = Arc::clone(self);
        blocking(move || inner.sweep_blocking())
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(%error, pid = self.identity.pid, "sweeping the unit's job failed");
                self.terminate_job();
                Sweep::default()
            })
    }

    /// Terminates the job and waits until every member that was running has
    /// exited and the job is empty, or the sweep times out. Members running
    /// before are `swept`; any still running at the timeout `escaped`.
    /// Blocking.
    fn sweep_blocking(&self) -> Sweep {
        if let Err(error) = self.refresh_blocking() {
            tracing::warn!(%error, pid = self.identity.pid, "reading the unit's job failed");
        }
        let held = std::mem::take(&mut *lock(&self.held));
        self.terminate_job();
        let deadline = std::time::Instant::now() + self.timing.sweep_timeout;
        let remaining = || deadline.saturating_duration_since(std::time::Instant::now());
        let mut sweep = Sweep::default();
        for (process, handle) in held {
            if handle.wait(remaining()).unwrap_or(false) {
                sweep.swept.push(process);
            } else {
                sweep.escaped.push(process);
            }
        }
        // Members that started after the list was read.
        while !matches!(self.job.active_count(), Ok(0)) && !remaining().is_zero() {
            std::thread::sleep(SWEEP_POLL);
        }
        sweep
    }

    /// The leader's outcome without waiting, once it exited.
    fn leader_outcome(&self) -> ExitOutcome {
        self.outcome(self.leader.exit_code().ok().flatten())
    }

    /// The outcome of a leader that exited with `code`; see [`exit::outcome`].
    fn outcome(&self, code: Option<u32>) -> ExitOutcome {
        exit::outcome(
            code,
            self.leader_kind,
            self.terminated.load(Ordering::Acquire),
        )
    }

    /// Publishes the report and forgets the members.
    fn finish(&self, report: ExitReport) {
        lock(&self.members).clear();
        lock(&self.held).clear();
        self.exit.send_replace(Some(report));
    }
}

impl WindowsUnit {
    /// Leader identity recorded at spawn; persist it for reconciliation. `sid`
    /// is 0: Windows has no sessions.
    pub fn identity(&self) -> ProcessIdentity {
        self.inner.identity
    }

    /// The leader's identity and the boot it started in; persist it to find
    /// the run again after an executor restart.
    pub fn run_identity(&self) -> RunIdentity {
        RunIdentity {
            leader: self.inner.identity,
            boot_id: self.inner.boot_id.clone(),
        }
    }

    /// Reads the job and returns its live processes, the leader included while
    /// it runs and the console host left out.
    pub async fn processes(&self) -> Result<Vec<ProcessInfo>, Error> {
        let inner = Arc::clone(&self.inner);
        blocking(move || inner.refresh_blocking()).await?
    }

    /// [`WindowsUnit::processes`] as identities: every live job member with
    /// its start time, read from the job now.
    pub async fn job_members(&self) -> Result<Vec<ProcessIdentity>, Error> {
        Ok(self
            .processes()
            .await?
            .iter()
            .map(ProcessInfo::identity)
            .collect())
    }

    /// How many visible top-level windows the run's processes own now: every
    /// job member, the console host included, held while the windows are
    /// read so a reused PID is never counted. A console window counts for one
    /// of its client processes. Runs are started hidden, so this is 0 unless
    /// a member opened a window itself.
    pub async fn visible_windows(&self) -> Result<u32, Error> {
        let inner = Arc::clone(&self.inner);
        blocking(move || inner.visible_windows_blocking()).await?
    }

    /// The most memory the run's processes ever committed at once, read from
    /// its job; exact where samples can miss a short spike, and still
    /// readable after the run exited.
    pub async fn peak_memory(&self) -> Result<u64, Error> {
        let inner = Arc::clone(&self.inner);
        Ok(blocking(move || inner.job.peak_memory()).await??)
    }

    /// Ends every process of the unit at once by terminating its job, without
    /// waiting; the supervisor then reports the exit as usual.
    pub fn terminate(&self) {
        self.inner.terminate_job();
    }

    /// Returns the report once the unit has fully finished, without waiting.
    pub fn exit_report(&self) -> Option<ExitReport> {
        self.inner.exit.borrow().clone()
    }

    /// Waits for the leader's exit, the grace for members outliving it and
    /// the final sweep.
    pub async fn wait_report(&self) -> Result<ExitReport, Error> {
        let mut exit = self.inner.exit.subscribe();
        let report = exit
            .wait_for(Option::is_some)
            .await
            .map_err(|_| Error::Integration("unit supervisor vanished".into()))?;
        report
            .clone()
            .ok_or_else(|| Error::Integration("unit report missing".into()))
    }

    /// Stops the unit and returns its report, including escalation.
    ///
    /// SIGKILL terminates the job. Every other signal posts `WM_CLOSE` to the
    /// unit's visible windows and asks once, as the stop's [`StopPlan`] says:
    /// SIGINT and SIGTERM type the Ctrl-C key into a pseudo console, and
    /// without one send a Ctrl-C event, or Ctrl-Break while an MSYS program
    /// runs in the unit; the other signals send Ctrl-Break. Once only the
    /// console host is left, or at `policy.timeout`, the job is terminated. A repeated
    /// stop only shortens the timeout. Cancelling this future does not cancel
    /// the stop. Stopping an exited unit returns its existing report. If the
    /// supervisor task died, the job is terminated directly instead.
    pub async fn stop_with_report(&self, policy: StopPolicy) -> Result<ExitReport, Error> {
        let request = StopRequest {
            signal: policy.signal,
            timeout: policy.timeout,
        };
        // A closed channel means the supervisor ended; only a crash leaves work undone.
        if self.inner.stops.send(request).is_err() && self.inner.crashed.load(Ordering::SeqCst) {
            return self.terminate_and_settle(policy.signal).await;
        }
        let bound = policy
            .timeout
            .saturating_add(self.inner.timing.stop_margin());
        match time::timeout(bound, self.wait_report()).await {
            Ok(report) => report,
            Err(_) => self.terminate_and_settle(policy.signal).await,
        }
    }

    /// For a stop the supervisor cannot finish (it died, or its report is
    /// overdue): terminates the job, waits for the leader and publishes a
    /// report unless a real one exists. A leader still running is an error.
    async fn terminate_and_settle(&self, signal: StopSignal) -> Result<ExitReport, Error> {
        tracing::warn!(
            pid = self.inner.identity.pid,
            "unit supervisor did not finish the stop; terminating its job"
        );
        self.inner.terminate_job();
        let leader = Arc::clone(&self.inner.leader);
        let wait = self.inner.timing.sweep_timeout;
        let code = blocking(move || leader.wait_timeout(wait)).await??;
        let Some(code) = code else {
            return Err(Error::Integration(format!(
                "unit {} still running after stop",
                self.inner.identity.pid
            )));
        };
        let report = ExitReport {
            outcome: self.inner.outcome(Some(code)),
            stop: Some(StopOutcome {
                signal,
                escalated: signal != StopSignal::Kill,
            }),
            swept: Vec::new(),
            escaped: Vec::new(),
        };
        // The crash report is itself a placeholder; anything else is real.
        let crashed = self.inner.crashed.load(Ordering::SeqCst);
        self.inner.exit.send_if_modified(|exit| {
            if exit.is_some() && !crashed {
                return false;
            }
            *exit = Some(report);
            true
        });
        self.wait_report().await
    }
}

impl fmt::Debug for WindowsUnit {
    /// Shows identity and state only; the spec and environment are never retained.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WindowsUnit")
            .field("identity", &self.inner.identity)
            .field("exited", &self.inner.exit.borrow().is_some())
            .finish()
    }
}

#[async_trait]
impl Unit for WindowsUnit {
    /// See [`WindowsUnit::stop_with_report`].
    async fn stop(&self, policy: StopPolicy) -> Result<(), Error> {
        self.stop_with_report(policy).await.map(|_| ())
    }

    /// See [`WindowsUnit::wait_report`].
    async fn wait(&self) -> Result<ExitOutcome, Error> {
        Ok(self.wait_report().await?.outcome)
    }

    /// Live members as of the supervisor's last refresh. Never reads the job, so
    /// frequent callers such as the metrics sampler add no work.
    async fn subjects(&self) -> Result<Vec<ProcessIdentity>, Error> {
        let mut subjects: Vec<ProcessIdentity> = lock(&self.inner.members)
            .iter()
            .map(ProcessInfo::identity)
            .collect();
        // Before the first refresh the list is empty; the leader is known anyway.
        if subjects.is_empty() && !self.inner.leader_exited.load(Ordering::Acquire) {
            subjects.push(self.inner.identity);
        }
        Ok(subjects)
    }
}
