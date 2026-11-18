//! Follows one run's output files while it runs: frames each stream into
//! lines, reports step markers as step events and keeps the last lines as the
//! run's tail. Task 14 ships the output itself; this only reads it.

use std::{
    collections::VecDeque,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use devrounds_core::RunOutput;
use devrounds_logs::Framer;
use devrounds_protocol::RunEvent;
use devrounds_store::Store;
use tokio::{sync::oneshot, task::JoinHandle};

use crate::steps::{StepChange, Steps, parse_step_marker};

/// How often the files are read while the run is alive.
pub const POLL: Duration = Duration::from_millis(200);
/// Lines and bytes `RunFinished.tail` keeps.
pub const TAIL_LINES: usize = 50;
pub const TAIL_BYTES: usize = 8 * 1024;
/// Read cap per stream and poll while the run is alive, so one poll never
/// holds a blocking thread for long; the final read goes to the end.
const POLL_BYTES: usize = 1024 * 1024;

/// The task following one run's output. [`OutputTail::finish`] reads what is
/// left and returns the tail.
pub struct OutputTail {
    stop: oneshot::Sender<()>,
    task: JoinHandle<Vec<String>>,
}

impl OutputTail {
    pub fn spawn(run: String, output: RunOutput, store: Store) -> Self {
        let (stop, stopped) = oneshot::channel();
        let mut streams = vec![Stream::new(output.stdout.clone())];
        if output.stderr != output.stdout {
            streams.push(Stream::new(output.stderr));
        }
        let state = State {
            streams,
            tail: Tail::default(),
            steps: Steps::default(),
        };
        let task = tokio::spawn(follow(run, state, store, stopped));
        Self { stop, task }
    }

    /// Call once the run has exited: reads to the end of both files, reports
    /// the last step changes and returns the tail.
    pub async fn finish(self) -> Vec<String> {
        let _ = self.stop.send(());
        self.task.await.unwrap_or_else(|error| {
            tracing::warn!(%error, "output task failed; the run reports no tail");
            Vec::new()
        })
    }
}

async fn follow(
    run: String,
    mut state: State,
    store: Store,
    mut stopped: oneshot::Receiver<()>,
) -> Vec<String> {
    let mut poll = tokio::time::interval(POLL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        // A dropped sender also means the run is over.
        let last = tokio::select! {
            biased;
            _ = &mut stopped => true,
            _ = poll.tick() => false,
        };
        let read = tokio::task::spawn_blocking(move || {
            let changes = state.poll(last);
            (state, changes)
        })
        .await;
        let changes;
        (state, changes) = match read {
            Ok(read) => read,
            Err(error) => {
                tracing::warn!(%run, %error, "output read failed; the run reports no tail");
                return Vec::new();
            }
        };
        for change in changes {
            let event = match change {
                StepChange::Started { step, name } => RunEvent::StepStarted {
                    run: run.clone(),
                    step,
                    name,
                },
                StepChange::Finished { step, outcome } => RunEvent::StepFinished {
                    run: run.clone(),
                    step,
                    outcome,
                },
            };
            if let Err(error) = store.append_event(event).await {
                tracing::warn!(%run, %error, "step event not stored");
            }
        }
        if last {
            return state.tail.lines.into();
        }
    }
}

struct Stream {
    path: PathBuf,
    offset: u64,
    framer: Framer,
    /// Logged once: a stream that cannot be read stays silent after that.
    failed: bool,
}

impl Stream {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            offset: 0,
            framer: Framer::default(),
            failed: false,
        }
    }

    /// New bytes since the last read, at most `cap`. A file not created yet
    /// has none.
    fn read(&mut self, cap: usize) -> io::Result<Vec<u8>> {
        let mut file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::new();
        file.take(cap as u64).read_to_end(&mut bytes)?;
        self.offset += bytes.len() as u64;
        Ok(bytes)
    }
}

struct State {
    streams: Vec<Stream>,
    tail: Tail,
    steps: Steps,
}

impl State {
    /// One read of every stream; `last` reads to the end and flushes any
    /// unterminated line.
    fn poll(&mut self, last: bool) -> Vec<StepChange> {
        let mut lines = Vec::new();
        let now = unix_ms();
        for stream in &mut self.streams {
            loop {
                let bytes = match stream.read(POLL_BYTES) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        if !stream.failed {
                            stream.failed = true;
                            tracing::warn!(path = %stream.path.display(), %error, "run output unreadable");
                        }
                        break;
                    }
                };
                let more = last && bytes.len() == POLL_BYTES;
                let _ = stream.framer.ingest(&bytes, now, |frame| {
                    lines.push(frame.text);
                    Ok::<(), ()>(())
                });
                if !more {
                    break;
                }
            }
            if let Some(frame) = stream.framer.flush_partial(now, last) {
                lines.push(frame.text);
            }
        }
        let mut changes = Vec::new();
        for line in lines {
            if let Some(change) =
                parse_step_marker(&line).and_then(|marker| self.steps.apply(marker))
            {
                changes.push(change);
            }
            self.tail.push(line);
        }
        changes
    }
}

/// The last [`TAIL_LINES`] lines within [`TAIL_BYTES`].
#[derive(Debug, Default)]
struct Tail {
    lines: VecDeque<String>,
    bytes: usize,
}

impl Tail {
    fn push(&mut self, mut line: String) {
        if line.len() > TAIL_BYTES {
            let mut end = TAIL_BYTES;
            while !line.is_char_boundary(end) {
                end -= 1;
            }
            line.truncate(end);
        }
        self.bytes += line.len();
        self.lines.push_back(line);
        while self.lines.len() > TAIL_LINES || self.bytes > TAIL_BYTES {
            if let Some(first) = self.lines.pop_front() {
                self.bytes -= first.len();
            }
        }
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::{TAIL_BYTES, TAIL_LINES, Tail};

    #[test]
    fn the_tail_keeps_the_last_lines_within_its_byte_budget() {
        let mut tail = Tail::default();
        for i in 0..TAIL_LINES + 10 {
            tail.push(format!("line {i}"));
        }
        assert_eq!(tail.lines.len(), TAIL_LINES);
        assert_eq!(tail.lines.front().map(String::as_str), Some("line 10"));

        // One line past the budget is cut on a character boundary and alone.
        tail.push("é".repeat(TAIL_BYTES));
        assert_eq!(tail.lines.len(), 1);
        assert!(tail.bytes <= TAIL_BYTES);
        assert!(tail.lines[0].chars().all(|c| c == 'é'));
    }
}
