//! Job Object supervision of runs on DevRounds' tree fixture: every
//! descendant is a job member and cannot break away, stops are graceful
//! first and end the whole tree within the grace period, handles can be
//! dropped without stopping the run, members outliving the leader are swept,
//! and output lands in files the run owns.
#![cfg(windows)]

mod support;

use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

use devrounds_core::{ProcessIdentity, StopPolicy};
use devrounds_sys_windows::{console, proc};
use support::{Cleanup, bounded, fixture, remove_when_released, run_dir, runner, stdout};

/// Ends recorded processes when the test is done, for runs whose handles the
/// test dropped on purpose, then removes the run directory.
struct KillOnDrop(Vec<ProcessIdentity>, PathBuf);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = proc::terminate_verified(p.pid, p.start_time, 1);
        }
        remove_when_released(&self.1);
    }
}

/// Whether `p` is still the process that was recorded.
fn alive(p: &ProcessIdentity) -> bool {
    proc::matches(p.pid, p.start_time).expect("process lookup")
}

/// A leader with two children of two children each: seven processes, all of
/// them in the job (the console host is left out).
#[tokio::test]
async fn every_descendant_is_a_job_member() {
    bounded(async {
        let dir = run_dir();
        let spec = fixture(
            dir.path(),
            &[
                "--children",
                "2",
                "--depth",
                "2",
                "--linger-ms",
                "5000",
                "--run-ms",
                "5000",
            ],
        );
        let unit = runner().spawn_unit(spec).await.expect("spawn");
        let _cleanup = Cleanup(unit.clone(), dir.path().to_path_buf());
        let started = Instant::now();
        let mut members = Vec::new();
        while started.elapsed() < Duration::from_secs(3) {
            members = unit.job_members().await.expect("members");
            if members.len() == 7 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(members.len(), 7, "{members:?}");
        assert!(members.contains(&unit.run_identity().leader));
    })
    .await;
}

/// The job does not allow breakaway, so a member asking for it is refused.
#[tokio::test]
async fn breakaway_is_refused() {
    bounded(async {
        let dir = run_dir();
        let unit = runner()
            .spawn_unit(fixture(dir.path(), &["--breakaway"]))
            .await
            .expect("spawn");
        let _cleanup = Cleanup(unit.clone(), dir.path().to_path_buf());
        let report = unit.wait_report().await.expect("report");
        assert_eq!(report.outcome.code, Some(0));
        let out = stdout(dir.path());
        assert!(out.contains("breakaway: denied"), "{out}");
    })
    .await;
}

/// SIGTERM goes out as Ctrl-C first, and a run whose tree handles it exits on
/// its own within the grace, without escalation and with nothing left to
/// sweep. Runs lead a new process group, which Windows starts with Ctrl-C
/// ignored; the runner clears that for the leader, and descendants inherit
/// it. This test process ignores Ctrl-C on purpose, as one started from a
/// shell or service that set the flag does, so nothing here helps the run.
#[tokio::test]
async fn graceful_stop_lets_ctrl_c_handlers_run() {
    console::set_ctrl_c_ignored(true).expect("ignore Ctrl-C");
    bounded(async {
        let dir = run_dir();
        let unit = runner()
            .spawn_unit(fixture(dir.path(), &["--children", "2", "--ctrl-c", "bye"]))
            .await
            .expect("spawn");
        let _cleanup = Cleanup(unit.clone(), dir.path().to_path_buf());
        // Let the tree start and install its handlers.
        for _ in 0..50 {
            if unit.job_members().await.expect("members").len() == 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        let started = Instant::now();
        let report = unit
            .stop_with_report(StopPolicy::default())
            .await
            .expect("stop");
        assert!(started.elapsed() < Duration::from_secs(10), "{report:?}");
        let stop = report.stop.expect("stop outcome");
        assert!(!stop.escalated, "{report:?}");
        assert!(report.swept.is_empty(), "{report:?}");
        let out = stdout(dir.path());
        assert_eq!(out.matches("bye").count(), 3, "{out}");
    })
    .await;
}

/// A tree that ignores Ctrl-C is terminated at the 10 s grace, and nothing
/// of it survives.
#[tokio::test]
async fn stop_ends_the_tree_within_grace() {
    bounded(async {
        let dir = run_dir();
        let unit = runner()
            .spawn_unit(fixture(
                dir.path(),
                &["--children", "3", "--ctrl-c", "ignore"],
            ))
            .await
            .expect("spawn");
        let _cleanup = Cleanup(unit.clone(), dir.path().to_path_buf());
        let mut members = Vec::new();
        for _ in 0..50 {
            members = unit.job_members().await.expect("members");
            if members.len() == 4 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(members.len(), 4, "{members:?}");
        tokio::time::sleep(Duration::from_millis(500)).await;
        let started = Instant::now();
        let report = unit
            .stop_with_report(StopPolicy::default())
            .await
            .expect("stop");
        assert!(started.elapsed() < Duration::from_secs(12));
        assert!(report.stop.expect("stop outcome").escalated, "{report:?}");
        let survivors: Vec<_> = members.iter().filter(|p| alive(p)).collect();
        assert!(survivors.is_empty(), "{survivors:?}");
    })
    .await;
}

/// Handles are not ownership of the run: dropping all of them leaves it
/// running.
#[tokio::test]
async fn dropping_the_handles_leaves_the_run_running() {
    bounded(async {
        let dir = run_dir();
        let unit = runner()
            .spawn_unit(fixture(dir.path(), &["--run-ms", "30000"]))
            .await
            .expect("spawn");
        let leader = unit.run_identity().leader;
        let _kill = KillOnDrop(vec![leader], dir.path().to_path_buf());
        drop(unit);
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(alive(&leader));
    })
    .await;
}

/// Once the leader exits, members still alive get the exit grace (10 s by
/// default, 2 s here to keep the test short), are then terminated and are
/// listed as swept; the leader's code is the run's.
#[tokio::test]
async fn leader_exit_sweeps_lingering_members() {
    bounded(async {
        let dir = run_dir();
        assert_eq!(runner().exit_grace(), Duration::from_secs(10));
        let grace = Duration::from_secs(2);
        let started = Instant::now();
        let unit = runner()
            .with_exit_grace(grace)
            .spawn_unit(fixture(
                dir.path(),
                &["--children", "2", "--linger-ms", "60000", "--exit", "3"],
            ))
            .await
            .expect("spawn");
        let _cleanup = Cleanup(unit.clone(), dir.path().to_path_buf());
        let report = unit.wait_report().await.expect("report");
        let elapsed = started.elapsed();
        assert!(
            elapsed >= grace && elapsed < Duration::from_secs(10),
            "{elapsed:?}"
        );
        assert_eq!(report.outcome.code, Some(3));
        assert_eq!(report.swept.len(), 2, "{report:?}");
        assert!(report.escaped.is_empty(), "{report:?}");
        assert!(report.swept.iter().all(|p| !alive(&p.identity())));
    })
    .await;
}

/// Output goes to the run's files, which the executor does not hold: it is
/// all there after the handles were dropped while the run still ran.
#[tokio::test]
async fn output_goes_to_run_owned_files() {
    bounded(async {
        let dir = run_dir();
        let unit = runner()
            .spawn_unit(fixture(dir.path(), &["--print", "100", "--run-ms", "1000"]))
            .await
            .expect("spawn");
        let leader = unit.run_identity().leader;
        let _kill = KillOnDrop(vec![leader], dir.path().to_path_buf());
        drop(unit);
        assert!(
            alive(&leader),
            "the leader exited before the handles were dropped"
        );
        let waited = tokio::task::spawn_blocking(move || {
            proc::wait_exit(leader.pid, Duration::from_secs(20))
        })
        .await
        .expect("join")
        .expect("wait");
        assert!(waited);
        let out = stdout(dir.path());
        assert_eq!(out.lines().count(), 100, "{out}");
        assert_eq!(out.lines().last(), Some("line 100"));
    })
    .await;
}

/// The run identity is the leader's `(pid, start time)` plus this boot.
#[tokio::test]
async fn identity_carries_boot_id() {
    bounded(async {
        let dir = run_dir();
        let unit = runner()
            .spawn_unit(fixture(dir.path(), &["--run-ms", "5000"]))
            .await
            .expect("spawn");
        let _cleanup = Cleanup(unit.clone(), dir.path().to_path_buf());
        let identity = unit.run_identity();
        assert_eq!(identity.boot_id, proc::boot_id().expect("boot id"));
        assert_eq!(identity.leader, unit.identity());
        assert!(alive(&identity.leader));
    })
    .await;
}
