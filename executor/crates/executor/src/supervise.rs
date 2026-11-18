//! `devrounds-executor supervise`: keeps `run` going. Task Scheduler only
//! restarts a task that fails to start, so crash restarts are owned here,
//! with the control plane supervisor's backoff; the task's 5-minute trigger
//! (IgnoreNew) only brings this supervisor back if it dies.
//!
//! `run` is started hidden with the read end of a pipe as its stdin, and
//! `run --supervised` exits once that pipe closes: when this supervisor dies,
//! however it dies, its `run` follows it, so the next supervisor's `run`
//! never finds the home locked by an orphan. Runs are not part of this: they
//! have no kill-on-close, so they survive both, and the next `run` reports
//! them as orphans.
//!
//! `run`'s stdout and stderr come through a pipe too, so they land in the log
//! file of the UTC day they are written, `<logs>/executor-YYYY-MM-DD.log`,
//! with the supervisor's own lines, rolling to `.1`, `.2`, ... past
//! [`MAX_LOG_BYTES`]; files older than [`KEEP_DAYS`] are pruned on every day
//! change.

use std::{
    convert::Infallible,
    ffi::OsStr,
    fs::{self, File, OpenOptions, TryLockError},
    io::{self, PipeReader, Read, Write},
    os::windows::io::AsHandle,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use devrounds_sys_windows::spawn::{self, CreationFlags, Spawn, Stdio, Stream};

/// The first restart delay, and the one after a healthy uptime.
pub const FIRST_DELAY: Duration = Duration::from_secs(1);
/// The longest restart delay.
pub const MAX_DELAY: Duration = Duration::from_secs(30);
/// A `run` that stayed up this long was healthy: its next exit starts the
/// backoff over.
pub const HEALTHY_UPTIME: Duration = Duration::from_secs(5 * 60);
/// Days of log files kept, as the control plane keeps its own.
pub const KEEP_DAYS: u64 = 14;
/// A day's log file rolls to the next `.N` past this size. The control plane
/// caps at 10 MiB; 10 MB here is the same order and reads plainly.
pub const MAX_LOG_BYTES: u64 = 10_000_000;
/// The argument `supervise` starts `run` with: watch stdin, exit at its end.
pub const SUPERVISED_ARG: &str = "--supervised";

/// The delay before the next start of `run`: 1 s, doubling up to 30 s, back
/// to 1 s after an uptime of 5 min. Same as `nextDelay` of the control
/// plane's `service/supervise.ts`.
pub fn next_delay(previous: Option<Duration>, uptime: Duration) -> Duration {
    match previous {
        Some(previous) if uptime < HEALTHY_UPTIME => previous.saturating_mul(2).min(MAX_DELAY),
        _ => FIRST_DELAY,
    }
}

/// Runs `exe run --supervised` for good, restarting it with [`next_delay`].
/// Returns only when the log directory cannot be created.
pub fn supervise(exe: &Path, logs: &Path) -> io::Result<Infallible> {
    fs::create_dir_all(logs)?;
    let log = Arc::new(DailyLog::new(logs.to_path_buf(), MAX_LOG_BYTES));
    log.line(&format!("supervisor started (pid {})", std::process::id()));
    let mut delay = None;
    loop {
        let started = Instant::now();
        let reason = match run_once(exe, &log) {
            Ok(code) => format!("exited (code {code})"),
            Err(error) => format!("failed to start: {error}"),
        };
        let uptime = started.elapsed();
        log.line(&format!("run {reason} after {} s", uptime.as_secs()));
        let next = next_delay(delay, uptime);
        delay = Some(next);
        log.line(&format!("restarting run in {} s", next.as_secs()));
        thread::sleep(next);
    }
}

/// Takes `<home>/supervise.lock`, held while the file lives; `None` when
/// another supervisor holds it. Stopping the task ends only its conhost, so
/// the task's next trigger starts a `supervise` beside the running one; that
/// one exits on `None` instead of crash looping a second `run` on DR352.
pub fn lock_supervisor(home: &Path) -> io::Result<Option<File>> {
    let file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(home.join("supervise.lock"))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

/// Starts `run` and waits for it; its exit code.
fn run_once(exe: &Path, log: &Arc<DailyLog>) -> io::Result<u32> {
    let program = exe.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "the executor path is not Unicode",
        )
    })?;
    let line = format!("{} run {SUPERVISED_ARG}", spawn::quote_arg(program));
    let (stdin_read, stdin_write) = spawn::pipe()?;
    let (output_read, output_write) = spawn::pipe()?;
    let child = spawn::spawn(&Spawn {
        program: exe,
        command_line: OsStr::new(&line),
        environment: None,
        cwd: None,
        stdio: Stdio::Handles {
            stdin: Stream::Handle(stdin_read.as_handle()),
            stdout: Stream::Handle(output_write.as_handle()),
            stderr: Stream::Handle(output_write.as_handle()),
        },
        inherit: &[],
        job: None,
        // A console of its own without a window, like every spawn of the
        // executor; runs and the console helper get their own hidden ones.
        flags: CreationFlags {
            no_window: true,
            ..CreationFlags::default()
        },
    })?;
    // Only `run` holds these ends now: its output ends when it exits.
    drop(stdin_read);
    drop(output_write);
    log.line(&format!("run started (pid {})", child.pid()));
    let pump = {
        let log = Arc::clone(log);
        thread::spawn(move || pump(output_read, &log))
    };
    let code = child.wait();
    // Held until `run` is gone: closing it is what tells `run` to exit.
    drop(stdin_write);
    let _ = pump.join();
    code
}

/// Copies `run`'s output into the day's log until it ends.
fn pump(mut output: PipeReader, log: &DailyLog) {
    let mut buffer = [0_u8; 8192];
    loop {
        match output.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(read) => log.write(&buffer[..read]),
        }
    }
}

/// `--supervised`: exits this process once stdin, the supervisor's pipe,
/// ends. On a dedicated thread, since the read blocks.
pub fn exit_with_supervisor() {
    thread::spawn(|| {
        let mut buffer = [0_u8; 64];
        let mut stdin = io::stdin();
        // Nothing is ever written: any read result but data means the
        // supervisor is gone.
        while matches!(stdin.read(&mut buffer), Ok(read) if read > 0) {}
        // Not eprintln!: stderr is the supervisor's pipe too, so the write
        // fails, and eprintln! would panic this thread before the exit.
        let _ = writeln!(io::stderr(), "devrounds-executor: supervisor gone; exiting");
        std::process::exit(0);
    });
}

/// Appends to `<dir>/executor-<UTC day>[.N].log`, reopening per write so a
/// day change starts the next file; a failed write is dropped, as there is
/// nowhere else to report it.
struct DailyLog {
    dir: PathBuf,
    max_bytes: u64,
    state: Mutex<LogState>,
}

/// Where the next write goes: the day, the file's suffix and its size.
#[derive(Default)]
struct LogState {
    day: Option<String>,
    seq: u32,
    size: u64,
}

impl DailyLog {
    fn new(dir: PathBuf, max_bytes: u64) -> Self {
        Self {
            dir,
            max_bytes,
            state: Mutex::new(LogState::default()),
        }
    }

    fn line(&self, text: &str) {
        let line = format!("{} supervisor: {text}\n", timestamp(SystemTime::now()));
        self.write(line.as_bytes());
    }

    fn write(&self, bytes: &[u8]) {
        self.write_at(SystemTime::now(), bytes);
    }

    /// Rolls like the control plane's `LogWriter`: a write that would take a
    /// non-empty file past `max_bytes` goes to the next suffix; one bigger
    /// than the cap still lands whole in a file of its own.
    fn write_at(&self, now: SystemTime, bytes: &[u8]) {
        let day = utc_day(now);
        let len = bytes.len() as u64;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.day.as_deref() != Some(day.as_str()) {
            prune(&self.dir, now, KEEP_DAYS);
            // A restarted supervisor goes on in the day's last file, so the
            // day's lines stay in order across the numbered files.
            let mut seq = 0;
            while self.dir.join(log_name(&day, seq + 1)).exists() {
                seq += 1;
            }
            state.day = Some(day.clone());
            state.seq = seq;
            state.size = file_size(&self.dir.join(log_name(&day, seq)));
        }
        if state.size > 0 && state.size + len > self.max_bytes {
            state.seq += 1;
            state.size = 0;
        }
        let path = self.dir.join(log_name(&day, state.seq));
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path)
            && file.write_all(bytes).is_ok()
        {
            state.size += len;
        }
    }
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map_or(0, |metadata| metadata.len())
}

/// `executor-YYYY-MM-DD.log`, or `executor-YYYY-MM-DD.N.log` past the first.
fn log_name(day: &str, seq: u32) -> String {
    if seq == 0 {
        format!("executor-{day}.log")
    } else {
        format!("executor-{day}.{seq}.log")
    }
}

/// `<dir>/executor-YYYY-MM-DD.log`, the first log file of `now`'s UTC day.
pub fn log_path(dir: &Path, now: SystemTime) -> PathBuf {
    dir.join(log_name(&utc_day(now), 0))
}

/// Removes `executor-YYYY-MM-DD[.N].log` files of days more than `keep_days`
/// before `now`'s UTC day. Other files are left alone.
pub fn prune(dir: &Path, now: SystemTime, keep_days: u64) {
    let cutoff = utc_day(now - Duration::from_secs(keep_days * 86_400));
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if let Some(day) = name.to_str().and_then(log_day)
            && day < cutoff.as_str()
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// The `YYYY-MM-DD` of a day log's name, `executor-YYYY-MM-DD[.N].log`.
fn log_day(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("executor-")?.strip_suffix(".log")?;
    let (day, seq) = rest.split_at_checked(10)?;
    let is_day = day.bytes().enumerate().all(|(index, byte)| match index {
        4 | 7 => byte == b'-',
        _ => byte.is_ascii_digit(),
    });
    let is_seq = seq.is_empty()
        || seq
            .strip_prefix('.')
            .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()));
    (is_day && is_seq).then_some(day)
}

/// `YYYY-MM-DD` of `time` in UTC.
fn utc_day(time: SystemTime) -> String {
    let (year, month, day) = civil(seconds(time) / 86_400);
    format!("{year:04}-{month:02}-{day:02}")
}

/// `YYYY-MM-DDTHH:MM:SSZ` of `time`.
fn timestamp(time: SystemTime) -> String {
    let seconds = seconds(time);
    let of_day = seconds % 86_400;
    format!(
        "{}T{:02}:{:02}:{:02}Z",
        utc_day(time),
        of_day / 3600,
        of_day / 60 % 60,
        of_day % 60
    )
}

fn seconds(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

/// The civil date of `days` since 1970-01-01 (Howard Hinnant's
/// `civil_from_days`, for days on or after the epoch).
fn civil(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A number constant of the control plane's supervisor, such as
    /// `const MAX_DELAY_MS = 30_000` or `5 * 60_000`.
    fn ts_constant(source: &str, name: &str) -> u128 {
        let prefix = format!("const {name} = ");
        let line = source
            .lines()
            .find_map(|line| line.strip_prefix(&prefix))
            .unwrap_or_else(|| panic!("{name} not found in supervise.ts"));
        line.split('*')
            .map(|factor| {
                factor
                    .trim()
                    .replace('_', "")
                    .parse::<u128>()
                    .unwrap_or_else(|error| panic!("{name}: {factor:?} is not a number: {error}"))
            })
            .product()
    }

    /// Both supervisors restart the same way, so a crash looping executor and
    /// control plane read alike in their logs; this reads the control plane's
    /// constants so a change there fails here.
    #[test]
    fn next_delay_matches_the_control_plane_supervisor() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../control-plane/src/service/supervise.ts");
        let source =
            std::fs::read_to_string(&path).expect("control-plane supervise.ts is readable");
        let first = Duration::from_millis(1);
        let first_ms = ts_constant(&source, "FIRST_DELAY_MS");
        let max_ms = ts_constant(&source, "MAX_DELAY_MS");
        let healthy_ms = ts_constant(&source, "HEALTHY_UPTIME_MS");
        assert_eq!(next_delay(None, first).as_millis(), first_ms);

        let mut delays = Vec::new();
        let mut delay = None;
        for _ in 0..7 {
            let next = next_delay(delay, Duration::from_secs(1));
            delays.push(next.as_millis());
            delay = Some(next);
        }
        assert_eq!(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
        assert_eq!(delays.last().copied(), Some(max_ms));
        let healthy = Duration::from_millis(u64::try_from(healthy_ms).expect("fits u64"));
        assert_eq!(next_delay(delay, healthy).as_millis(), first_ms);
        assert_eq!(
            next_delay(delay, healthy - Duration::from_millis(1)).as_millis(),
            max_ms
        );
    }

    /// Log files are named by UTC day, and pruning keeps the last 14 days
    /// and every file that is not a day log.
    #[test]
    fn logs_are_named_by_utc_day_and_pruned_after_keep_days() -> io::Result<()> {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
        fs::create_dir_all(&parent)?;
        let temp = tempfile::tempdir_in(&parent)?;
        let dir = temp.path();
        // 2026-11-18T23:59:59Z
        let now = UNIX_EPOCH + Duration::from_secs(1_795_046_399);
        assert_eq!(timestamp(now), "2026-11-18T23:59:59Z");
        assert_eq!(log_path(dir, now), dir.join("executor-2026-11-18.log"));
        for name in [
            "executor-2026-11-03.log",
            "executor-2026-11-03.1.log",
            "executor-2026-11-04.log",
            "executor-2026-11-04.2.log",
            "executor-2026-11-18.log",
            "executor-2026-11-18.12.log",
            "executor-2026-11-0x.log",
            "other-2020-01-01.log",
        ] {
            fs::write(dir.join(name), "x")?;
        }
        prune(dir, now, KEEP_DAYS);
        let mut left: Vec<String> = fs::read_dir(dir)?
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "executor-2026-11-04.2.log",
                "executor-2026-11-04.log",
                "executor-2026-11-0x.log",
                "executor-2026-11-18.12.log",
                "executor-2026-11-18.log",
                "other-2020-01-01.log"
            ]
        );
        Ok(())
    }

    /// Stopping the task ends only conhost, so its next trigger starts a
    /// second `supervise` beside the first: that one must find the lock held.
    #[test]
    fn one_supervisor_per_home() -> io::Result<()> {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
        fs::create_dir_all(&parent)?;
        let temp = tempfile::tempdir_in(&parent)?;
        let first = lock_supervisor(temp.path())?;
        assert!(first.is_some(), "the first supervisor takes the lock");
        assert!(
            lock_supervisor(temp.path())?.is_none(),
            "a second one does not"
        );
        drop(first);
        assert!(
            lock_supervisor(temp.path())?.is_some(),
            "free once the first is gone"
        );
        Ok(())
    }

    /// A day log rolls to `.1`, `.2`, ... once the next write would take it
    /// past the cap, as the control plane's `service/logs.ts` does; a fresh
    /// supervisor appends to the last file of the day that still has room,
    /// and a new day starts over at the unsuffixed name.
    #[test]
    fn a_day_log_rolls_to_a_numbered_file_past_the_size_cap() -> io::Result<()> {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
        fs::create_dir_all(&parent)?;
        let temp = tempfile::tempdir_in(&parent)?;
        let dir = temp.path();
        let now = UNIX_EPOCH + Duration::from_secs(1_795_046_399);
        let log = DailyLog::new(dir.to_path_buf(), 10);
        for chunk in ["aaaa", "bbbb", "cccc", "dddddddddddd", "ee"] {
            log.write_at(now, chunk.as_bytes());
        }
        let read = |name: &str| fs::read_to_string(dir.join(name));
        assert_eq!(read("executor-2026-11-18.log")?, "aaaabbbb");
        assert_eq!(read("executor-2026-11-18.1.log")?, "cccc");
        // Bigger than the cap: written whole to a file of its own.
        assert_eq!(read("executor-2026-11-18.2.log")?, "dddddddddddd");
        assert_eq!(read("executor-2026-11-18.3.log")?, "ee");

        let restarted = DailyLog::new(dir.to_path_buf(), 10);
        restarted.write_at(now, b"ff");
        assert_eq!(read("executor-2026-11-18.3.log")?, "eeff");

        let next_day = now + Duration::from_secs(1);
        restarted.write_at(next_day, b"gg");
        assert_eq!(read("executor-2026-11-19.log")?, "gg");
        Ok(())
    }
}
