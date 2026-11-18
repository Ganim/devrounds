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
    /// The process running the scripts, never stopped by them: `service
    /// install|uninstall` may be run from the installed copy itself.
    pub own_pid: u32,
}

impl ServiceTarget {
    /// The target for installing `source` into `home`, from this process.
    pub fn new(source: PathBuf, home: PathBuf) -> Self {
        Self {
            exe: home.join("bin").join(EXE_NAME),
            source,
            home,
            own_pid: std::process::id(),
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

/// Disabled before anything is stopped: otherwise the 5-minute trigger can
/// start a fresh `supervise` of the old binary between the stop and the copy
/// or the unregister. Everything after it goes in [`reenable_on_failure`].
fn disable_task() -> [String; 3] {
    [
        "if ($task) {".to_owned(),
        format!("Disable-ScheduledTask -TaskName '{TASK_NAME}' | Out-Null"),
        "}".to_owned(),
    ]
}

fn stop_task() -> String {
    format!("if ($task) {{ Stop-ScheduledTask -TaskName '{TASK_NAME}' }}")
}

fn reenable_on_failure_catch() -> String {
    format!(
        "\n}} catch {{\nif ($task) {{ Enable-ScheduledTask -TaskName '{TASK_NAME}' -ErrorAction SilentlyContinue | Out-Null }}\nthrow\n}}"
    )
}

/// `body` in a `try` whose `catch` re-enables the task when one existed
/// before (`$task`) and rethrows, so the script still fails with the step's
/// error. Without it a reinstall or uninstall that fails after the Disable
/// would leave the old task disabled for good.
pub fn reenable_on_failure(body: &str) -> String {
    format!("try {{\n{body}{}", reenable_on_failure_catch())
}

/// Stops every process of the installed binary: `supervise` first, so it
/// does not restart `run`, then `run` and any console helper. Stopping the
/// task ends only conhost; these outlive it. Waits for them to exit, since
/// the binary is replaced next. Runs are other programs and keep running,
/// and so does [`ServiceTarget::own_pid`].
pub fn stop_processes_script(target: &ServiceTarget) -> String {
    [
        format!(
            "$running = @(Get-CimInstance Win32_Process -Filter \"name='{EXE_NAME}'\" | \
             Where-Object {{ $_.ExecutablePath -eq {} -and $_.ProcessId -ne {} }})",
            ps(&target.exe),
            target.own_pid
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
    let mut guarded = vec![stop_task(), stop_processes_script(target)];
    if target.source != target.exe {
        let bin = target.exe.parent().unwrap_or(&target.home);
        guarded.push(format!(
            "New-Item -ItemType Directory -Force -Path {} | Out-Null",
            ps(bin)
        ));
        guarded.push(format!(
            "Copy-Item -LiteralPath {} -Destination {} -Force",
            ps(&target.source),
            ps(&target.exe)
        ));
    }
    guarded.extend([
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
        // A new definition is enabled already; explicit, as the old one was
        // disabled above and a disabled task never starts again.
        format!("Enable-ScheduledTask -TaskName '{TASK_NAME}' | Out-Null"),
        format!("Start-ScheduledTask -TaskName '{TASK_NAME}'"),
    ]);
    let mut lines = vec![find_task()];
    lines.extend(disable_task());
    lines.push(reenable_on_failure(&guarded.join("\n")));
    lines.join("\n")
}

/// Stops the task and its processes, removes the task and the installed
/// copy. The home (pairing, store, logs) stays. The task is re-enabled only
/// when the steps up to its Unregister fail; once it is gone there is
/// nothing to enable.
pub fn unregister_script(target: &ServiceTarget) -> String {
    let guarded = [
        stop_task(),
        stop_processes_script(target),
        format!(
            "if ($task) {{ Unregister-ScheduledTask -TaskName '{TASK_NAME}' -Confirm:$false }}"
        ),
    ];
    let [open, disable, close] = disable_task();
    [
        find_task(),
        open,
        disable,
        close,
        reenable_on_failure(&guarded.join("\n")),
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

/// `path` without the `\\?\` (or `\\?\UNC\`) prefix `canonicalize` adds.
fn plain(path: PathBuf) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path;
    };
    if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{share}"))
    } else if let Some(local) = text.strip_prefix(r"\\?\") {
        PathBuf::from(local)
    } else {
        path
    }
}

/// DR552 when the installed copy outlived uninstall: a process still holds
/// it, most likely the very one that ran `service uninstall`, or a scanner.
pub fn check_removed(target: &ServiceTarget) -> Result<(), DrError> {
    if !target.exe.exists() {
        return Ok(());
    }
    Err(DrError::new(
        "DR552",
        json!({ "path": target.exe.to_string_lossy() }),
    ))
}

/// The target for installing the running binary into `home`. The home is
/// canonical, so the copy's path matches the `ExecutablePath` its processes
/// are found by whatever form `DEVROUNDS_EXECUTOR_HOME` was given in; a home
/// that does not exist yet is made absolute instead.
pub fn current_target(home: &Path) -> io::Result<ServiceTarget> {
    let home = match std::fs::canonicalize(home) {
        Ok(canonical) => plain(canonical),
        Err(_) => std::path::absolute(home)?,
    };
    Ok(ServiceTarget::new(std::env::current_exe()?, home))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> ServiceTarget {
        ServiceTarget {
            source: PathBuf::from(r"C:\src\devrounds-executor.exe"),
            exe: PathBuf::from(r"C:\Users\it's me\.devrounds\executor\bin\devrounds-executor.exe"),
            home: PathBuf::from(r"C:\Users\it's me\.devrounds\executor"),
            own_pid: 4242,
        }
    }

    /// The 5-minute trigger would start a fresh `supervise` between the stop
    /// and the copy (or the unregister): the task is disabled first.
    #[test]
    fn both_scripts_disable_the_task_before_stopping_its_processes() {
        for script in [register_script(&target()), unregister_script(&target())] {
            let disable = script
                .find("Disable-ScheduledTask -TaskName 'DevRoundsExecutor'")
                .unwrap_or_else(|| panic!("disables the task in\n{script}"));
            let stop = script.find("Stop-Process").expect("stops the processes");
            assert!(disable < stop, "{script}");
        }
    }

    /// Everything that can throw between the Disable and the end of the
    /// replacement (or the Unregister) sits in one `try`, whose `catch`
    /// re-enables a task that existed and rethrows: a failed reinstall must
    /// not leave the old task disabled for good. The `Remove-Item` after a
    /// successful Unregister is outside it, as there is no task left.
    #[test]
    fn a_failure_after_the_disable_re_enables_the_task() {
        for (script, last) in [
            (register_script(&target()), "Start-ScheduledTask"),
            (unregister_script(&target()), "Unregister-ScheduledTask"),
        ] {
            let at = |needle: &str| {
                script
                    .find(needle)
                    .unwrap_or_else(|| panic!("{needle:?} missing in\n{script}"))
            };
            let disable = at("Disable-ScheduledTask");
            let open = at("\ntry {\n");
            let catch = at(&reenable_on_failure_catch());
            assert!(disable < open, "{script}");
            for guarded in ["Stop-ScheduledTask", "Stop-Process", last] {
                let index = at(guarded);
                assert!(
                    open < index && index < catch,
                    "{guarded} unguarded in\n{script}"
                );
            }
        }
        let unregister = unregister_script(&target());
        assert!(
            unregister.find("Remove-Item") > unregister.find(&reenable_on_failure_catch()),
            "{unregister}"
        );
        // Re-enabling only what existed: a first install has nothing to enable.
        assert!(
            reenable_on_failure_catch().contains(
                "if ($task) { Enable-ScheduledTask -TaskName 'DevRoundsExecutor' -ErrorAction SilentlyContinue | Out-Null }\nthrow"
            ),
            "{}",
            reenable_on_failure_catch()
        );
    }

    #[test]
    fn the_process_running_the_script_is_never_stopped() {
        let script = stop_processes_script(&target());
        assert!(script.contains("$_.ProcessId -ne 4242"), "{script}");
    }

    /// `canonicalize` answers `\\?\` paths; the task's paths and the
    /// `ExecutablePath` they are compared with are plain ones.
    #[test]
    fn verbatim_prefixes_are_stripped() {
        assert_eq!(
            plain(PathBuf::from(r"\\?\C:\Users\me\.devrounds\executor")),
            PathBuf::from(r"C:\Users\me\.devrounds\executor")
        );
        assert_eq!(
            plain(PathBuf::from(r"\\?\UNC\server\share\executor")),
            PathBuf::from(r"\\server\share\executor")
        );
        assert_eq!(
            plain(PathBuf::from(r"C:\plain")),
            PathBuf::from(r"C:\plain")
        );
    }

    /// Remove-Item cannot delete a running binary and is told to be silent,
    /// so uninstall checks the copy is gone itself.
    #[test]
    fn a_copy_left_after_uninstall_answers_dr552() -> io::Result<()> {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
        std::fs::create_dir_all(&parent)?;
        let temp = tempfile::tempdir_in(&parent)?;
        let mut target = target();
        target.exe = temp.path().join(EXE_NAME);
        assert!(check_removed(&target).is_ok());
        std::fs::write(&target.exe, "x")?;
        let error = check_removed(&target).expect_err("the copy is still there");
        assert_eq!(error.code, "DR552");
        assert_eq!(error.data["path"], target.exe.to_string_lossy().as_ref());
        Ok(())
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
        // The `try` around it is not a condition.
        let opened = before
            .iter()
            .filter(|line| line.ends_with('{') && **line != "try {")
            .count();
        let closed = before.iter().filter(|line| **line == "}").count();
        assert_eq!(opened, closed, "{script}");
        assert!(
            script
                .contains("Unregister-ScheduledTask -TaskName 'DevRoundsExecutor' -Confirm:$false")
        );
    }
}
