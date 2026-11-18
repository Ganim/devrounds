//! No process of a run ever shows a window: not nested console programs, not
//! `cmd.exe` wrapping a batch file, not the console helper that delivers a
//! stop. Each test reads the windows every 100 ms while the run lives.
#![cfg(windows)]

mod support;

use std::{sync::Arc, time::Duration};

use devrounds_core::StopPolicy;
use devrounds_runner_windows::WindowsUnit;
use devrounds_sys_windows::{proc, window};
use support::{Cleanup, bounded, fixture, launch, run_dir, runner, stdout, tree_fixture};
use tokio::task::JoinHandle;

/// How often the windows are read.
const POLL: Duration = Duration::from_millis(100);

/// Reads [`WindowsUnit::visible_windows`] every [`POLL`] until the run has
/// finished; the readings, in order.
fn watch(unit: &Arc<WindowsUnit>) -> JoinHandle<Vec<u32>> {
    let unit = Arc::clone(unit);
    tokio::spawn(async move {
        let mut readings = Vec::new();
        while unit.exit_report().is_none() {
            readings.push(unit.visible_windows().await.expect("visible windows"));
            tokio::time::sleep(POLL).await;
        }
        readings
    })
}

/// Asserts the run was watched at least a few times and never had a window.
fn assert_hidden(readings: &[u32]) {
    assert!(readings.len() >= 3, "watched too briefly: {readings:?}");
    assert!(readings.iter().all(|&count| count == 0), "{readings:?}");
}

/// Visible windows on this desktop owned by another process running this
/// test binary, which is what the console helper is here.
fn helper_windows() -> usize {
    let me = std::env::current_exe().expect("test binary path");
    let name = me.file_name().expect("file name").to_string_lossy();
    window::visible_windows()
        .iter()
        .filter(|w| w.pid != std::process::id())
        .filter(|w| {
            proc::process(w.pid)
                .ok()
                .flatten()
                .is_some_and(|p| p.name.eq_ignore_ascii_case(&name))
        })
        .count()
}

/// `cmd.exe` starting a console program that starts two more, which outlive
/// it: none of them, nor their console, shows a window.
#[tokio::test]
async fn nested_console_children_stay_hidden() {
    bounded(async {
        let dir = run_dir();
        let fixture = tree_fixture();
        let spec = launch(
            dir.path(),
            "cmd.exe",
            &["/c", &fixture, "--children", "2", "--linger-ms", "2000"],
        );
        let unit = runner().spawn_unit(spec).await.expect("spawn");
        let _cleanup = Cleanup(unit.clone(), dir.path().to_path_buf());
        let watching = watch(&unit);
        let report = unit.wait_report().await.expect("report");
        assert_eq!(report.outcome.code, Some(0), "{report:?}");
        assert_hidden(&watching.await.expect("watch"));
    })
    .await;
}

/// A batch file runs through `cmd.exe` hidden, and gets every argument as
/// given: spaces, `&` and non-ASCII text.
#[tokio::test]
async fn cmd_wrapper_gets_exact_arguments_and_stays_hidden() {
    bounded(async {
        let dir = run_dir();
        let script = dir.path().join("echo-args.cmd");
        // UTF-8 output, so `é` comes back as written.
        std::fs::write(
            &script,
            "@chcp 65001 >nul\r\n@echo off\r\nfor %%a in (%*) do echo [%%~a]\r\n",
        )
        .expect("write echo-args.cmd");
        let spec = launch(dir.path(), &script.to_string_lossy(), &["a b", "c&d", "é"]);
        let unit = runner().spawn_unit(spec).await.expect("spawn");
        let _cleanup = Cleanup(unit.clone(), dir.path().to_path_buf());
        let watching = watch(&unit);
        let report = unit.wait_report().await.expect("report");
        assert_eq!(report.outcome.code, Some(0), "{report:?}");
        let out = stdout(dir.path());
        assert_eq!(out.lines().collect::<Vec<_>>(), ["[a b]", "[c&d]", "[é]"]);
        // A batch file finishes fast; the readings cover what there was.
        let readings = watching.await.expect("watch");
        assert!(readings.iter().all(|&count| count == 0), "{readings:?}");
    })
    .await;
}

/// A graceful stop starts the console helper, which attaches to the run's
/// console; neither it nor the run shows a window meanwhile.
#[tokio::test]
async fn console_ctrl_helper_is_hidden() {
    // The executor's startup path, so the run accepts the Ctrl-C.
    devrounds_runner_windows::prepare_executor_process().expect("prepare");
    bounded(async {
        let dir = run_dir();
        let unit = runner()
            .spawn_unit(fixture(dir.path(), &["--ctrl-c", "bye"]))
            .await
            .expect("spawn");
        let _cleanup = Cleanup(unit.clone(), dir.path().to_path_buf());
        let watching = watch(&unit);
        let helpers = tokio::task::spawn_blocking({
            let unit = Arc::clone(&unit);
            move || {
                let mut readings = Vec::new();
                while unit.exit_report().is_none() {
                    readings.push(helper_windows());
                    std::thread::sleep(POLL);
                }
                readings
            }
        });
        // Let the fixture install its handler and the watchers read a few times.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let report = unit
            .stop_with_report(StopPolicy::default())
            .await
            .expect("stop");
        assert!(!report.stop.expect("stop outcome").escalated, "{report:?}");
        assert!(stdout(dir.path()).contains("bye"));
        assert_hidden(&watching.await.expect("watch"));
        let helpers = helpers.await.expect("helper watch");
        assert!(helpers.iter().all(|&count| count == 0), "{helpers:?}");
    })
    .await;
}

/// The check is not blind: a member that opens a console of its own with
/// `start` (minimized, so it does not take the focus) is counted.
#[tokio::test]
async fn a_visible_member_window_is_counted() {
    bounded(async {
        let dir = run_dir();
        let fixture = tree_fixture();
        let spec = launch(
            dir.path(),
            "cmd.exe",
            &["/c", "start", "", "/min", &fixture, "--run-ms", "3000"],
        );
        let unit = runner().spawn_unit(spec).await.expect("spawn");
        let _cleanup = Cleanup(unit.clone(), dir.path().to_path_buf());
        let mut seen = 0;
        for _ in 0..30 {
            seen = unit.visible_windows().await.expect("visible windows");
            if seen > 0 {
                break;
            }
            tokio::time::sleep(POLL).await;
        }
        assert!(seen > 0, "the started console's window was not counted");
    })
    .await;
}
