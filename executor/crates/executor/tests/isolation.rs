//! `none` isolation hands the child only the allowlisted variables and the
//! job's `env_set`. Runs `tree-fixture --print-env` in a job of its own.
#![cfg(windows)]

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use devrounds_core::JobSpec;
use devrounds_executor::isolation::{Isolation, NoneIsolation, PrepareError};
use devrounds_runner_windows::{WindowsRunner, WindowsUnit};

/// Upper bound for the test body.
const LIMIT: Duration = Duration::from_secs(60);

/// Ends the run's job when the test is done, then removes its directory once
/// the job's processes are gone.
struct Cleanup(Arc<WindowsUnit>, PathBuf);

impl Drop for Cleanup {
    fn drop(&mut self) {
        self.0.terminate();
        let deadline = Instant::now() + Duration::from_secs(5);
        while std::fs::remove_dir_all(&self.1).is_err()
            && self.1.exists()
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

fn job(cwd: &str, env_allow: &[&str]) -> JobSpec {
    JobSpec {
        job_type: "probe".into(),
        program: devrounds_test_fixtures::tree_fixture_path()
            .to_string_lossy()
            .into_owned(),
        args: vec!["--print-env".into()],
        cwd: cwd.into(),
        env_allow: env_allow.iter().map(|name| (*name).to_owned()).collect(),
        timeout_s: 60,
        env_set: BTreeMap::new(),
    }
}

fn environment_summary(error: PrepareError) -> String {
    let PrepareError::Environment { summary } = error;
    summary
}

#[tokio::test]
async fn only_allowlisted_variables_reach_the_child() {
    devrounds_test_fixtures::tree_fixture_path();
    devrounds_runner_windows::prepare_executor_process().expect("prepare");
    tokio::time::timeout(LIMIT, async {
        let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
        let path = std::env::var("PATH").expect("PATH");
        let machine_env = BTreeMap::from([
            ("PATH".to_owned(), path),
            ("SECRET_TOKEN".to_owned(), "s3cr3t".to_owned()),
        ]);
        let spec = NoneIsolation
            .prepare(
                "run-1",
                &job(&dir.path().to_string_lossy(), &["path"]),
                dir.path(),
                &machine_env,
            )
            .expect("prepare");
        let stdout = spec.output.stdout.clone();
        let unit = WindowsRunner::default()
            .spawn_unit(spec)
            .await
            .expect("spawn");
        let _cleanup = Cleanup(Arc::clone(&unit), dir.path().to_path_buf());
        unit.wait_report().await.expect("report");

        let printed = std::fs::read_to_string(stdout).expect("stdout");
        assert!(printed.contains("PATH="), "{printed}");
        assert!(printed.contains("DEVROUNDS_RUN_ID=run-1"), "{printed}");
        assert!(!printed.contains("SECRET_TOKEN"), "{printed}");
        assert!(!printed.contains("s3cr3t"), "{printed}");
    })
    .await
    .expect("bounded");
}

#[test]
fn missing_cwd_is_an_environment_failure() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
    let missing = dir.path().join("gone");
    let missing = missing.to_string_lossy().into_owned();
    let error = NoneIsolation
        .prepare("run-1", &job(&missing, &[]), dir.path(), &BTreeMap::new())
        .err()
        .expect("fails");
    assert!(environment_summary(error).contains(&missing));
}

#[test]
fn relative_cwd_is_an_environment_failure() {
    let error = NoneIsolation
        .prepare(
            "run-1",
            &job("some/where", &[]),
            Path::new("."),
            &BTreeMap::new(),
        )
        .err()
        .expect("fails");
    assert!(environment_summary(error).contains("some/where"));
}

fn with_env_set(mut job: JobSpec, env_set: &[(&str, &str)]) -> JobSpec {
    job.env_set = env_set
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect();
    job
}

#[tokio::test]
async fn env_set_reaches_the_child_without_an_allowlist_entry() {
    devrounds_test_fixtures::tree_fixture_path();
    devrounds_runner_windows::prepare_executor_process().expect("prepare");
    tokio::time::timeout(LIMIT, async {
        let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
        let job = with_env_set(
            job(&dir.path().to_string_lossy(), &[]),
            &[("DB_NAME", "devrounds_test_1")],
        );
        let spec = NoneIsolation
            .prepare("run-1", &job, dir.path(), &BTreeMap::new())
            .expect("prepare");
        let stdout = spec.output.stdout.clone();
        let unit = WindowsRunner::default()
            .spawn_unit(spec)
            .await
            .expect("spawn");
        let _cleanup = Cleanup(Arc::clone(&unit), dir.path().to_path_buf());
        unit.wait_report().await.expect("report");

        let printed = std::fs::read_to_string(stdout).expect("stdout");
        assert!(printed.contains("DB_NAME=devrounds_test_1"), "{printed}");
    })
    .await
    .expect("bounded");
}

#[test]
fn env_set_replaces_a_machine_variable_spelled_in_another_case() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
    let machine_env = BTreeMap::from([("Log_Level".to_owned(), "debug".to_owned())]);
    let job = with_env_set(
        job(&dir.path().to_string_lossy(), &["LOG_LEVEL"]),
        &[("LOG_LEVEL", "warn")],
    );
    let spec = NoneIsolation
        .prepare("run-1", &job, dir.path(), &machine_env)
        .expect("prepare");
    let matching: Vec<(&String, &String)> = spec
        .env
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("LOG_LEVEL"))
        .collect();
    assert_eq!(matching, [(&"LOG_LEVEL".to_owned(), &"warn".to_owned())]);
}

#[test]
fn env_set_cannot_replace_run_id() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
    let job = with_env_set(
        job(&dir.path().to_string_lossy(), &[]),
        &[
            ("DEVROUNDS_RUN_ID", "forged"),
            ("devrounds_run_id", "forged"),
        ],
    );
    let spec = NoneIsolation
        .prepare("run-1", &job, dir.path(), &BTreeMap::new())
        .expect("prepare");
    let matching: Vec<(&String, &String)> = spec
        .env
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("DEVROUNDS_RUN_ID"))
        .collect();
    assert_eq!(
        matching,
        [(&"DEVROUNDS_RUN_ID".to_owned(), &"run-1".to_owned())]
    );
}
