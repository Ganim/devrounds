//! `devrounds-executor`: runs DevRounds jobs on this machine. Later tasks add
//! `pair`, `run`, `supervise` and `service`.

use std::process::ExitCode;

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
    match first.as_deref().and_then(|arg| arg.to_str()) {
        Some("version") => {
            println!("devrounds-executor {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: devrounds-executor version");
            ExitCode::from(2)
        }
    }
}
