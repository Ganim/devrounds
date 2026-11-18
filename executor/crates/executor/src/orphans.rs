//! Orphans: runs a previous executor process left in the store. At start,
//! before anything is admitted, [`scan_orphans`] sorts them into alive (the
//! leader still runs: same boot, same pid and start time) and dead, and the
//! run loop reports them in one `Orphans` event. An orphan is never adopted
//! again (no sampler, no output tail, no `RunFinished`): an alive one waits
//! for its job type's policy, the output it left ships as segments, and the
//! run is forgotten once all of that is acked.
//!
//! The orphan pass also sweeps `<runs dir>/<run>/` directories nobody owns
//! any more ([`sweep_run_dirs`]): pending segment acks live only in the
//! executor process, so a restart, or a lost or unstored segment that left a
//! run unsealed, leaves its raw files and segments behind.

use std::{
    collections::BTreeSet,
    io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use devrounds_core::{DrError, ProcessIdentity};
use devrounds_runner_windows::{WindowsRunner, stop_orphan};
use devrounds_store::{Store, StoredRun};
use devrounds_sys_windows::proc;
use serde_json::json;
use tokio::sync::watch;

use crate::output::{SegmentOptions, orphan_segment_event, recover_orphan_log};

/// The grace a killed orphan gets, as a stop of a supervised run does.
const ORPHAN_GRACE: Duration = Duration::from_secs(10);
/// How long a run directory nobody owns is kept after its last change. Its
/// raw files may be the only copy of output that never shipped, so they stay
/// for a while to look at.
pub const RUN_DIR_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// How often a long-lived executor sweeps again after the pass at start.
pub const SWEEP_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// Every run in the store, with whether its leader still runs: recorded in
/// this boot and `proc::matches` its pid and start time. A run that never got
/// a process is dead. A leader that cannot be checked counts as alive: a stop
/// of an orphan verifies every process it ends, while a run reported dead is
/// failed for good.
pub async fn scan_orphans(store: &Store) -> Result<Vec<(StoredRun, bool)>, DrError> {
    let runs = store.runs_in_flight().await?;
    if runs.is_empty() {
        return Ok(Vec::new());
    }
    tokio::task::spawn_blocking(move || {
        let boot = proc::boot_id()
            .inspect_err(|error| tracing::warn!(%error, "boot id unreadable; orphans count as dead"))
            .ok();
        runs.into_iter()
            .map(|run| {
                let alive = match (&run.identity, &boot) {
                    (Some(identity), Some(boot)) if identity.boot_id == *boot => {
                        proc::matches(identity.pid, identity.start_time).unwrap_or_else(|error| {
                            tracing::warn!(run = %run.run_id, %error, "orphan leader not checked; counted alive");
                            true
                        })
                    }
                    _ => false,
                };
                (run, alive)
            })
            .collect()
    })
    .await
    .map_err(|error| DrError::new("DR501", json!({ "reason": error.to_string() })))
}

/// Removes every directory under `runs_dir` whose run this executor no
/// longer knows (not in flight, no event of it in the outbox, so its
/// `RunFinished` was acked) and in which nothing changed for `retention`.
/// Each removal is warned. Returns the directories removed.
pub async fn sweep_run_dirs(
    store: &Store,
    runs_dir: &Path,
    retention: Duration,
) -> Result<Vec<PathBuf>, DrError> {
    let mut known: BTreeSet<String> = store
        .runs_in_flight()
        .await?
        .into_iter()
        .map(|run| run.run_id)
        .collect();
    known.extend(store.outbox_runs().await?);
    let runs_dir = runs_dir.to_owned();
    tokio::task::spawn_blocking(move || sweep_blocking(&runs_dir, &known, retention))
        .await
        .map_err(|error| DrError::new("DR501", json!({ "reason": error.to_string() })))
}

/// [`sweep_run_dirs`] at start, then every [`SWEEP_EVERY`]; a failed pass
/// is warned and the next one tries again.
pub async fn sweep_forever(store: Store, runs_dir: PathBuf) {
    let mut every = tokio::time::interval(SWEEP_EVERY);
    loop {
        every.tick().await;
        if let Err(error) = sweep_run_dirs(&store, &runs_dir, RUN_DIR_RETENTION).await {
            tracing::warn!(%error, "run directory sweep failed");
        }
    }
}

fn sweep_blocking(runs_dir: &Path, known: &BTreeSet<String>, retention: Duration) -> Vec<PathBuf> {
    let entries = match std::fs::read_dir(runs_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            tracing::warn!(path = %runs_dir.display(), %error, "runs directory unreadable; nothing swept");
            return Vec::new();
        }
    };
    let mut swept = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(run) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !path.is_dir() || known.contains(run) {
            continue;
        }
        let idle = newest_change(&path, 2)
            .and_then(|changed| SystemTime::now().duration_since(changed).ok())
            .unwrap_or_default();
        if idle < retention {
            continue;
        }
        match std::fs::remove_dir_all(&path) {
            Ok(()) => {
                tracing::warn!(%run, path = %path.display(), idle_s = idle.as_secs(), "leftover run directory swept");
                swept.push(path);
            }
            Err(error) => {
                tracing::warn!(%run, path = %path.display(), %error, "leftover run directory not swept");
            }
        }
    }
    swept
}

/// The latest modification time of `path` and what lies under it, `depth`
/// levels down (a run directory holds files and `segments/`). `None` when
/// nothing could be read, which keeps the directory.
fn newest_change(path: &Path, depth: u32) -> Option<SystemTime> {
    let mut newest = std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()?;
    if depth > 0
        && path.is_dir()
        && let Ok(entries) = std::fs::read_dir(path)
    {
        for entry in entries.flatten() {
            if let Some(changed) = newest_change(&entry.path(), depth - 1) {
                newest = newest.max(changed);
            }
        }
    }
    Some(newest)
}

/// What following an orphan needs from the run loop.
pub(crate) struct OrphanDeps<'a> {
    pub store: &'a Store,
    pub runner: &'a WindowsRunner,
    pub log_options: &'a SegmentOptions,
}

/// Follows one orphan reported as event `reported`. An alive orphan waits
/// for the control plane's answer: it sends `Stop { orphan_policy }` for the
/// kill policy before it acks the `Orphans` event, on the same socket, so an
/// ack with no stop before it means `let_finish` and the orphan is left
/// running. A stop ends the recorded tree with [`stop_orphan`]. Then the
/// output the run left ships as `LogSegment` events, and the run is
/// forgotten once every one of them is acked. A segment the store refused
/// keeps the run, so the next start reports it again.
pub(crate) async fn follow_orphan(
    deps: OrphanDeps<'_>,
    stored: StoredRun,
    alive: bool,
    reported: u64,
    mut stopped: watch::Receiver<bool>,
) {
    let run = stored.run_id.clone();
    let mut acked = deps.store.acked();
    if alive {
        let stop = tokio::select! {
            biased;
            () = stop_asked(&mut stopped) => true,
            ready = acked.wait_for(|seq| *seq >= reported) => {
                if ready.is_err() {
                    return;
                }
                false
            }
        };
        if stop {
            kill(deps.runner, &stored).await;
        } else {
            tracing::info!(%run, "orphan left running: its job type lets it finish");
        }
    }

    let (options, dir) = (deps.log_options.clone(), stored.run_dir.clone());
    let name = run.clone();
    let segments = tokio::task::spawn_blocking(move || recover_orphan_log(&name, &dir, &options))
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(%run, %error, "orphan's output not recovered");
            Vec::new()
        });
    let mut last = reported;
    for meta in segments {
        let (options, dir, name) = (
            deps.log_options.clone(),
            stored.run_dir.clone(),
            run.clone(),
        );
        let event =
            tokio::task::spawn_blocking(move || orphan_segment_event(&name, &dir, &meta, &options))
                .await
                .map_err(|error| error.to_string())
                .and_then(|event| event);
        let event = match event {
            Ok(event) => event,
            Err(error) => {
                tracing::error!(%run, %error, "orphan's log segment not shipped; its output stays on disk");
                continue;
            }
        };
        match deps.store.append_event(event).await {
            Ok(seq) => last = seq,
            Err(error) => {
                tracing::error!(%run, %error, "orphan's log segment not stored; the run stays in the store");
                return;
            }
        }
    }
    if acked.wait_for(|seq| *seq >= last).await.is_err() {
        return;
    }
    if let Err(error) = deps.store.forget_run(&run).await {
        tracing::warn!(%run, %error, "orphan not removed from the store");
    }
}

/// Resolves once a stop was asked for; never if the flag's sender is gone.
async fn stop_asked(stopped: &mut watch::Receiver<bool>) {
    if stopped.wait_for(|stop| *stop).await.is_err() {
        std::future::pending::<()>().await;
    }
}

/// Ends the orphan's recorded tree, off the async threads.
async fn kill(runner: &WindowsRunner, stored: &StoredRun) {
    let run = stored.run_id.clone();
    let Some(identity) = &stored.identity else {
        tracing::warn!(%run, "stop of an orphan with no recorded process ignored");
        return;
    };
    let leader = ProcessIdentity {
        pid: identity.pid,
        sid: 0,
        start_time: identity.start_time,
    };
    let members = stored.members.clone();
    let helper = runner.console_helper().cloned();
    let runtimes = runner.runtimes().clone();
    let stopped = tokio::task::spawn_blocking(move || {
        stop_orphan(helper.as_ref(), &runtimes, leader, &members, ORPHAN_GRACE)
    })
    .await;
    match stopped {
        Ok(stop) => tracing::warn!(
            %run,
            running = stop.running,
            terminated = stop.terminated,
            "orphan stopped by its job type's policy"
        ),
        Err(error) => tracing::error!(%run, %error, "orphan stop failed"),
    }
}
