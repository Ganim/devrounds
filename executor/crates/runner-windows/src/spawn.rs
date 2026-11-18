//! Blocking start of a unit's leader inside a new job.

use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{self, Seek, SeekFrom},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsHandle},
    path::{Path, PathBuf},
};

use devrounds_core::{LaunchSpec, RunOutput};
use devrounds_sys_windows::{
    job::{Job, JobOptions},
    spawn::{self as win, Child, CreationFlags, EnvError, Environment, Spawn, Stdio, Stream},
};

use crate::{
    command::{self, CommandError},
    exit::Leader,
    runtime::Runtimes,
};

/// The program `run:` strings and `ready.cmd` resolve to on every OS.
pub(crate) const POSIX_SHELL: &str = "/bin/sh";

/// Working directories this long or longer are refused: `cmd.exe` cannot use
/// them and runs batch files from the Windows directory instead.
const MAX_CWD: usize = 260;

/// Why a unit could not start. Converted to [`devrounds_core::Error`] at the
/// runner boundary; [`SpawnError::code`] names the case.
#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    /// The unit runs through `/bin/sh` and no Git for Windows `sh.exe` was found.
    #[error(
        "`run:` strings and `/bin/sh` need Git for Windows' sh.exe, and no `git` on PATH has one; install Git for Windows and restart the daemon"
    )]
    ShellMissing,
    /// The working directory is too long for `cmd.exe`.
    #[error(
        "the working directory {} is {length} characters long; Windows units need one shorter than {MAX_CWD}",
        cwd.display()
    )]
    CwdTooLong { cwd: PathBuf, length: usize },
    /// The program was not found on the unit's `PATH` or at its path.
    #[error("{} not found", program.display())]
    NotFound {
        program: PathBuf,
        searched: Vec<PathBuf>,
    },
    /// An argument for a `.bat` or `.cmd` program that `cmd.exe` would cut
    /// short or misread.
    #[error("argument {0:?} cannot be passed to a batch file safely")]
    UnsafeBatchArgument(String),
    /// The program cannot be resolved or started as given.
    #[error("{0}")]
    InvalidCommand(String),
    /// The environment cannot be passed to a Windows process.
    #[error(transparent)]
    Environment(#[from] EnvError),
    /// Opening the output files, creating the job or the process failed.
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl SpawnError {
    /// A stable name for the case: `shell_missing`, `cwd_too_long`,
    /// `not_found`, `unsafe_batch_argument`, `invalid_command`,
    /// `invalid_environment` or `io`.
    pub fn code(&self) -> &'static str {
        match self {
            Self::ShellMissing => "shell_missing",
            Self::CwdTooLong { .. } => "cwd_too_long",
            Self::NotFound { .. } => "not_found",
            Self::UnsafeBatchArgument(_) => "unsafe_batch_argument",
            Self::InvalidCommand(_) => "invalid_command",
            Self::Environment(_) => "invalid_environment",
            Self::Io(_) => "io",
        }
    }
}

impl From<CommandError> for SpawnError {
    /// Keeps the cases callers act on apart.
    fn from(error: CommandError) -> Self {
        match error {
            CommandError::NotFound { program, searched } => Self::NotFound { program, searched },
            CommandError::ArgumentNotSafeForBatch(arg) => Self::UnsafeBatchArgument(arg),
            other @ (CommandError::ContainsNul(_) | CommandError::InvalidProgram(_)) => {
                Self::InvalidCommand(other.to_string())
            }
        }
    }
}

impl From<SpawnError> for devrounds_core::Error {
    /// A failed creation stays the OS error, so the daemon classifies it as it
    /// does on Unix. Every other case is an I/O error (`NotFound` for a
    /// missing program, `InvalidInput` for refusals) whose source is a
    /// [`devrounds_core::SpawnRefusal`] with the case's code, which the daemon
    /// reports as the `spawn_failed` reason.
    fn from(error: SpawnError) -> Self {
        let kind = match error {
            SpawnError::Io(error) => return Self::Io(error),
            SpawnError::NotFound { .. } => io::ErrorKind::NotFound,
            _ => io::ErrorKind::InvalidInput,
        };
        let refusal = devrounds_core::SpawnRefusal {
            code: error.code(),
            message: error.to_string(),
            searched: match error {
                SpawnError::NotFound { searched, .. } => searched,
                _ => Vec::new(),
            },
        };
        Self::Io(io::Error::new(kind, refusal))
    }
}

/// A started leader in its job.
pub(crate) struct Launched {
    pub child: Child,
    pub job: Job,
    /// What the leader is, which decides how its exit code reads.
    pub leader_kind: Leader,
}

/// `FILE_SHARE_READ`: log readers may open the output files while the run
/// writes them; nobody else may write or delete them meanwhile.
const FILE_SHARE_READ: u32 = 0x1;

/// Opens one run output file for writing at its end, creating it when
/// missing.
///
/// Not an append-only handle (`FILE_APPEND_DATA` without `FILE_WRITE_DATA`):
/// MSYS programs, Git's `sh.exe` among them, write nothing to one and exit
/// with 1, and every `run:` string goes through `sh.exe`. A write handle
/// positioned at the end appends just as well for well-behaved writers: the
/// leader and every descendant inherit this one handle, so they share its
/// file position, and Windows serialises their writes on it. The trade: a
/// member can now seek or truncate the shared handle and overwrite earlier
/// output, which append-only would have refused. Share-read still keeps any
/// other writer out.
fn open_output(path: &Path) -> io::Result<File> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)?;
    file.seek(SeekFrom::End(0))?;
    Ok(file)
}

/// The run's stdout and stderr files; one file for both when the paths are
/// equal (a second open would violate the first one's sharing).
fn open_outputs(output: &RunOutput) -> io::Result<(File, Option<File>)> {
    let stdout = open_output(&output.stdout)?;
    let stderr = if output.stderr == output.stdout {
        None
    } else {
        Some(open_output(&output.stderr)?)
    };
    Ok((stdout, stderr))
}

/// Starts `spec`'s leader in a new job. Blocking: call from `spawn_blocking`.
///
/// The job lets no process leave, ends a crashing member at once, and does
/// not end its members when closed, so units outlive the executor. The
/// leader gets `NUL` as stdin and the run's output files as stdout and
/// stderr; this process closes its copies once the leader holds them, so it
/// never sits between the run and its output. Nothing that fails before
/// `CreateProcessW` succeeded leaves a job or a process behind (the output
/// files may exist by then). The leader is [`Leader::Msys`] when `runtimes`
/// says the resolved program links the MSYS runtime, else [`Leader::Native`].
pub(crate) fn launch(
    spec: LaunchSpec,
    shell: Option<&Path>,
    runtimes: &Runtimes,
) -> Result<Launched, SpawnError> {
    let through_shell = spec.program == POSIX_SHELL;
    let mut env = spec.env;
    let program = if through_shell {
        let shell = shell.ok_or(SpawnError::ShellMissing)?;
        devrounds_shell_windows::shell_env(&mut env, shell);
        shell.to_string_lossy().into_owned()
    } else {
        spec.program
    };
    let length = spec.cwd.as_os_str().encode_wide().count();
    if length >= MAX_CWD {
        return Err(SpawnError::CwdTooLong {
            cwd: spec.cwd,
            length,
        });
    }
    let env = child_env(env);
    let system = devrounds_sys_windows::file::system_directory()?;
    let command = command::build(&program, &spec.args, &env, &spec.cwd, &system, runtimes)?;
    let leader_kind = if command.msys {
        Leader::Msys
    } else {
        Leader::Native
    };
    let environment = Environment::new(&env)?;
    let (stdout, stderr) = open_outputs(&spec.output)?;
    let job = Job::create(JobOptions {
        kill_on_close: false,
        die_on_unhandled_exception: true,
    })?;
    let child = win::spawn(&Spawn {
        program: &command.application,
        command_line: &command.command_line,
        environment: Some(&environment),
        cwd: Some(&spec.cwd),
        stdio: Stdio::Handles {
            stdin: Stream::Null,
            stdout: Stream::Handle(stdout.as_handle()),
            stderr: Stream::Handle(stderr.as_ref().unwrap_or(&stdout).as_handle()),
        },
        inherit: &[],
        job: Some(&job),
        // Hidden: a console without a window, which descendants share. No
        // process group of its own: Windows starts a new group ignoring
        // Ctrl-C, and the console is the run's alone anyway. The leader
        // inherits this process's ignore-Ctrl-C flag, which
        // `prepare_executor_process` clears at startup.
        flags: CreationFlags {
            no_window: true,
            ..CreationFlags::default()
        },
    })?;
    // The run owns its output from here; the files close on our side as
    // `stdout` and `stderr` drop.
    Ok(Launched {
        child,
        job,
        leader_kind,
    })
}

/// A child's environment from `env`: the `=C:`-style per-drive directory
/// entries are dropped (a block cannot carry names starting with `=`), and
/// names equal ignoring case keep the value of the one sorting last (Windows
/// has one variable for both). Shell units get the shell's variables from
/// [`devrounds_shell_windows::shell_env`] before this.
pub(crate) fn child_env(env: BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut folded: BTreeMap<String, (String, String)> = BTreeMap::new();
    for (name, value) in env {
        if name.starts_with('=') {
            continue;
        }
        folded.insert(devrounds_core::env::fold_name(name.clone()), (name, value));
    }
    folded.into_values().collect()
}

/// Whether `name` is the console host Windows starts for a console; the unit's
/// own one is a member of its job.
pub(crate) fn is_console_host(name: &str) -> bool {
    name.eq_ignore_ascii_case("conhost.exe")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive entries go, case duplicates collapse to the last spelling, and
    /// shell units get the MSYS variables over any of their own plus Git's
    /// tools at the end of `PATH`.
    #[test]
    fn environment_rules() {
        let env = BTreeMap::from([
            ("=C:".to_owned(), r"C:\work".to_owned()),
            ("PATH".to_owned(), r"C:\a".to_owned()),
            ("Path".to_owned(), r"C:\b".to_owned()),
            ("msys_no_pathconv".to_owned(), "0".to_owned()),
            ("HOME".to_owned(), r"C:\Users\acme".to_owned()),
        ]);
        let native = child_env(env.clone());
        assert_eq!(
            native,
            BTreeMap::from([
                ("HOME".to_owned(), r"C:\Users\acme".to_owned()),
                ("Path".to_owned(), r"C:\b".to_owned()),
                ("msys_no_pathconv".to_owned(), "0".to_owned()),
            ])
        );
        assert!(Environment::new(&native).is_ok());
        let mut shell = child_env(env);
        devrounds_shell_windows::shell_env(&mut shell, Path::new(r"C:\Git\usr\bin\sh.exe"));
        let shell = child_env(shell);
        assert_eq!(shell.get("MSYS_NO_PATHCONV").map(String::as_str), Some("1"));
        assert_eq!(
            shell.get("MSYS2_ARG_CONV_EXCL").map(String::as_str),
            Some("*")
        );
        assert!(!shell.contains_key("msys_no_pathconv"));
        assert_eq!(
            shell.get("Path").map(String::as_str),
            Some(r"C:\b;C:\Git\usr\bin")
        );
        assert!(Environment::new(&shell).is_ok());
    }

    /// Every case but a failed creation reaches the daemon as an I/O error
    /// whose source names the case; a missing program keeps the `NotFound`
    /// kind and the directories searched.
    #[test]
    fn errors_convert() {
        let refusal = |error: SpawnError| {
            let devrounds_core::Error::Io(io) = devrounds_core::Error::from(error) else {
                panic!("an I/O error");
            };
            let kind = io.kind();
            let refusal = io
                .into_inner()
                .and_then(|inner| inner.downcast::<devrounds_core::SpawnRefusal>().ok())
                .expect("a refusal");
            (kind, *refusal)
        };
        let (kind, shell) = refusal(SpawnError::ShellMissing);
        assert_eq!(kind, io::ErrorKind::InvalidInput);
        assert_eq!(shell.code, "shell_missing");
        assert!(
            shell.message.contains("Git for Windows"),
            "{}",
            shell.message
        );
        let missing = SpawnError::from(CommandError::NotFound {
            program: "tool".into(),
            searched: vec![r"C:\bin".into()],
        });
        assert_eq!(missing.code(), "not_found");
        let (kind, missing) = refusal(missing);
        assert_eq!(kind, io::ErrorKind::NotFound);
        assert_eq!(missing.searched, [PathBuf::from(r"C:\bin")]);
        let batch = SpawnError::from(CommandError::ArgumentNotSafeForBatch("a\nb".into()));
        assert_eq!(batch.code(), "unsafe_batch_argument");
        assert_eq!(refusal(batch).1.code, "unsafe_batch_argument");
        let os = devrounds_core::Error::from(SpawnError::Io(io::Error::from_raw_os_error(5)));
        assert!(matches!(os, devrounds_core::Error::Io(io) if io.raw_os_error() == Some(5)));
    }
}
