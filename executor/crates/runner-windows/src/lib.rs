//! Runner for executor-owned units on Windows.
//!
//! Every unit starts inside its own job object, which its processes cannot
//! leave, so the job's member list is the unit's process tree; no process
//! snapshots are taken. The leader runs with a hidden console of its own
//! (`CREATE_NO_WINDOW`), which its console descendants share, gets `NUL` as
//! stdin and the run's own output files ([`devrounds_core::RunOutput`]) as
//! stdout and stderr, and is waited on through its process handle. The run
//! ends when its leader exits; members still running then get
//! [`WindowsRunner::exit_grace`] before the job is terminated. All Win32
//! calls go through `devrounds-sys-windows`. `devrounds-executor` calls
//! [`prepare_executor_process`] at startup.
//!
//! A `/bin/sh` program runs as Git for Windows' `sh.exe`, given with
//! [`WindowsRunner::with_shell`].
//!
//! Graceful stops post `WM_CLOSE` to the unit's windows and send Ctrl-C or
//! Ctrl-Break to its console through a short-lived helper process, the
//! `devrounds-executor __console-ctrl` entry point that [`console_ctrl_main`]
//! implements. [`stop_orphan`] stops a unit a previous executor left running
//! the same way, from its recorded processes.
//!
//! Requires a tokio runtime with IO and time drivers enabled.
//!
//! ```no_run
//! # #[cfg(windows)] mod demo {
//! use devrounds_core::{LaunchSpec, Runner, RunOutput, StopPolicy};
//! use devrounds_runner_windows::WindowsRunner;
//!
//! # async fn demo() -> Result<(), devrounds_core::Error> {
//! let unit = WindowsRunner::default()
//!     .spawn(LaunchSpec {
//!         program: "node".into(),
//!         args: vec!["server.js".into()],
//!         cwd: r"C:\work".into(),
//!         env: [("PATH".into(), r"C:\tools".into())].into(),
//!         output: RunOutput {
//!             stdout: r"C:\runs\42\stdout.raw".into(),
//!             stderr: r"C:\runs\42\stderr.raw".into(),
//!         },
//!     })
//!     .await?;
//! unit.stop(StopPolicy::default()).await?;
//! let exit = unit.wait().await?;
//! # let _ = exit;
//! # Ok(())
//! # }
//! # }
//! ```

// Job objects and consoles are Windows.
#![cfg(windows)]
#![deny(unsafe_code)]

use std::{path::PathBuf, sync::Arc, time::Duration};

use async_trait::async_trait;
use devrounds_core::{Error, LaunchSpec, Runner, Unit};

mod command;
mod ctrl;
mod exit;
mod orphan;
mod runtime;
mod spawn;
mod stop;
mod unit;

pub use ctrl::{ConsoleHelper, HELPER_ARG, console_ctrl_main};
pub use devrounds_core::{ProcessInfo, RunIdentity, RunOutput};
pub use orphan::{OrphanStop, stop_orphan};
pub use runtime::Runtimes;
pub use spawn::SpawnError;
pub use unit::{ExitReport, StopOutcome, WindowsUnit};

/// Prepares the executor process for running units; call it once at startup,
/// before the first spawn, as `devrounds-executor`'s `main` does.
///
/// Clears this process's ignore-Ctrl-C flag. Windows passes that flag to
/// every process started from one that has it, and a shell, service host or
/// `CREATE_NEW_PROCESS_GROUP` parent may have set it for the executor. Units
/// inherit it from the executor at spawn, so with it set every graceful
/// SIGINT/SIGTERM stop (a Ctrl-C event) would be ignored and escalate to
/// terminating the job after the grace.
pub fn prepare_executor_process() -> Result<(), Error> {
    devrounds_sys_windows::console::set_ctrl_c_ignored(false)?;
    Ok(())
}

/// `STATUS_CONTROL_C_EXIT`: the exit code of a process that Ctrl-C or
/// Ctrl-Break ended.
pub(crate) const CONTROL_C_EXIT: u32 = 0xC000_013A;

/// Spawns units in job objects that write to run-owned files. Cheap to
/// clone; holds tuning values, the shell, the console helper's command and
/// the shared [`Runtimes`] answers.
#[derive(Debug, Clone)]
pub struct WindowsRunner {
    pub(crate) track_interval: Duration,
    pub(crate) exit_grace: Duration,
    pub(crate) sweep_timeout: Duration,
    pub(crate) shell: Option<PathBuf>,
    pub(crate) helper: Option<ConsoleHelper>,
    pub(crate) runtimes: Runtimes,
}

impl Default for WindowsRunner {
    /// 500 ms membership refreshes, a 10 s exit grace, no shell, and this
    /// executable as the console helper (none when its path cannot be read,
    /// which leaves stops to `WM_CLOSE` and the timeout).
    fn default() -> Self {
        Self {
            track_interval: Duration::from_millis(500),
            exit_grace: Duration::from_secs(10),
            sweep_timeout: Duration::from_secs(1),
            shell: None,
            helper: ConsoleHelper::current_exe().ok(),
            runtimes: Runtimes::default(),
        }
    }
}

impl WindowsRunner {
    /// How long members still running when the leader exits may keep
    /// running before the job is terminated and they are reported as swept;
    /// 10 s by default, the same grace a stop gets.
    pub fn exit_grace(&self) -> Duration {
        self.exit_grace
    }

    /// Sets [`WindowsRunner::exit_grace`]. For tests that would otherwise
    /// wait out the 10 s default; runs keep the default.
    pub fn with_exit_grace(mut self, grace: Duration) -> Self {
        self.exit_grace = grace;
        self
    }

    /// Runs `/bin/sh` programs as `shell`, Git for Windows' `usr\bin\sh.exe`.
    /// Without one, such units fail with [`SpawnError::ShellMissing`].
    pub fn with_shell(mut self, shell: Option<PathBuf>) -> Self {
        self.shell = shell;
        self
    }

    /// Sends console control events through `helper` instead of this
    /// executable's `__console-ctrl` entry point.
    pub fn with_console_helper(mut self, helper: ConsoleHelper) -> Self {
        self.helper = Some(helper);
        self
    }

    /// Which programs link the MSYS runtime, as this runner has read them;
    /// pass it to [`stop_orphan`] so orphan stops share the answers.
    pub fn runtimes(&self) -> &Runtimes {
        &self.runtimes
    }

    /// Sets how often job membership is refreshed for subjects and stops.
    pub fn with_track_interval(mut self, interval: Duration) -> Self {
        self.track_interval = interval.max(Duration::from_millis(10));
        self
    }

    /// Spawns a unit and returns the concrete handle with identity and report
    /// methods.
    ///
    /// Returns once the leader runs in its job. The environment is exactly
    /// `spec.env` (for the shell, plus the MSYS variables and Git's `usr\bin`
    /// at the end of `PATH`); nothing is inherited from the daemon. `program` is resolved against the `PATH` and `PATHEXT`
    /// in `spec.env`. Failures before the leader started leave nothing behind.
    ///
    /// Not cancellation safe: process creation runs on the blocking pool and
    /// finishes even if this future is dropped, leaving an unsupervised unit.
    pub async fn spawn_unit(&self, spec: LaunchSpec) -> Result<Arc<WindowsUnit>, Error> {
        unit::spawn(self, spec).await
    }
}

#[async_trait]
impl Runner for WindowsRunner {
    /// Spawns through [`WindowsRunner::spawn_unit`], with the same caveat.
    async fn spawn(&self, spec: LaunchSpec) -> Result<Arc<dyn Unit>, Error> {
        Ok(self.spawn_unit(spec).await?)
    }
}
