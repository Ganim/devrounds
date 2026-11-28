use crate::{Error, Frame, Framer, LogOptions, LogReader, MAX_LINE_BYTES, UnitLog, extract_level};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

/// A scratch directory under the workspace's `target/tmp`, never the system temp.
fn tempdir() -> tempfile::TempDir {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp");
    fs::create_dir_all(&root).expect("create target/tmp");
    tempfile::tempdir_in(root).expect("tempdir")
}

/// Collect only in tests; production callers use the bounded callback interface.
fn feed(framer: &mut Framer, bytes: &[u8], timestamp: u64, frames: &mut Vec<Frame>) {
    framer
        .ingest(bytes, timestamp, |frame| {
            frames.push(frame);
            Ok::<_, Error>(())
        })
        .expect("test step");
}

#[test]
/// Every byte boundary may split ANSI, OSC hyperlinks, CRLF, or UTF-8.
fn arbitrary_chunks_strip_ansi_and_replace_progress() {
    let input = b"old\rnew\x1b[31m\xe2\x82\xac\x1b[0m\r\n\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\\n";
    for split in 0..=input.len() {
        let mut framer = Framer::default();
        let mut frames = Vec::new();
        feed(&mut framer, &input[..split], 1, &mut frames);
        feed(&mut framer, &input[split..], 2, &mut frames);
        assert_eq!(
            frames.iter().map(|f| f.text.as_str()).collect::<Vec<_>>(),
            ["new€", "link"]
        );
        assert_eq!(
            frames
                .iter()
                .flat_map(|f| f.raw.iter().copied())
                .collect::<Vec<_>>(),
            input
        );
    }
}

#[test]
/// Timer flushing uses idle time and makes EOF's incomplete UTF-8 visible.
fn partial_flush_and_invalid_utf8() {
    let mut framer = Framer::default();
    let mut frames = Vec::new();
    feed(&mut framer, b"prompt?", 10, &mut frames);
    assert!(framer.flush_partial(209, false).is_none());
    let partial = framer.flush_partial(210, false).expect("test step");
    assert!(partial.partial);
    assert_eq!(partial.timestamp_ms, 10);
    assert_eq!(partial.text, "prompt?");
    feed(&mut framer, b"\n\ninvalid \xff\xe2", 300, &mut frames);
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].text, "");
    assert_eq!(
        framer.flush_partial(300, true).expect("test step").text,
        "invalid ��"
    );
    feed(&mut framer, b"\xe2", 400, &mut frames);
    assert_eq!(
        framer.flush_partial(600, false).expect("test step").text,
        ""
    );
    assert_eq!(
        framer.flush_partial(600, true).expect("test step").text,
        "�"
    );
}

#[test]
/// Huge unterminated hyperlinks cannot accumulate inside the terminal parser.
fn osc_across_line_caps_does_not_leak_into_searchable_text() {
    let mut framer = Framer::default();
    let mut frames = Vec::new();
    feed(&mut framer, b"\x1b]8;;", 1, &mut frames);
    feed(&mut framer, &vec![b'a'; MAX_LINE_BYTES * 4], 1, &mut frames);
    feed(&mut framer, b"\x1b\\visible\n", 1, &mut frames);
    assert_eq!(
        frames.iter().map(|f| f.text.as_str()).collect::<String>(),
        "visible"
    );
    assert!(frames.iter().all(|f| f.raw.len() <= MAX_LINE_BYTES));
}

#[test]
/// A code point spanning the raw cap belongs wholly to the next text fragment.
fn long_lines_cap_without_corrupting_unicode_or_adding_empty_lines() {
    let mut framer = Framer::default();
    let mut frames = Vec::new();
    let text = format!("{}€\n", "a".repeat(MAX_LINE_BYTES - 1));
    feed(&mut framer, text.as_bytes(), 1, &mut frames);
    assert_eq!(frames.len(), 2);
    assert!(frames[0].continued);
    assert_eq!(frames[0].raw.len(), MAX_LINE_BYTES);
    assert_eq!(frames[1].text, "€");
    assert_eq!(
        frames.iter().map(|f| f.text.as_str()).collect::<String>(),
        text.trim_end()
    );
    frames.clear();
    feed(
        &mut framer,
        format!("{}\n", "b".repeat(MAX_LINE_BYTES)).as_bytes(),
        2,
        &mut frames,
    );
    assert_eq!(frames.len(), 1);
}

#[test]
/// Structured severity beats message content and supports pino and systemd encodings.
fn extracts_structured_levels() {
    for (text, expected) in [
        (r#"{"level":50,"msg":"info"}"#, Some("error")),
        (r#"[worker] {"severity":"WARNING"}"#, Some("warn")),
        (r#"{"log":{"level":"DEBUG"}}"#, Some("debug")),
        (r#"{"PRIORITY":3}"#, Some("error")),
        (r#"msg="a level=error b" level="info""#, Some("info")),
        (r#"msg="level=error""#, None),
        ("WARNING: server stopped", Some("warn")),
        ("30 requests completed", None),
        (r#"{"msg":"error"}"#, None),
    ] {
        assert_eq!(extract_level(text).as_deref(), expected, "{text}");
    }
}

/// The files of the directory this crate writes: segments, metadata and its own
/// temporaries (case-sensitive suffixes), lock files left out. Anything else is
/// another program's: on Windows a scanner copying a fresh `.log.zst` left
/// `…0796.LOG.ZST.tmp` beside it while `trim_to` ran (F-0016), which says nothing
/// about retention.
fn listing(directory: &Path) -> Vec<String> {
    const OWN: [&str; 5] = [".log", ".log.zst", ".meta.json", ".zst.tmp", ".json.tmp"];
    let mut names: Vec<_> = fs::read_dir(directory)
        .expect("test step")
        .map(|entry| {
            entry
                .expect("test step")
                .file_name()
                .into_string()
                .expect("test step")
        })
        .filter(|name| !name.starts_with('.') && OWN.iter().any(|own| name.ends_with(own)))
        .collect();
    names.sort();
    names
}

/// Names and contents, to prove a read left the directory untouched.
fn contents(directory: &Path) -> Vec<(String, Vec<u8>)> {
    let mut entries: Vec<_> = fs::read_dir(directory)
        .expect("test step")
        .map(|entry| {
            let entry = entry.expect("test step");
            (
                entry.file_name().into_string().expect("test step"),
                fs::read(entry.path()).expect("test step"),
            )
        })
        .collect();
    entries.sort();
    entries
}

/// Several compressed segments, each spanning more than one 256-record index block.
fn history(directory: &Path, lines: u64) -> UnitLog {
    let options = LogOptions {
        segment_bytes: 16 * 1024,
        ..Default::default()
    };
    let mut log = UnitLog::open(directory, "api", options).expect("test step");
    for i in 1..=lines {
        log.ingest(format!("line {i}\n").as_bytes(), i)
            .expect("test step");
    }
    assert!(log.segments().iter().filter(|m| m.compressed).count() >= 3);
    assert!(log.segments()[0].index.len() >= 2);
    log
}

#[test]
/// Opening trusts closed segments' metadata instead of decompressing them, and
/// removes temporaries an interrupted compression or metadata write left behind.
fn open_loads_closed_metadata_without_decoding() {
    let directory = tempdir();
    let log = history(directory.path(), 3000);
    let closed = log.segments()[0].clone();
    let rebuilt = directory
        .path()
        .join(format!("{:020}.meta.json", log.segments()[1].first_seq));
    drop(log);
    // Same length, so the metadata stays valid; decoding would fail.
    fs::write(&closed.path, vec![0; closed.bytes as usize]).expect("test step");
    // A crash between compression and the metadata write costs one scan.
    fs::remove_file(&rebuilt).expect("test step");
    let zst_tmp = directory.path().join("00000000000000000001.log.zst.tmp");
    let json_tmp = directory.path().join("00000000000000000001.meta.json.tmp");
    fs::write(&zst_tmp, b"partial").expect("test step");
    fs::write(&json_tmp, b"{").expect("test step");
    let log = UnitLog::open(directory.path(), "api", LogOptions::default()).expect("test step");
    assert_eq!(log.segments()[0].path, closed.path);
    assert_eq!(log.next_sequence(), 3001);
    assert!(rebuilt.exists());
    assert!(!zst_tmp.exists() && !json_tmp.exists());
}

#[test]
/// One writer per directory; a read-only reader creates nothing and lists the
/// segments a crashed writer left, its torn record included.
fn writer_lock_and_read_only_reader() {
    let directory = tempdir();
    let missing = directory.path().join("missing");
    let reader = LogReader::open(&missing, "api").expect("test step");
    assert_eq!(reader.segments().len(), 0);
    assert!(!missing.exists());

    let run = directory.path().join("run");
    let options = LogOptions {
        segment_bytes: 30,
        ..Default::default()
    };
    let mut log = UnitLog::open(&run, "api", options.clone()).expect("test step");
    assert!(matches!(
        UnitLog::open(&run, "api", options.clone()),
        Err(Error::Locked)
    ));
    log.ingest(b"one long line\ntwo long line\n", 1)
        .expect("test step");
    log.flush().expect("test step");
    let tail = log.segments().last().expect("test step").path.clone();
    drop(log);
    fs::OpenOptions::new()
        .append(true)
        .open(&tail)
        .expect("test step")
        .write_all(b"3\t2\t")
        .expect("test step");
    let before = contents(&run);
    let reader = LogReader::open(&run, "api").expect("test step");
    assert_eq!(reader.segments().len(), 2);
    assert_eq!(contents(&run), before);

    // `finish` releases the lock while the value is still alive.
    let mut log = UnitLog::open(&run, "api", options.clone()).expect("test step");
    log.finish(3).expect("test step");
    let again = UnitLog::open(&run, "api", options).expect("test step");
    assert_eq!(again.next_sequence(), 3);
}

#[test]
/// A live run's share of the global budget removes oldest data first, and a zero
/// budget closes the active segment so it can go too.
fn trim_to_enforces_a_byte_budget() {
    let directory = tempdir();
    let mut log = history(directory.path(), 3000);
    let total = log.disk_bytes();
    let oldest = log.segments()[0].path.clone();
    let left = log.trim_to(total / 2).expect("test step");
    assert!(left <= total / 2);
    assert_eq!(left, log.disk_bytes());
    assert!(!oldest.exists());
    assert_eq!(log.trim_to(0).expect("test step"), 0);
    assert_eq!(log.segments().len(), 1);
    assert_eq!(listing(directory.path()), ["00000000000000003001.log"]);
    log.ingest(b"after\n", 4000).expect("test step");
    assert_eq!(log.next_sequence(), 3002);
}

#[test]
/// SGR colors survive in `styled`, end in a reset, carry over to the next line
/// while they stay set, and other escapes never reach either form.
fn styled_lines_keep_only_colors() {
    let mut framer = Framer::default();
    let mut frames = Vec::new();
    let input = b"\x1b[32mINFO\x1b[0m ready \x1b[2K\x1b[1;34mblue\nstill blue\x1b[0m\nplain\n";
    for split in 0..=input.len() {
        frames.clear();
        let mut framer_split = Framer::default();
        feed(&mut framer_split, &input[..split], 1, &mut frames);
        feed(&mut framer_split, &input[split..], 2, &mut frames);
        let texts: Vec<&str> = frames.iter().map(|f| f.text.as_str()).collect();
        assert_eq!(texts, ["INFO ready blue", "still blue", "plain"]);
        let styled: Vec<Option<&str>> = frames.iter().map(|f| f.styled.as_deref()).collect();
        assert_eq!(
            styled,
            [
                Some("\x1b[32mINFO\x1b[0m ready \x1b[1;34mblue\x1b[0m"),
                Some("\x1b[1;34mstill blue\x1b[0m\x1b[0m"),
                None,
            ]
        );
    }
    feed(&mut framer, b"no color\n", 3, &mut frames);
    assert_eq!(frames.last().expect("test step").styled, None);
}
