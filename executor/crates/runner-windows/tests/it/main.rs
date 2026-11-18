//! Live runs of the Windows runner against `cmd` scripts and Git's `sh.exe`.
//! The upstream stop, orphan and tree tests drove devlanes' `fixture-server`,
//! which was not copied; they come back on DevRounds' own tree fixture (see
//! `executor/NOTICE`).
#![cfg(windows)]

use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use devrounds_core::{Error, ExitOutcome, LaunchSpec, OutputChunk, OutputStream, Unit};
use devrounds_runner_windows::{
    ConsoleHelper, HELPER_ARG, StderrMode, WindowsRunner, WindowsUnit, console_ctrl_main,
};
use tokio::sync::broadcast::{Receiver, error::RecvError};

/// Upper bound for each test body.
const LIMIT: Duration = Duration::from_secs(60);

/// A temporary directory under Cargo's per-target temp dir, never the system one.
fn tempdir() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir")
}

/// Not a test of its own: started with [`HELPER_ARG`] among its arguments,
/// this binary is the runner's console helper, as `devrounds-executor __console-ctrl`
/// is in the shipped binary.
#[test]
fn helper_entry() {
    let args: Vec<OsString> = std::env::args_os().collect();
    if let Some(at) = args.iter().position(|arg| arg == HELPER_ARG) {
        // A test that counts helpers puts a log file's path right before the
        // marker (the test harness takes it as a filter that matches nothing).
        if let Some(log) = at
            .checked_sub(1)
            .map(|before| Path::new(&args[before]))
            .filter(|path| path.is_absolute())
        {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log)
                .expect("helper log");
            writeln!(file, "{:?}", &args[at + 1..]).expect("helper log line");
        }
        let code = console_ctrl_main(args[at + 1..].iter().cloned());
        std::process::exit(i32::from(code));
    }
}

/// The runner with this test binary as its console helper.
fn runner() -> WindowsRunner {
    let helper = ConsoleHelper {
        program: std::env::current_exe().expect("test binary path"),
        args: ["--exact", "helper_entry", "--nocapture", HELPER_ARG]
            .map(OsString::from)
            .into(),
    };
    WindowsRunner::default().with_console_helper(helper)
}

/// The variables Windows programs need to start (Winsock needs `SystemRoot`),
/// with `PATH` holding System32 and `dirs`.
fn env(dirs: &[&Path]) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = ["SystemRoot", "windir", "TEMP", "TMP", "PATHEXT"]
        .iter()
        .filter_map(|name| Some(((*name).to_owned(), std::env::var(name).ok()?)))
        .collect();
    let system = devrounds_sys_windows::file::system_directory().expect("System32");
    let path = std::env::join_paths(dirs.iter().map(|dir| dir.to_path_buf()).chain([system]))
        .expect("PATH");
    env.insert("PATH".into(), path.to_string_lossy().into_owned());
    env
}

/// A pipe-mode spec started in `cwd`.
/// A spec started in `cwd`.
fn spec(program: &str, args: &[&str], cwd: &Path, env: BTreeMap<String, String>) -> LaunchSpec {
    LaunchSpec {
        program: program.into(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        cwd: cwd.to_path_buf(),
        env,
    }
}

/// The code of the runner's refusal inside `error`, if it is one.
fn refusal(error: &Error) -> Option<&'static str> {
    let Error::Io(io) = error else { return None };
    io.get_ref()?
        .downcast_ref::<devrounds_core::SpawnRefusal>()
        .map(|refusal| refusal.code)
}

/// Writes a batch file and returns its path.
fn script(dir: &Path, name: &str, lines: &[&str]) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, lines.join("\r\n") + "\r\n").expect("script");
    path
}

/// Ends the unit's job when the test is done, passed or failed.
struct Cleanup(Arc<WindowsUnit>);

impl Drop for Cleanup {
    fn drop(&mut self) {
        self.0.terminate();
    }
}

/// Every chunk until the channel closes.
async fn drain(mut output: Receiver<OutputChunk>) -> Vec<OutputChunk> {
    let mut chunks = Vec::new();
    loop {
        match output.recv().await {
            Ok(chunk) => chunks.push(chunk),
            Err(RecvError::Lagged(_)) => {}
            Err(RecvError::Closed) => return chunks,
        }
    }
}

/// The text of `chunks` from `stream`.
fn text(chunks: &[OutputChunk], stream: OutputStream) -> String {
    chunks
        .iter()
        .filter(|chunk| chunk.stream == stream)
        .map(|chunk| String::from_utf8_lossy(&chunk.bytes).into_owned())
        .collect()
}

/// Runs `body` with the test's time limit.
async fn bounded(body: impl Future<Output = ()>) {
    tokio::time::timeout(LIMIT, body).await.expect("bounded");
}

/// stdout and stderr arrive tagged, or merged as stdout, and the exit code is
/// reported. The script is found on `PATH` through `PATHEXT`.
#[tokio::test]
async fn output_and_exit_code() {
    bounded(async {
        let dir = tempdir();
        script(
            dir.path(),
            "talk.cmd",
            &["@echo out", "@>&2 echo err", "@exit /b 3"],
        );
        let spec = || spec("talk", &[], dir.path(), env(&[dir.path()]));

        let unit = runner().spawn_unit(spec()).await.expect("spawn");
        let _cleanup = Cleanup(unit.clone());
        let chunks = drain(unit.output()).await;
        let report = unit.wait_report().await.expect("report");
        assert_eq!(report.outcome.code, Some(3));
        assert_eq!(report.stop, None);
        assert!(text(&chunks, OutputStream::Stdout).contains("out"));
        assert!(text(&chunks, OutputStream::Stderr).contains("err"));

        let merged = runner()
            .with_stderr(StderrMode::Merged)
            .spawn_unit(spec())
            .await
            .expect("spawn");
        let _cleanup = Cleanup(merged.clone());
        let chunks = drain(merged.output()).await;
        assert!(chunks.iter().all(|c| c.stream == OutputStream::Stdout));
        let all = text(&chunks, OutputStream::Stdout);
        assert!(all.contains("out") && all.contains("err"), "{all}");
        assert_eq!(merged.wait().await.expect("exit").code, Some(3));
    })
    .await;
}

/// Batch arguments get std's escaping, so `cmd.exe` does not run what follows
/// an `&`, and a line break is refused with a typed error.
#[tokio::test]
async fn batch_arguments_are_escaped_or_refused() {
    bounded(async {
        let dir = tempdir();
        // `%1` keeps the quotes the escaping added; `%~1` would strip them and
        // let the script itself run what follows the `&`.
        script(dir.path(), "args.cmd", &["@echo [%1]"]);
        let env = || env(&[dir.path()]);
        let unit = runner()
            .spawn_unit(spec("args", &["a&echo injected"], dir.path(), env()))
            .await
            .expect("spawn");
        let _cleanup = Cleanup(unit.clone());
        let output = text(&drain(unit.output()).await, OutputStream::Stdout);
        assert_eq!(output.trim(), r#"["a&echo injected"]"#);

        let error = runner()
            .spawn_unit(spec("args", &["a\nb"], dir.path(), env()))
            .await
            .expect_err("refused");
        assert_eq!(refusal(&error), Some("unsafe_batch_argument"), "{error:?}");
        assert!(error.to_string().contains("batch file"), "{error}");
    })
    .await;
}

/// Spawn failures come back as errors without starting anything: a missing
/// program or directory as I/O errors, a missing shell or an overlong
/// working directory as typed refusals.
#[tokio::test]
async fn spawn_failures_are_typed() {
    bounded(async {
        let dir = tempdir();
        let missing = runner()
            .spawn_unit(spec("no-such-tool", &[], dir.path(), env(&[dir.path()])))
            .await
            .expect_err("missing program");
        assert!(
            matches!(&missing, Error::Io(io) if io.kind() == std::io::ErrorKind::NotFound),
            "{missing:?}"
        );
        assert_eq!(refusal(&missing), Some("not_found"));

        let tool = script(dir.path(), "tool.cmd", &["@exit /b 0"]);
        let tool = tool.to_string_lossy().into_owned();
        let gone = dir.path().join("gone");
        let error = runner()
            .spawn_unit(spec(&tool, &[], &gone, env(&[])))
            .await
            .expect_err("missing directory");
        assert!(matches!(error, Error::Io(_)), "{error:?}");

        let long = dir.path().join("x".repeat(300));
        let error = runner()
            .spawn_unit(spec(&tool, &[], &long, env(&[])))
            .await
            .expect_err("long directory");
        assert_eq!(refusal(&error), Some("cwd_too_long"), "{error:?}");
        assert!(error.to_string().contains("characters long"), "{error}");

        let error = runner()
            .with_shell(None)
            .spawn_unit(spec("/bin/sh", &["-c", "exit 0"], dir.path(), env(&[])))
            .await
            .expect_err("no shell");
        assert_eq!(refusal(&error), Some("shell_missing"), "{error:?}");
        assert!(error.to_string().contains("Git for Windows"), "{error}");
    })
    .await;
}

/// A shell unit finds Git's tools (`sleep`, `basename`) through the
/// directory appended to its `PATH`, which only holds System32 here.
#[tokio::test]
async fn run_strings_find_git_tools() {
    bounded(async {
        let shell = devrounds_shell_windows::windows_shell()
            .await
            .expect("Git for Windows' sh.exe");
        let dir = tempdir();
        let unit = runner()
            .with_shell(Some(shell))
            .spawn_unit(spec(
                "/bin/sh",
                &["-c", "sleep 0 && basename /a/tool"],
                dir.path(),
                env(&[]),
            ))
            .await
            .expect("spawn");
        let _cleanup = Cleanup(unit.clone());
        let output = text(&drain(unit.output()).await, OutputStream::Stdout);
        assert_eq!(output, "tool\n");
        assert_eq!(unit.wait().await.expect("exit").code, Some(0));
    })
    .await;
}

/// `/bin/sh -c` runs through Git's `sh.exe`, which receives the script
/// intact (backslashes and quotes included) and MSYS path conversion off.
/// Its exit reads as on Unix: a code, or the signal that killed the shell.
#[tokio::test]
async fn run_strings_go_through_git_sh() {
    bounded(async {
        let shell = devrounds_shell_windows::windows_shell()
            .await
            .expect("Git for Windows' sh.exe");
        let dir = tempdir();
        let script = r#"printf '[%s]\n' 'a\b' "q\"q" "$MSYS_NO_PATHCONV" /c/x
exit 4"#;
        let unit = runner()
            .with_shell(Some(shell.clone()))
            .spawn_unit(spec("/bin/sh", &["-c", script], dir.path(), env(&[])))
            .await
            .expect("spawn");
        let _cleanup = Cleanup(unit.clone());
        let output = text(&drain(unit.output()).await, OutputStream::Stdout);
        assert_eq!(output, "[a\\b]\n[q\"q]\n[1]\n[/c/x]\n");
        assert_eq!(unit.wait().await.expect("exit").code, Some(4));

        let unit = runner()
            .with_shell(Some(shell.clone()))
            .spawn_unit(spec(
                "/bin/sh",
                &["-c", "kill -INT $$"],
                dir.path(),
                env(&[]),
            ))
            .await
            .expect("spawn");
        let _cleanup = Cleanup(unit.clone());
        assert_eq!(
            unit.wait().await.expect("exit"),
            ExitOutcome {
                code: None,
                signal: Some(2)
            }
        );

        // An explicit list naming Git's `sh.exe` gets its arguments exactly:
        // `*` is not expanded against the folder's files.
        std::fs::write(dir.path().join("acme.txt"), "").expect("file");
        let unit = runner()
            .spawn_unit(spec(
                &shell.to_string_lossy(),
                &["-c", r#"printf '%s\n' "$1""#, "sh", "*"],
                dir.path(),
                env(&[]),
            ))
            .await
            .expect("spawn");
        let _cleanup = Cleanup(unit.clone());
        let output = text(&drain(unit.output()).await, OutputStream::Stdout);
        assert_eq!(output, "*\n");
    })
    .await;
}
