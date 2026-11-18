//! The service's process stop, run for real through hidden PowerShell: it
//! ends the processes of the installed binary and no other copy. No
//! scheduled task is registered or touched: only the stop part of the
//! scripts runs here.
#![cfg(windows)]

use std::{
    os::windows::process::CommandExt,
    path::Path,
    process::{Child, Command, Stdio},
};

use devrounds_executor::service::{EXE_NAME, ServiceTarget, run_powershell, stop_processes_script};

/// `CREATE_NO_WINDOW`: the test processes stay hidden too.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A copy of tree-fixture named like the executor in `dir`, running for a
/// minute.
fn start_copy(dir: &Path) -> std::io::Result<Child> {
    std::fs::create_dir_all(dir)?;
    let exe = dir.join(EXE_NAME);
    std::fs::copy(devrounds_test_fixtures::tree_fixture_path(), &exe)?;
    Command::new(&exe)
        .args(["--run-ms", "60000"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
}

/// Ends `child` and waits for it, whatever the test did.
struct Reap(Child);

impl Drop for Reap {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A failing script answers DR501 with PowerShell's message as one line.
#[test]
fn a_failing_script_answers_dr501_with_its_message() {
    let error = run_powershell("Write-Error 'no such task'").expect_err("fails");
    assert_eq!(error.code, "DR501");
    assert_eq!(error.data["reason"], "no such task");
}

#[test]
fn stop_processes_ends_the_installed_binary_and_leaves_other_copies()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR"))?;
    let home = temp.path().join("home");
    let target = ServiceTarget::new(home.join("source.exe"), home.clone());
    let mut installed = Reap(start_copy(&home.join("bin"))?);
    let mut bystander = Reap(start_copy(&temp.path().join("other"))?);

    run_powershell(&stop_processes_script(&target)).map_err(|error| error.to_string())?;

    // The script waits for what it stopped, so the exit is already visible.
    assert!(
        installed.0.try_wait()?.is_some(),
        "the installed copy still runs"
    );
    assert!(
        bystander.0.try_wait()?.is_none(),
        "another copy was stopped"
    );
    Ok(())
}
