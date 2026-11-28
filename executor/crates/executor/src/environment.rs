//! Feature `environment`: the probe an Offer names (`JobSpec::environment_probe`),
//! run in the job's directory with the run's environment just before the run
//! starts, and read back for `RunStarted`. The control plane chose the probe
//! for the job type's environment provider; this module only runs a command
//! and reads its stdout as JSON.

use std::{collections::BTreeMap, path::Path, time::Duration};

use devrounds_core::{LaunchSpec, Probe, RunOutput, StopPolicy};
use devrounds_protocol::EnvironmentReading;
use devrounds_runner_windows::{ExitReport, WindowsRunner};
use serde_json::Value;

/// A probe only reads state; one still running after this is stopped and the
/// run starts without its reading, so a hung probe delays a run (and a stop
/// asked meanwhile) by at most this.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// Stdout past this is not read: the reading rides on `RunStarted`, which has
/// to fit the 4 MiB frame with room to spare.
const MAX_OUTPUT: u64 = 1024 * 1024;

/// Runs `probe` in `cwd` with `env`, its output in files of `run_dir`, and
/// returns what it printed. Never fails the run: every problem is the
/// reading's `error`.
pub(crate) async fn read(
    runner: &WindowsRunner,
    probe: &Probe,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    run_dir: &Path,
) -> EnvironmentReading {
    let stdout = run_dir.join("environment.stdout.raw");
    let spec = LaunchSpec {
        program: probe.program.clone(),
        args: probe.args.clone(),
        cwd: cwd.to_path_buf(),
        env: env.clone(),
        output: RunOutput {
            stdout: stdout.clone(),
            stderr: run_dir.join("environment.stderr.raw"),
        },
    };
    let unit = match runner.spawn_unit(spec).await {
        Ok(unit) => unit,
        Err(error) => return failed(None, format!("{} could not start: {error}", probe.program)),
    };
    let report = match tokio::time::timeout(PROBE_TIMEOUT, unit.wait_report()).await {
        Ok(report) => report,
        Err(_) => {
            // The run waits for the probe's tree to go, so the two never overlap.
            let _ = unit.stop_with_report(StopPolicy::default()).await;
            let summary = format!("still running after {} s; stopped", PROBE_TIMEOUT.as_secs());
            return failed(None, summary);
        }
    };
    let exit_code = match report {
        Ok(ExitReport { outcome, .. }) => outcome.code.map(i64::from),
        Err(error) => return failed(None, format!("its exit could not be read: {error}")),
    };
    match tokio::task::spawn_blocking(move || read_json(&stdout)).await {
        Ok(Ok(output)) => EnvironmentReading {
            output: Some(output),
            exit_code,
            error: None,
        },
        Ok(Err(error)) => failed(exit_code, error),
        Err(error) => failed(exit_code, format!("its output could not be read: {error}")),
    }
}

fn failed(exit_code: Option<i64>, error: String) -> EnvironmentReading {
    EnvironmentReading {
        output: None,
        exit_code,
        error: Some(error),
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let unread = |error: std::io::Error| format!("its output could not be read: {error}");
    let len = std::fs::metadata(path).map_err(unread)?.len();
    if len > MAX_OUTPUT {
        return Err(format!("printed {len} bytes, over the {MAX_OUTPUT} read"));
    }
    let bytes = std::fs::read(path).map_err(unread)?;
    serde_json::from_slice(&bytes).map_err(|error| format!("printed no JSON: {error}"))
}
