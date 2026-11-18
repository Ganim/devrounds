//! `devrounds-executor`: runs DevRounds jobs on this machine.

#[cfg(windows)]
use std::ffi::OsString;
use std::process::ExitCode;

#[cfg(windows)]
mod serve;

const USAGE: &str = "usage: devrounds-executor pair --url <url> --code <code> | run | supervise \
                     | service install|uninstall | version";

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
        #[cfg(windows)]
        Some("run") => match (args.next(), args.next()) {
            (None, _) => run(),
            (Some(flag), None) if flag == devrounds_executor::supervise::SUPERVISED_ARG => {
                devrounds_executor::supervise::exit_with_supervisor();
                run()
            }
            _ => usage(),
        },
        #[cfg(windows)]
        Some("supervise") if args.next().is_none() => supervise(),
        #[cfg(windows)]
        Some("service") => match (args.next(), args.next()) {
            (Some(verb), None) if verb == "install" => service(true),
            (Some(verb), None) if verb == "uninstall" => service(false),
            _ => usage(),
        },
        _ => usage(),
    }
}

fn usage() -> ExitCode {
    eprintln!("{USAGE}");
    ExitCode::from(2)
}

/// `supervise`: keeps `run --supervised` going and logs to `<home>/logs`.
#[cfg(windows)]
fn supervise() -> ExitCode {
    let prepared = devrounds_executor::config::executor_home().and_then(|home| {
        runtime()?.block_on(devrounds_executor::config::prepare_home(&home))?;
        Ok(home)
    });
    let home = match prepared {
        Ok(home) => home,
        Err(error) => return fail(&error),
    };
    let supervised = std::env::current_exe()
        .and_then(|exe| devrounds_executor::supervise::supervise(&exe, &home.join("logs")));
    match supervised {
        Err(error) => fail(&devrounds_core::DrError::new(
            "DR501",
            serde_json::json!({ "reason": format!("supervise: {error}") }),
        )),
    }
}

/// `service install` registers and starts the `DevRoundsExecutor` task for
/// a paired home; `service uninstall` stops and removes it.
#[cfg(windows)]
fn service(install: bool) -> ExitCode {
    use devrounds_executor::service::{
        TASK_NAME, current_target, register_script, run_powershell, unregister_script,
    };
    let done = devrounds_executor::config::executor_home().and_then(|home| {
        if install {
            // A task without a pairing would restart a failing `run` forever.
            runtime()?.block_on(devrounds_executor::config::load_pairing(&home))?;
        }
        let target = current_target(&home).map_err(|error| {
            devrounds_core::DrError::new(
                "DR501",
                serde_json::json!({ "reason": format!("current executable: {error}") }),
            )
        })?;
        let script = if install {
            register_script(&target)
        } else {
            unregister_script(&target)
        };
        run_powershell(&script)?;
        Ok(target)
    });
    match done {
        Ok(target) if install => {
            println!(
                "scheduled task {TASK_NAME} registered and started\nexe: {}\nlogs: {}",
                target.exe.display(),
                target.home.join("logs").display()
            );
            ExitCode::SUCCESS
        }
        Ok(_) => {
            println!("scheduled task {TASK_NAME} removed");
            ExitCode::SUCCESS
        }
        Err(error) => fail(&error),
    }
}

#[cfg(windows)]
fn runtime() -> Result<tokio::runtime::Runtime, devrounds_core::DrError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| {
            devrounds_core::DrError::new(
                "DR501",
                serde_json::json!({ "reason": format!("tokio runtime: {error}") }),
            )
        })
}

#[cfg(windows)]
fn fail(error: &devrounds_core::DrError) -> ExitCode {
    eprintln!("{error}\nsee docs/errors.md");
    ExitCode::from(exit_code(error.code))
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

/// `run`: keeps the session with the control plane and runs what it offers,
/// until the token is revoked or a newer session of this machine takes over.
#[cfg(windows)]
fn run() -> ExitCode {
    let served = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| {
            devrounds_core::DrError::new(
                "DR501",
                serde_json::json!({ "reason": format!("tokio runtime: {error}") }),
            )
        })
        .and_then(|runtime| runtime.block_on(serve::serve()));
    match served {
        Ok(()) => ExitCode::SUCCESS,
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
