//! `devrounds-executor`: runs DevRounds jobs on this machine. Later tasks add
//! `run`, `supervise` and `service`.

#[cfg(windows)]
use std::ffi::OsString;
use std::process::ExitCode;

const USAGE: &str = "usage: devrounds-executor pair --url <url> --code <code> | version";

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let first = args.next();
    // The hidden helper the Windows runner starts to send a console event to a
    // run's console; it must not parse anything else or touch stdout.
    #[cfg(windows)]
    if first
        .as_deref()
        .is_some_and(|arg| arg == devrounds_runner_windows::HELPER_ARG)
    {
        return ExitCode::from(devrounds_runner_windows::console_ctrl_main(args));
    }
    // Before any run is spawned: runs inherit this process's ignore-Ctrl-C
    // flag. A failure only costs graceful Ctrl-C stops, so it is not fatal.
    #[cfg(windows)]
    if let Err(error) = devrounds_runner_windows::prepare_executor_process() {
        eprintln!("devrounds-executor: clearing the ignore-Ctrl-C flag failed: {error}");
    }
    match first.as_deref().and_then(|arg| arg.to_str()) {
        Some("version") => {
            println!("devrounds-executor {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        #[cfg(windows)]
        Some("pair") => pair(args.collect()),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

/// `pair --url <url> --code <code>`: pairs this machine into the tenant that
/// made the code.
#[cfg(windows)]
fn pair(args: Vec<OsString>) -> ExitCode {
    let mut url = None;
    let mut code = None;
    let mut args = args.into_iter().map(|arg| arg.into_string());
    while let Some(arg) = args.next() {
        let value = args.next().and_then(Result::ok);
        match (arg.as_deref(), value) {
            (Ok("--url"), Some(value)) => url = Some(value),
            (Ok("--code"), Some(value)) => code = Some(value),
            _ => {
                eprintln!("{USAGE}");
                return ExitCode::from(2);
            }
        }
    }
    let (Some(url), Some(code)) = (url, code) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let paired = devrounds_executor::config::executor_home().and_then(|home| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| {
                devrounds_core::DrError::new(
                    "DR501",
                    serde_json::json!({ "reason": format!("tokio runtime: {error}") }),
                )
            })?;
        runtime
            .block_on(devrounds_executor::pair::pair(&home, &url, &code))
            .map(|()| home)
    });
    match paired {
        Ok(home) => {
            println!("paired; wrote {}", home.display());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}\nsee docs/errors.md");
            ExitCode::from(exit_code(error.code))
        }
    }
}

/// The CLI exit codes of AGENTS.md by code range: 1 conflict, 2 input,
/// 3 not found, 5 auth, 6 internal.
#[cfg(windows)]
fn exit_code(code: &str) -> u8 {
    match code.as_bytes().get(2) {
        Some(b'1') => 2,
        Some(b'2') => 3,
        Some(b'3') => 1,
        Some(b'4') => 5,
        _ => 6,
    }
}
