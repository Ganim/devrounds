//! Follows one run's output files while it runs: frames each stream into
//! lines, reports step markers as step events, keeps the last lines as the
//! run's tail and cuts the output into log segments (`<run dir>/segments`)
//! that ship as `LogSegment` events through the store outbox. A segment's
//! local files go once its event is acked; the raw output files go once the
//! last segment of the run is. How far the raw files were read is kept in
//! `output.offsets`, so a restarted executor can ship the rest of an
//! orphan's output.

use std::{
    collections::VecDeque,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::Engine;
use devrounds_core::RunOutput;
use devrounds_logs::{Framer, LogOptions, SegmentMetadata, UnitLog, read_segment};
use devrounds_protocol::RunEvent;
use devrounds_store::Store;
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};

use crate::steps::{StepChange, Steps, parse_step_marker};

/// How often the files are read while the run is alive.
pub const POLL: Duration = Duration::from_millis(200);
/// Lines and bytes `RunFinished.tail` keeps.
pub const TAIL_LINES: usize = 50;
pub const TAIL_BYTES: usize = 8 * 1024;
/// Read cap per stream and poll while the run is alive, so one poll never
/// holds a blocking thread for long; the final read goes to the end.
const POLL_BYTES: usize = 1024 * 1024;

/// How a run's output is cut into segments and shipped.
#[derive(Debug, Clone)]
pub struct SegmentOptions {
    pub log: LogOptions,
    /// The largest `LogSegment` event the connection can send (the
    /// protocol's frame limit). A segment past it does not ship; the run's
    /// output then stays on disk.
    pub max_event_bytes: usize,
}

/// The task following one run's output. [`OutputTail::finish`] reads what is
/// left and returns the tail.
pub struct OutputTail {
    stop: oneshot::Sender<()>,
    task: JoinHandle<Vec<String>>,
}

impl OutputTail {
    /// `segments` is the directory the run's log segments are cut into,
    /// with `options`.
    pub fn spawn(
        run: String,
        output: RunOutput,
        store: Store,
        segments: PathBuf,
        options: SegmentOptions,
    ) -> Self {
        let (stop, stopped) = oneshot::channel();
        let offsets = offsets_file(&segments);
        let mut raw = vec![output.stdout.clone(), offsets.clone()];
        let mut streams = vec![Stream::new("stdout", output.stdout.clone())];
        if output.stderr != output.stdout {
            raw.push(output.stderr.clone());
            streams.push(Stream::new("stderr", output.stderr));
        }
        let (reap, reaps) = mpsc::unbounded_channel();
        tokio::spawn(reaper(store.acked(), reaps, segments.clone(), raw));
        let state = State {
            streams,
            tail: Tail::default(),
            steps: Steps::default(),
            log: RunLog::Pending {
                dir: segments,
                options,
            },
            offsets,
            offsets_written: None,
            #[cfg(test)]
            largest_read: 0,
        };
        let task = tokio::spawn(follow(run, state, store, reap, stopped));
        Self { stop, task }
    }

    /// Call once the run has exited: reads to the end of both files, reports
    /// the last step changes, ships the last segment and returns the tail.
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
    reap: mpsc::UnboundedSender<Reap>,
    mut stopped: oneshot::Receiver<()>,
) -> Vec<String> {
    let mut poll = tokio::time::interval(POLL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last = false;
    // A segment event the store refused: as with a segment that could not be
    // made into one, the run's files are then the only copy of its output.
    let mut unstored = false;
    loop {
        // A dropped sender also means the run is over. Once it is, the final
        // drain goes on without waiting, a few segments per round.
        if !last {
            last = tokio::select! {
                biased;
                _ = &mut stopped => true,
                _ = poll.tick() => false,
            };
        }
        let name = run.clone();
        let read = tokio::task::spawn_blocking(move || {
            let polled = state.poll(&name, last);
            (state, polled)
        })
        .await;
        let polled;
        (state, polled) = match read {
            Ok(read) => read,
            Err(error) => {
                tracing::warn!(%run, %error, "output read failed; the run reports no tail");
                return Vec::new();
            }
        };
        for change in polled.changes {
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
        for Shipment { event, files } in polled.segments {
            match store.append_event(event).await {
                Ok(seq) => {
                    let _ = reap.send(Reap::Shipped { seq, files });
                }
                Err(error) => {
                    unstored = true;
                    tracing::error!(%run, %error, "log segment not stored; the run's output stays on disk");
                }
            }
        }
        if polled.done {
            // Unsealed, the reaper stops with the output task and keeps the
            // raw files and every segment not deleted yet.
            if polled.sealed && !unstored {
                let _ = reap.send(Reap::Sealed);
            }
            return state.tail.lines.into();
        }
    }
}

/// What the reaper hears from the output task.
enum Reap {
    /// A segment is in the outbox as event `seq`; `files` go once it is acked.
    Shipped { seq: u64, files: Vec<PathBuf> },
    /// Every segment of the run was shipped.
    Sealed,
}

/// Deletes each shipped segment's files once its event is acked, then the
/// segment directory and the raw output files once the run is sealed and its
/// last segment acked. Ends early, keeping the files, when the output task
/// ends without sealing (the log failed, or a segment did not reach the
/// outbox) or the store goes away.
async fn reaper(
    mut acked: watch::Receiver<u64>,
    mut reaps: mpsc::UnboundedReceiver<Reap>,
    segments: PathBuf,
    raw: Vec<PathBuf>,
) {
    let mut pending = VecDeque::<(u64, Vec<PathBuf>)>::new();
    let mut sealed = false;
    loop {
        let through = *acked.borrow_and_update();
        while pending.front().is_some_and(|(seq, _)| *seq <= through) {
            if let Some((_, files)) = pending.pop_front() {
                for file in files {
                    remove(&file).await;
                }
            }
        }
        if sealed && pending.is_empty() {
            for file in raw {
                remove(&file).await;
            }
            if let Err(error) = tokio::fs::remove_dir_all(&segments).await
                && error.kind() != io::ErrorKind::NotFound
            {
                tracing::warn!(path = %segments.display(), %error, "segment directory not removed");
            }
            // Only once empty; anything else left is the orphan pass's to sweep.
            if let Some(run_dir) = segments.parent() {
                let _ = tokio::fs::remove_dir(run_dir).await;
            }
            return;
        }
        tokio::select! {
            reap = reaps.recv(), if !sealed => match reap {
                Some(Reap::Shipped { seq, files }) => pending.push_back((seq, files)),
                Some(Reap::Sealed) => sealed = true,
                None => return,
            },
            changed = acked.changed() => {
                if changed.is_err() {
                    return;
                }
            }
        }
    }
}

async fn remove(file: &Path) {
    if let Err(error) = tokio::fs::remove_file(file).await
        && error.kind() != io::ErrorKind::NotFound
    {
        tracing::warn!(path = %file.display(), %error, "acked log file not removed");
    }
}

struct Stream {
    /// The `UnitLog` stream id: `stdout` or `stderr`.
    name: &'static str,
    path: PathBuf,
    offset: u64,
    framer: Framer,
    /// Logged once: a stream that cannot be read stays silent after that.
    failed: bool,
}

impl Stream {
    fn new(name: &'static str, path: PathBuf) -> Self {
        Self {
            name,
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

/// A closed segment as its `LogSegment` event, and the files it leaves on disk.
struct Shipment {
    event: RunEvent,
    files: Vec<PathBuf>,
}

/// What one poll found.
#[derive(Default)]
struct Polled {
    changes: Vec<StepChange>,
    segments: Vec<Shipment>,
    /// The final drain is complete: nothing is left to read.
    done: bool,
    /// With `done`: the last segment was sealed and every segment handed out.
    sealed: bool,
}

/// The run's segmented log. Opened on the first poll (it does disk I/O), and
/// off for good after a failure: the run goes on, its raw files stay.
enum RunLog {
    Pending {
        dir: PathBuf,
        options: SegmentOptions,
    },
    Open {
        log: UnitLog,
        /// `last_seq` of the last segment handed out.
        shipped_through: u64,
        max_event_bytes: usize,
        /// A closed segment could not be made into an event: the run's
        /// files are then its only copy, and the run is never sealed.
        lost: bool,
    },
    Off,
}

impl RunLog {
    fn open(&mut self, run: &str) {
        let Self::Pending { dir, options } = self else {
            return;
        };
        *self = match UnitLog::open(&*dir, run, options.log.clone()) {
            Ok(log) => Self::Open {
                log,
                shipped_through: 0,
                max_event_bytes: options.max_event_bytes,
                lost: false,
            },
            Err(error) => {
                tracing::warn!(%run, %error, "run log not opened; its output does not ship");
                Self::Off
            }
        };
    }

    /// Applies `work` to the open log; a failure turns the log off.
    fn with(&mut self, run: &str, work: impl FnOnce(&mut UnitLog) -> devrounds_logs::Result<()>) {
        if let Self::Open { log, .. } = self
            && let Err(error) = work(log)
        {
            tracing::warn!(%run, %error, "run log failed; the rest of its output does not ship");
            *self = Self::Off;
        }
    }

    /// Closed segments not handed out yet, as shipments.
    fn closed(&mut self, run: &str) -> Vec<Shipment> {
        let Self::Open {
            log,
            shipped_through,
            max_event_bytes,
            lost,
        } = self
        else {
            return Vec::new();
        };
        let dir = log.path().to_owned();
        let mut shipments = Vec::new();
        for meta in log.reader().segments() {
            if !meta.closed || meta.records == 0 || meta.first_seq <= *shipped_through {
                continue;
            }
            // Handed out once either way: a segment that cannot ship is never retried.
            *shipped_through = meta.last_seq;
            match shipment(&dir, meta, run, *max_event_bytes) {
                Ok(shipment) => shipments.push(shipment),
                Err(error) => {
                    *lost = true;
                    tracing::error!(%run, first_seq = meta.first_seq, %error, "log segment not shipped; the run's output stays on disk");
                }
            }
        }
        shipments
    }

    /// Every segment so far made it into an event.
    fn intact(&self) -> bool {
        matches!(self, Self::Open { lost: false, .. })
    }
}

/// What a `LogSegment` frame holds besides its base64: the envelope, kind,
/// run id and seqs, generously.
const FRAME_OVERHEAD: usize = 1024;

/// The segment as zstd-compressed JSON lines, one `LogLine` per record,
/// base64 in the event. One segment at a time, so what this holds is bounded
/// by the segment size. An event past `max_event_bytes` could never be sent,
/// so it fails here instead of sitting at the head of the outbox.
fn shipment(
    dir: &Path,
    meta: &SegmentMetadata,
    run: &str,
    max_event_bytes: usize,
) -> Result<Shipment, String> {
    let lines = read_segment(meta, run).map_err(|error| error.to_string())?;
    let mut json = Vec::with_capacity(usize::try_from(meta.uncompressed_bytes).unwrap_or(0));
    for line in &lines {
        serde_json::to_writer(&mut json, line).map_err(|error| error.to_string())?;
        json.push(b'\n');
    }
    let compressed = zstd::stream::encode_all(json.as_slice(), 3).map_err(|e| e.to_string())?;
    let zstd_base64 = base64::engine::general_purpose::STANDARD.encode(compressed);
    if zstd_base64.len() + FRAME_OVERHEAD > max_event_bytes {
        return Err(format!(
            "{} bytes as base64, over the {max_event_bytes} byte frame limit",
            zstd_base64.len()
        ));
    }
    let event = RunEvent::LogSegment {
        run: run.to_owned(),
        first_seq: meta.first_seq,
        last_seq: meta.last_seq,
        records: u32::try_from(lines.len()).map_err(|error| error.to_string())?,
        zstd_base64,
    };
    // The metadata name follows devrounds-logs' `<first_seq:020>.meta.json`.
    let files = vec![
        meta.path.clone(),
        dir.join(format!("{:020}.meta.json", meta.first_seq)),
    ];
    Ok(Shipment { event, files })
}

/// `<run dir>/output.offsets`: how far each raw output file was read into
/// the run's log, one `<stream> <offset>` line per stream. Pending segment
/// acks live only in this process, so a restarted executor reads the rest of
/// an orphan's output on from here ([`recover_orphan_log`]).
const OFFSETS_FILE: &str = "output.offsets";

fn offsets_file(segments: &Path) -> PathBuf {
    segments.parent().unwrap_or(segments).join(OFFSETS_FILE)
}

/// Written aside and renamed, so a crash leaves the old offsets or the new.
fn write_offsets(path: &Path, streams: &[Stream]) -> io::Result<()> {
    let text: String = streams
        .iter()
        .map(|stream| format!("{} {}\n", stream.name, stream.offset))
        .collect();
    let aside = path.with_extension("offsets.tmp");
    std::fs::write(&aside, text)?;
    std::fs::rename(&aside, path)
}

/// The offset of each stream; a missing file reads as nothing read yet,
/// which is so: it is written after the first read that found bytes.
fn read_offsets(path: &Path) -> io::Result<Vec<(String, u64)>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    text.lines()
        .map(|line| {
            let (name, offset) = line
                .split_once(' ')
                .ok_or_else(|| io::Error::other(format!("bad offsets line {line:?}")))?;
            let offset = offset.parse().map_err(io::Error::other)?;
            Ok((name.to_owned(), offset))
        })
        .collect()
}

/// What a previous executor process left of orphan `run`'s output in
/// `run_dir`: reopens the run's log (which recovers its last plain segment),
/// appends the raw output past the recorded offsets, closes it and returns
/// every closed segment with records, to ship one at a time with
/// [`orphan_segment_event`]. Segments shipped before may come again; the
/// control plane keeps a segment once by its `first_seq`. Blocking. Empty
/// (warned) when the log cannot be reopened: the files then stay for the
/// orphan pass to sweep.
pub(crate) fn recover_orphan_log(
    run: &str,
    run_dir: &Path,
    options: &SegmentOptions,
) -> Vec<SegmentMetadata> {
    if !run_dir.exists() {
        return Vec::new();
    }
    let segments = run_dir.join("segments");
    // Unreadable offsets would repeat or skip lines; the log alone ships then.
    let offsets = read_offsets(&offsets_file(&segments)).unwrap_or_else(|error| {
        tracing::warn!(%run, %error, "output offsets unreadable; only the run's log ships");
        vec![
            ("stdout".to_owned(), u64::MAX),
            ("stderr".to_owned(), u64::MAX),
        ]
    });
    let mut log = match UnitLog::open(&segments, run, options.log.clone()) {
        Ok(log) => log,
        Err(error) => {
            tracing::warn!(%run, %error, "orphan's run log not reopened; its output does not ship");
            return Vec::new();
        }
    };
    let now = unix_ms();
    for name in ["stdout", "stderr"] {
        let offset = offsets
            .iter()
            .find(|(stream, _)| stream == name)
            .map_or(0, |(_, offset)| *offset);
        let mut stream = Stream::new(name, run_dir.join(format!("{name}.raw")));
        stream.offset = offset;
        loop {
            let bytes = match stream.read(POLL_BYTES) {
                Ok(bytes) => bytes,
                Err(error) => {
                    tracing::warn!(%run, path = %stream.path.display(), %error, "orphan's output unreadable");
                    break;
                }
            };
            if bytes.is_empty() {
                break;
            }
            if let Err(error) = log.ingest_stream(name, &bytes, now) {
                tracing::warn!(%run, %error, "orphan's run log failed");
                return Vec::new();
            }
        }
    }
    if let Err(error) = log.finish(now) {
        tracing::warn!(%run, %error, "orphan's run log not closed");
    }
    log.segments()
        .into_iter()
        .filter(|meta| meta.closed && meta.records > 0)
        .collect()
}

/// One recovered segment of orphan `run` as its `LogSegment` event. Blocking.
pub(crate) fn orphan_segment_event(
    run: &str,
    run_dir: &Path,
    meta: &SegmentMetadata,
    options: &SegmentOptions,
) -> Result<RunEvent, String> {
    shipment(
        &run_dir.join("segments"),
        meta,
        run,
        options.max_event_bytes,
    )
    .map(|shipment| shipment.event)
}

struct State {
    streams: Vec<Stream>,
    tail: Tail,
    steps: Steps,
    log: RunLog,
    /// [`offsets_file`] of this run, and the offsets last written to it.
    offsets: PathBuf,
    offsets_written: Option<Vec<u64>>,
    /// The largest chunk one read returned: with lines handed on per chunk,
    /// it bounds what a poll holds besides the tail.
    #[cfg(test)]
    largest_read: usize,
}

impl State {
    /// One read of every stream. `last` reads on to the end, flushes any
    /// unterminated line and seals the log; it returns early (`done` false)
    /// whenever segments closed, so the caller ships them before reading on.
    ///
    /// Each chunk's lines go straight to the step parser, the tail and the
    /// log, so a backlog left by a fast writer costs one chunk, the tail and
    /// the segments of that chunk at any time, never the whole backlog.
    fn poll(&mut self, run: &str, last: bool) -> Polled {
        let Self {
            streams,
            tail,
            steps,
            log,
            offsets,
            offsets_written,
            #[cfg(test)]
            largest_read,
        } = self;
        log.open(run);
        let mut changes = Vec::new();
        let mut take = |line: String| {
            if let Some(change) = parse_step_marker(&line).and_then(|marker| steps.apply(marker)) {
                changes.push(change);
            }
            tail.push(line);
        };
        let now = unix_ms();
        for stream in streams.iter_mut() {
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
                #[cfg(test)]
                {
                    *largest_read = (*largest_read).max(bytes.len());
                }
                let more = last && bytes.len() == POLL_BYTES;
                let _ = stream.framer.ingest(&bytes, now, |frame| {
                    take(frame.text);
                    Ok::<(), ()>(())
                });
                if !bytes.is_empty() {
                    log.with(run, |log| log.ingest_stream(stream.name, &bytes, now));
                }
                if !more {
                    break;
                }
                let segments = log.closed(run);
                if !segments.is_empty() {
                    return Polled {
                        changes,
                        segments,
                        ..Polled::default()
                    };
                }
            }
            if let Some(frame) = stream.framer.flush_partial(now, last) {
                take(frame.text);
            }
        }
        if last {
            log.with(run, |log| log.finish(now));
        } else {
            // Exposes a waiting prompt as a partial line and rotates by age.
            log.with(run, |log| log.flush_partial(now, false));
        }
        // After the flush: what the log holds on disk reaches at least these
        // offsets, so a restarted executor reading on from them repeats no
        // line. It loses at most each stream's unterminated last line, which
        // only the log's framer held.
        if matches!(log, RunLog::Open { .. }) {
            let read: Vec<u64> = streams.iter().map(|stream| stream.offset).collect();
            if offsets_written.as_ref() != Some(&read) {
                match write_offsets(offsets, streams) {
                    Ok(()) => *offsets_written = Some(read),
                    Err(error) => {
                        tracing::warn!(path = %offsets.display(), %error, "output offsets not written");
                    }
                }
            }
        }
        let segments = log.closed(run);
        Polled {
            changes,
            segments,
            done: last,
            sealed: last && log.intact(),
        }
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
    use std::io::Write;

    use super::{POLL_BYTES, RunLog, State, Stream, TAIL_BYTES, TAIL_LINES, Tail};
    use crate::steps::{StepChange, Steps};

    #[test]
    fn a_large_backlog_drains_through_a_bounded_buffer() {
        // Unit tests get no CARGO_TARGET_TMPDIR; the workspace target dir stands in.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
        std::fs::create_dir_all(&root).expect("create target/tmp");
        let dir = tempfile::tempdir_in(root).expect("tempdir");
        let path = dir.path().join("stdout.raw");

        // About 24 MiB written before any poll: what a fast writer leaves for the
        // final drain. Step markers at both ends prove every chunk was parsed.
        let mut file = std::io::BufWriter::new(std::fs::File::create(&path).expect("create"));
        writeln!(file, "::devrounds::step-start name=build").expect("write");
        let line = "x".repeat(120);
        let mut written = 0;
        while written < 24 * 1024 * 1024 {
            writeln!(file, "{line}").expect("write");
            written += line.len() + 1;
        }
        writeln!(file, "::devrounds::step-end name=build outcome=finished").expect("write");
        writeln!(file, "last line").expect("write");
        file.flush().expect("flush");
        drop(file);

        let mut state = State {
            streams: vec![Stream::new("stdout", path.clone())],
            tail: Tail::default(),
            steps: Steps::default(),
            log: RunLog::Off,
            offsets: dir.path().join("output.offsets"),
            offsets_written: None,
            largest_read: 0,
        };
        let polled = state.poll("run", true);
        assert!(polled.done);
        let changes = polled.changes;

        assert_eq!(changes.len(), 2, "{changes:?}");
        assert!(matches!(changes[1], StepChange::Finished { step: 0, .. }));
        assert_eq!(
            state.streams[0].offset,
            std::fs::metadata(&path).expect("metadata").len()
        );
        assert!(state.tail.lines.len() <= TAIL_LINES);
        assert!(state.tail.bytes <= TAIL_BYTES);
        assert_eq!(
            state.tail.lines.back().map(String::as_str),
            Some("last line")
        );
        assert!(state.largest_read <= POLL_BYTES, "{}", state.largest_read);
    }

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
