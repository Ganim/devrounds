//! `devrounds-executor service install|uninstall`: the scheduled task
//! `DevRoundsExecutor`, the shape of the control plane's `DevRounds` task
//! (`control-plane/src/service/install.ts`): at logon plus every 5 minutes
//! with `MultipleInstances IgnoreNew`, no time limit, the interactive user
//! with limited rights, `conhost.exe --headless` so no console shows.
//!
//! The task runs a copy of the binary in `<home>/bin`, not the one that ran
//! `install`: a `cargo build` must not fail on a locked `target/release`
//! binary, nor change the running service under it. Installing again copies
//! the new binary over it after stopping the old processes.
//!
//! The scripts are built by pure functions and run by [`run_powershell`],
//! so tests check them without registering anything.

use std::{
    ffi::OsStr,
    io::{self, Read},
    os::windows::io::AsHandle,
    path::{Path, PathBuf},
};

use base64::Engine;
use devrounds_core::DrError;
use devrounds_sys_windows::spawn::{self, CreationFlags, Spawn, Stdio, Stream};
use serde_json::json;

/// The scheduled task's name.
pub const TASK_NAME: &str = "DevRoundsExecutor";
/// The file name of the binary, also the image name processes are found by.
pub const EXE_NAME: &str = "devrounds-executor.exe";

/// What the scheduled task runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceTarget {
    /// The binary `service install` copies: the one running it.
    pub source: PathBuf,
    /// The copy the task runs, `<home>/bin/devrounds-executor.exe`.
    pub exe: PathBuf,
    /// The executor home, the task's working directory.
    pub home: PathBuf,
}

impl ServiceTarget {
    /// The target for installing `source` into `home`.
    pub fn new(source: PathBuf, home: PathBuf) -> Self {
        Self {
            exe: home.join("bin").join(EXE_NAME),
            source,
            home,
        }
    }
}

/// A PowerShell single-quoted string: nothing expands inside, a quote is
/// written twice.
fn ps(value: &Path) -> String {
    ps_str(&value.to_string_lossy())
}

fn ps_str(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Filtered rather than `-TaskName`: a missing name is a terminating error
/// under `ErrorActionPreference Stop`, and uninstalling twice is a no-op.
fn find_task() -> String {
    format!("$task = Get-ScheduledTask | Where-Object TaskName -eq '{TASK_NAME}'")
}

/// Stops every process of the installed binary: `supervise` first, so it
/// does not restart `run`, then `run` and any console helper. Stopping the
/// task ends only conhost; these outlive it. Waits for them to exit, since
/// the binary is replaced next. Runs are other programs and keep running.
pub fn stop_processes_script(target: &ServiceTarget) -> String {
    [
        format!(
            "$running = @(Get-CimInstance Win32_Process -Filter \"name='{EXE_NAME}'\" | \
             Where-Object {{ $_.ExecutablePath -eq {} }})",
            ps(&target.exe)
        ),
        "$running | Sort-Object { $_.CommandLine -notmatch ' supervise$' } | \
         ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
            .to_owned(),
        "if ($running) { Wait-Process -Id $running.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }"
            .to_owned(),
    ]
    .join("\n")
}

/// Registers the task and starts it, replacing an installed one.
pub fn register_script(target: &ServiceTarget) -> String {
    let user = "\"$env:USERDOMAIN\\$env:USERNAME\"";
    let argument = format!("--headless \"{}\" supervise", target.exe.to_string_lossy());
    let mut lines = vec![
        find_task(),
        "if ($task) {".to_owned(),
        format!("Stop-ScheduledTask -TaskName '{TASK_NAME}'"),
        "}".to_owned(),
        stop_processes_script(target),
    ];
    if target.source != target.exe {
        let bin = target.exe.parent().unwrap_or(&target.home);
        lines.push(format!(
            "New-Item -ItemType Directory -Force -Path {} | Out-Null",
            ps(bin)
        ));
        lines.push(format!(
            "Copy-Item -LiteralPath {} -Destination {} -Force",
            ps(&target.source),
            ps(&target.exe)
        ));
    }
    lines.extend([
        format!(
            "$action = New-ScheduledTaskAction -Execute \"$env:SystemRoot\\System32\\conhost.exe\" \
             -Argument {} -WorkingDirectory {}",
            ps_str(&argument),
            ps(&target.home)
        ),
        format!("$logon = New-ScheduledTaskTrigger -AtLogOn -User {user}"),
        "$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)"
            .to_owned(),
        "$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) \
         -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable"
            .to_owned(),
        format!(
            "$principal = New-ScheduledTaskPrincipal -UserId {user} -LogonType Interactive -RunLevel Limited"
        ),
        format!(
            "Register-ScheduledTask -TaskName '{TASK_NAME}' -Action $action -Trigger $logon,$repeat \
             -Settings $settings -Principal $principal -Force | Out-Null"
        ),
        format!("Start-ScheduledTask -TaskName '{TASK_NAME}'"),
    ]);
    lines.join("\n")
}

/// Stops the task and its processes, removes the task and the installed
/// copy. The home (pairing, store, logs) stays.
pub fn unregister_script(target: &ServiceTarget) -> String {
    [
        find_task(),
        format!("if ($task) {{ Stop-ScheduledTask -TaskName '{TASK_NAME}' }}"),
        stop_processes_script(target),
        "if ($task) {".to_owned(),
        format!("Unregister-ScheduledTask -TaskName '{TASK_NAME}' -Confirm:$false"),
        "}".to_owned(),
        format!(
            "Remove-Item -LiteralPath {} -Force -ErrorAction SilentlyContinue",
            ps(&target.exe)
        ),
    ]
    .join("\n")
}

/// Runs `script` in a hidden Windows PowerShell with `ErrorActionPreference
/// Stop`; DR501 with its error output when it fails. Blocking.
pub fn run_powershell(script: &str) -> Result<(), DrError> {
    // `exit 0` because powershell.exe exits 1 whenever the last command set
    // `$?` false, even for an error it was told to ignore; the catch turns a
    // terminating error into one plain line instead of CLIXML.
    let script = format!(
        "$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\ntry {{\n{script}\n}} catch {{\n\
         [Console]::Error.WriteLine($_.Exception.Message)\nexit 1\n}}\nexit 0"
    );
    // -EncodedCommand takes UTF-16LE in base64, so the script needs no
    // quoting for the command line.
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    let failed = |reason: String| DrError::new("DR501", json!({ "reason": reason }));
    let program = devrounds_sys_windows::file::system_directory()
        .map_err(|error| failed(format!("system directory: {error}")))?
        .join(r"WindowsPowerShell\v1.0\powershell.exe");
    let line = format!(
        "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {encoded}"
    );
    // Both streams: PowerShell writes some errors to stdout, and the
    // scripts print nothing else.
    let (mut errors, errors_write) =
        spawn::pipe().map_err(|error| failed(format!("pipe: {error}")))?;
    let child = spawn::spawn(&Spawn {
        program: &program,
        command_line: OsStr::new(&line),
        environment: None,
        cwd: None,
        stdio: Stdio::Handles {
            stdin: Stream::Null,
            stdout: Stream::Handle(errors_write.as_handle()),
            stderr: Stream::Handle(errors_write.as_handle()),
        },
        inherit: &[],
        job: None,
        flags: CreationFlags {
            no_window: true,
            ..CreationFlags::default()
        },
    })
    .map_err(|error| failed(format!("starting powershell: {error}")))?;
    drop(errors_write);
    let mut stderr = Vec::new();
    let read = errors.read_to_end(&mut stderr);
    let code = child
        .wait()
        .map_err(|error| failed(format!("waiting for powershell: {error}")))?;
    if code == 0 {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&stderr).trim().to_owned();
    Err(failed(match read {
        Ok(_) if !stderr.is_empty() => stderr,
        Ok(_) => format!("powershell exited with code {code}"),
        Err(error) => format!("powershell exited with code {code}; its error output: {error}"),
    }))
}

/// The target for installing the running binary into `home`.
pub fn current_target(home: &Path) -> io::Result<ServiceTarget> {
    Ok(ServiceTarget::new(
        std::env::current_exe()?,
        home.to_path_buf(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> ServiceTarget {
        ServiceTarget {
            source: PathBuf::from(r"C:\src\devrounds-executor.exe"),
            exe: PathBuf::from(r"C:\Users\it's me\.devrounds\executor\bin\devrounds-executor.exe"),
            home: PathBuf::from(r"C:\Users\it's me\.devrounds\executor"),
        }
    }

    #[test]
    fn register_script_runs_supervise_under_headless_conhost() {
        let script = register_script(&target());
        let action = script
            .lines()
            .find(|line| line.starts_with("$action = New-ScheduledTaskAction"))
            .expect("an action line");
        assert!(
            action.contains(r#"-Execute "$env:SystemRoot\System32\conhost.exe""#),
            "{action}"
        );
        // A quote inside a single-quoted PowerShell string is written twice.
        assert!(
            action.contains(
                r#"-Argument '--headless "C:\Users\it''s me\.devrounds\executor\bin\devrounds-executor.exe" supervise'"#
            ),
            "{action}"
        );
        assert!(
            action.contains(r"-WorkingDirectory 'C:\Users\it''s me\.devrounds\executor'"),
            "{action}"
        );
        for shape in [
            "New-ScheduledTaskTrigger -AtLogOn",
            "-RepetitionInterval (New-TimeSpan -Minutes 5)",
            "-MultipleInstances IgnoreNew",
            "-ExecutionTimeLimit ([TimeSpan]::Zero)",
            "-LogonType Interactive -RunLevel Limited",
            "Register-ScheduledTask -TaskName 'DevRoundsExecutor'",
            "Start-ScheduledTask -TaskName 'DevRoundsExecutor'",
            r"Copy-Item -LiteralPath 'C:\src\devrounds-executor.exe'",
        ] {
            assert!(script.contains(shape), "missing {shape:?} in\n{script}");
        }
        // The copy replaces a binary the old processes may still hold.
        let stop = script
            .find("Stop-Process")
            .expect("stops the old processes");
        let copy = script.find("Copy-Item").expect("copies the binary");
        let register = script.find("Register-ScheduledTask").expect("registers");
        assert!(stop < copy && copy < register, "{script}");
    }

    /// Installing from the installed copy has nothing to copy, and
    /// `Copy-Item` onto itself fails.
    #[test]
    fn register_script_skips_the_copy_onto_itself() {
        let mut target = target();
        target.source = target.exe.clone();
        assert!(!register_script(&target).contains("Copy-Item"));
    }

    /// The processes outlive their task, so uninstall stops them whether or
    /// not the task still exists.
    #[test]
    fn unregister_script_stops_the_processes_outside_any_if_block() {
        let script = unregister_script(&target());
        let lines: Vec<&str> = script.lines().collect();
        let stop = lines
            .iter()
            .position(|line| line.contains("Stop-Process"))
            .expect("stops the processes");
        let before = &lines[..stop];
        let opened = before.iter().filter(|line| line.ends_with('{')).count();
        let closed = before.iter().filter(|line| **line == "}").count();
        assert_eq!(opened, closed, "{script}");
        assert!(
            script
                .contains("Unregister-ScheduledTask -TaskName 'DevRoundsExecutor' -Confirm:$false")
        );
    }
}
