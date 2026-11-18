//! `tree-fixture`: a process tree with known shape, output, memory and
//! Ctrl-C behaviour, for the executor's live tests.
//!
//! ```text
//! tree-fixture [--children N] [--depth D] [--run-ms MS] [--linger-ms MS]
//!              [--print N] [--steps NAME,...] [--print-env] [--exit CODE]
//!              [--alloc-mb MB [--touch] [--alloc-hold-ms MS]]
//!              [--ctrl-c ignore|bye] [--ready] [--breakaway]
//! ```
//!
//! - `--children N --depth D`: every process above depth `D` starts `N`
//!   children of this same program, so the tree has `1 + N + ... + N^D`
//!   processes (`--depth` defaults to 1). Children inherit the console and
//!   the standard handles; they print nothing but `ready` and `bye`.
//! - `--run-ms MS`: the leader keeps running `MS` ms after its output.
//!   Without it the leader exits right away, unless `--ctrl-c` is given,
//!   which keeps it running until Ctrl-C.
//! - `--linger-ms MS`: children outlive the leader by `MS` ms (they run
//!   `--run-ms + MS`); under a leader that runs until Ctrl-C they do too.
//! - `--print N`: the leader prints `line 1` to `line N` on stdout.
//! - `--steps a,b`: the leader prints `::devrounds::step-start name=a` then
//!   `::devrounds::step-end name=a outcome=finished` per name.
//! - `--print-env`: the leader prints its environment as sorted `NAME=value`
//!   lines.
//! - `--exit CODE`: the leader's exit code (default 0); children exit 0.
//! - `--alloc-mb MB`: every process of the tree commits `MB` MiB
//!   (`MB << 20` bytes) of private memory without touching it; `--touch`
//!   also writes every page, so it is in the working set too.
//!   `--alloc-hold-ms MS` frees it after `MS` ms; without it the memory is
//!   held until exit.
//! - `--ctrl-c ignore`: every process ignores Ctrl-C. `--ctrl-c bye`: every
//!   process prints `bye` on Ctrl-C and exits 0.
//! - `--ready`: every process prints `ready` once its Ctrl-C handler (with
//!   `--ctrl-c`) is installed, so a test can wait for the whole tree instead
//!   of sleeping.
//! - `--breakaway`: the leader starts a child with `CREATE_BREAKAWAY_FROM_JOB`
//!   and prints `breakaway: denied` when Windows refuses it,
//!   `breakaway: allowed` when it starts.
//!
//! Exits 2 on an unknown or malformed argument.

use std::{
    io::{self, Write},
    process::{Command, ExitCode},
    time::Duration,
};

/// `CREATE_BREAKAWAY_FROM_JOB`.
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
/// `ERROR_ACCESS_DENIED`, which `CreateProcess` returns when the job does
/// not allow breakaway.
const ERROR_ACCESS_DENIED: i32 = 5;

/// What to do on Ctrl-C.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CtrlC {
    Ignore,
    Bye,
}

impl CtrlC {
    /// The `--ctrl-c` value.
    fn name(self) -> &'static str {
        match self {
            Self::Ignore => "ignore",
            Self::Bye => "bye",
        }
    }
}

/// Parsed arguments.
#[derive(Debug)]
struct Args {
    children: u32,
    depth: u32,
    run_ms: Option<u64>,
    linger_ms: u64,
    print: u64,
    steps: Vec<String>,
    print_env: bool,
    exit: u8,
    alloc_mb: usize,
    touch: bool,
    alloc_hold_ms: Option<u64>,
    ctrl_c: Option<CtrlC>,
    ready: bool,
    breakaway: bool,
    /// Set on the children this program starts.
    child: bool,
}

/// Parses `value` given for `flag`.
fn number<T: std::str::FromStr>(flag: &str, value: &str) -> Result<T, String> {
    value
        .parse()
        .map_err(|_| format!("{flag}: bad number {value:?}"))
}

/// Parses `args`; `Err` names the offending argument.
fn parse(args: impl IntoIterator<Item = String>) -> Result<Args, String> {
    let mut parsed = Args {
        children: 0,
        depth: 1,
        run_ms: None,
        linger_ms: 0,
        print: 0,
        steps: Vec::new(),
        print_env: false,
        exit: 0,
        alloc_mb: 0,
        touch: false,
        alloc_hold_ms: None,
        ctrl_c: None,
        ready: false,
        breakaway: false,
        child: false,
    };
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--children" => parsed.children = number(&flag, &value()?)?,
            "--depth" => parsed.depth = number(&flag, &value()?)?,
            "--run-ms" => parsed.run_ms = Some(number(&flag, &value()?)?),
            "--linger-ms" => parsed.linger_ms = number(&flag, &value()?)?,
            "--print" => parsed.print = number(&flag, &value()?)?,
            "--steps" => {
                parsed.steps = value()?
                    .split(',')
                    .filter(|step| !step.is_empty())
                    .map(str::to_owned)
                    .collect();
            }
            "--print-env" => parsed.print_env = true,
            "--exit" => parsed.exit = number(&flag, &value()?)?,
            "--alloc-mb" => parsed.alloc_mb = number(&flag, &value()?)?,
            "--touch" => parsed.touch = true,
            "--alloc-hold-ms" => parsed.alloc_hold_ms = Some(number(&flag, &value()?)?),
            "--ctrl-c" => {
                parsed.ctrl_c = Some(match value()?.as_str() {
                    "ignore" => CtrlC::Ignore,
                    "bye" => CtrlC::Bye,
                    other => {
                        return Err(format!("--ctrl-c: expected ignore or bye, got {other:?}"));
                    }
                });
            }
            "--ready" => parsed.ready = true,
            "--breakaway" => parsed.breakaway = true,
            "--child" => parsed.child = true,
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(parsed)
}

fn main() -> ExitCode {
    let args = match parse(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("tree-fixture: {error}; see the usage in tree-fixture.rs");
            return ExitCode::from(2);
        }
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();
    let result = runtime.and_then(|runtime| runtime.block_on(run(args)));
    match result {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("tree-fixture: {error}");
            ExitCode::from(1)
        }
    }
}

/// Builds the tree, prints, holds memory and waits as `args` say; returns
/// the exit code.
async fn run(args: Args) -> io::Result<u8> {
    // Installed first, so a stop arriving while the tree starts is handled.
    let mut ctrl_c = match args.ctrl_c {
        Some(_) => Some(tokio::signal::windows::ctrl_c()?),
        None => None,
    };
    if args.ready {
        let mut out = io::stdout().lock();
        writeln!(out, "ready")?;
        out.flush()?;
    }
    let memory = allocate(args.alloc_mb, args.touch);
    let held = match args.alloc_hold_ms {
        Some(hold) => {
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(hold)).await;
                drop(memory);
            });
            None
        }
        None => Some(memory),
    };

    // The leader runs `--run-ms`, or until Ctrl-C when it handles Ctrl-C;
    // children are told their lifetime explicitly.
    let lifetime = match (args.run_ms, args.ctrl_c) {
        (Some(ms), _) => Some(Duration::from_millis(ms)),
        (None, Some(_)) => None,
        (None, None) => Some(Duration::ZERO),
    };
    if args.depth > 0 {
        let child_lifetime = if args.child {
            lifetime
        } else {
            lifetime.map(|run| run + Duration::from_millis(args.linger_ms))
        };
        for _ in 0..args.children {
            start_child(&args, child_lifetime)?;
        }
    }
    if !args.child {
        leader_output(&args)?;
    }

    let deadline = async {
        match lifetime {
            Some(run) => tokio::time::sleep(run).await,
            None => std::future::pending().await,
        }
    };
    tokio::pin!(deadline);
    loop {
        let interrupted = async {
            match &mut ctrl_c {
                Some(signal) => signal.recv().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            () = &mut deadline => break,
            Some(()) = interrupted => {
                if args.ctrl_c == Some(CtrlC::Bye) {
                    let mut out = io::stdout().lock();
                    writeln!(out, "bye")?;
                    out.flush()?;
                    return Ok(0);
                }
            }
        }
    }
    drop(held);
    Ok(if args.child { 0 } else { args.exit })
}

/// What the leader prints: environment, lines, steps, the breakaway result.
fn leader_output(args: &Args) -> io::Result<()> {
    let mut out = io::stdout().lock();
    if args.print_env {
        let mut vars: Vec<(String, String)> = std::env::vars().collect();
        vars.sort();
        for (name, value) in vars {
            writeln!(out, "{name}={value}")?;
        }
    }
    for line in 1..=args.print {
        writeln!(out, "line {line}")?;
    }
    for step in &args.steps {
        writeln!(out, "::devrounds::step-start name={step}")?;
        writeln!(out, "::devrounds::step-end name={step} outcome=finished")?;
    }
    if args.breakaway {
        writeln!(out, "breakaway: {}", try_breakaway())?;
    }
    out.flush()
}

/// Commits `mb` MiB, writing every page when `touch` is set.
fn allocate(mb: usize, touch: bool) -> Vec<u8> {
    let bytes = mb << 20;
    let mut memory = Vec::with_capacity(bytes);
    if touch {
        memory.resize(bytes, 1);
    }
    std::hint::black_box(memory)
}

/// Starts one child a level down that lives `lifetime` (until Ctrl-C when
/// `None`) and copies the memory and Ctrl-C behaviour.
fn start_child(args: &Args, lifetime: Option<Duration>) -> io::Result<()> {
    let mut command = Command::new(std::env::current_exe()?);
    command.arg("--child");
    command.args(["--children", &args.children.to_string()]);
    command.args(["--depth", &(args.depth - 1).to_string()]);
    if let Some(run) = lifetime {
        command.args(["--run-ms", &run.as_millis().to_string()]);
    }
    if let Some(ctrl_c) = args.ctrl_c {
        command.args(["--ctrl-c", ctrl_c.name()]);
    }
    if args.ready {
        command.arg("--ready");
    }
    if args.alloc_mb > 0 {
        command.args(["--alloc-mb", &args.alloc_mb.to_string()]);
        if args.touch {
            command.arg("--touch");
        }
        if let Some(hold) = args.alloc_hold_ms {
            command.args(["--alloc-hold-ms", &hold.to_string()]);
        }
    }
    // Not waited for: the child is on its own, as real descendants are.
    command.spawn().map(drop)
}

/// Tries to start a child outside this process's job; `denied`, `allowed`
/// or the unexpected error.
fn try_breakaway() -> String {
    use std::os::windows::process::CommandExt;
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => return format!("error {error}"),
    };
    let started = Command::new(exe)
        .args(["--child", "--run-ms", "0"])
        .creation_flags(CREATE_BREAKAWAY_FROM_JOB)
        .spawn();
    match started {
        Ok(mut child) => {
            let _ = child.wait();
            "allowed".into()
        }
        Err(error) if error.raw_os_error() == Some(ERROR_ACCESS_DENIED) => "denied".into(),
        Err(error) => format!("error {error}"),
    }
}
