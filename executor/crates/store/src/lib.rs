//! The executor's local state in one SQLite file (`<home>/executor.db`): the
//! runs it has in flight and the outbox of events the control plane has not
//! acked yet. Every event is appended here before it is sent, so a control
//! plane restart or a dropped socket loses nothing: the connection resends
//! what is left after the next `HelloAck`.
//!
//! One `std::thread` owns the `rusqlite::Connection` and runs requests in
//! arrival order; async callers wait on a `oneshot`, so no SQLite call ever
//! blocks the tokio runtime.

use std::collections::BTreeSet;
use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::{Arc, mpsc};

use devrounds_core::{DrError, JobSpec, ProcessIdentity};
use devrounds_protocol::{ClientMessage, Event, RunEvent, decode_client, encode_client};
use rusqlite::{Connection, Row, params};
use serde_json::json;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::{oneshot, watch};

/// `outbox.seq` is AUTOINCREMENT so a seq is never reused once its row is
/// acked and deleted: the control plane keeps the last applied seq per
/// machine and treats anything at or below it as a duplicate.
const SCHEMA: &str = "
create table if not exists runs (
    run_id text primary key,
    job_json text not null,
    state text not null,
    leader_pid integer,
    leader_start_time integer,
    boot_id text,
    run_dir text not null,
    members_json text not null
);
create table if not exists outbox (
    seq integer primary key autoincrement,
    message text not null
);
create table if not exists meta (
    key text primary key,
    value text not null
);
insert or ignore into meta (key, value) values ('schema', '1');
create index if not exists outbox_run on outbox (json_extract(message, '$.event.run'));
";

// Both name the run exactly as `outbox_run` indexes it: SQLite uses an
// expression index only for the same expression text.
const KNOWS_RUN: &str = "select exists (select 1 from runs where run_id = ?1)
    or exists (select 1 from outbox where json_extract(message, '$.event.run') = ?1)";
const OUTBOX_RUNS: &str = "select distinct json_extract(message, '$.event.run') from outbox
    where json_extract(message, '$.event.run') is not null";

/// A run the executor started or is about to start, kept until it ends so a
/// restarted executor can find it again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRun {
    pub run_id: String,
    /// Env names only, never values.
    pub job: JobSpec,
    pub state: String,
    /// Set once the leader process exists.
    pub identity: Option<RunIdentity>,
    pub run_dir: PathBuf,
    /// Processes of the run's job seen so far.
    pub members: Vec<ProcessIdentity>,
}

/// The leader process of a run: `(pid, start_time)` survive PID reuse only
/// within one boot, hence `boot_id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunIdentity {
    pub pid: u32,
    pub start_time: u64,
    pub boot_id: String,
}

type Failure = Box<dyn Error + Send + Sync>;
type Request = Box<dyn FnOnce(&mut Connection) + Send>;

/// A handle to the store thread; clones share it. The thread ends, closing
/// the file, when the last handle drops.
#[derive(Clone)]
pub struct Store {
    inner: Arc<Inner>,
}

struct Inner {
    path: PathBuf,
    requests: mpsc::Sender<Request>,
    /// The highest seq appended by this process, for the connection to wake on.
    appended: watch::Sender<u64>,
    /// The highest seq acked in this process, for local copies that wait on it.
    acked: watch::Sender<u64>,
}

impl Store {
    /// Opens (creating if missing) the store at `path`. DR550 when the file
    /// cannot be opened or is not a usable database.
    pub async fn open(path: &Path) -> Result<Store, DrError> {
        let (requests, receiver) = mpsc::channel::<Request>();
        let (ready, opened) = oneshot::channel();
        let file = path.to_path_buf();
        std::thread::Builder::new()
            .name("devrounds-store".to_owned())
            .spawn(move || {
                let opened = Connection::open(&file)
                    .and_then(|connection| connection.execute_batch(SCHEMA).map(|()| connection));
                let mut connection = match opened {
                    Ok(connection) => {
                        let _ = ready.send(Ok(()));
                        connection
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error.to_string()));
                        return;
                    }
                };
                while let Ok(request) = receiver.recv() {
                    request(&mut connection);
                }
            })
            .map_err(|error| unusable(path, &error.to_string()))?;
        opened
            .await
            .map_err(|_| unusable(path, STOPPED))?
            .map_err(|reason| unusable(path, &reason))?;
        Ok(Store {
            inner: Arc::new(Inner {
                path: path.to_path_buf(),
                requests,
                appended: watch::Sender::new(0),
                acked: watch::Sender::new(0),
            }),
        })
    }

    /// Changes whenever this process appends an event; the value is the
    /// highest seq appended so far.
    pub fn appended(&self) -> watch::Receiver<u64> {
        self.inner.appended.subscribe()
    }

    /// Stamps `event` with the current UTC time and the next seq, and keeps
    /// it as the `Event` frame to send until the control plane acks it.
    pub async fn append_event(&self, event: RunEvent) -> Result<u64, DrError> {
        let at = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(|error| self.unusable(&error.to_string()))?;
        let seq = self
            .call(move |connection| {
                let trx = connection.transaction()?;
                // The seq is the row id, so the frame that names it is written second. The
                // placeholder is JSON for the `outbox_run` index, which reads every message.
                trx.execute("insert into outbox (message) values ('{}')", [])?;
                let seq = u64::try_from(trx.last_insert_rowid())?;
                let message = encode_client(&ClientMessage::Event(Event { seq, at, event }))?;
                trx.execute(
                    "update outbox set message = ?1 where seq = ?2",
                    params![message, seq],
                )?;
                trx.commit()?;
                Ok(seq)
            })
            .await?;
        self.inner.appended.send_if_modified(|highest| {
            let higher = seq > *highest;
            if higher {
                *highest = seq;
            }
            higher
        });
        Ok(seq)
    }

    /// Moves this store's seqs past `last_seq`, the control plane's last
    /// applied seq, when it has never appended that far: the store file was
    /// replaced or deleted while the machine kept its pairing. Otherwise the
    /// control plane would take every new event up to `last_seq` for a
    /// duplicate and drop it. Kept events were never applied, so they are
    /// renumbered after `last_seq` in their order. True when it moved.
    pub async fn raise_floor(&self, last_seq: u64) -> Result<bool, DrError> {
        self.call(move |connection| {
            let trx = connection.transaction()?;
            let highest: u64 = trx.query_row(
                "select coalesce((select seq from sqlite_sequence where name = 'outbox'), 0)",
                [],
                |row| row.get(0),
            )?;
            if last_seq <= highest {
                return Ok(false);
            }
            let kept: Vec<String> = {
                let mut statement = trx.prepare("select message from outbox order by seq")?;
                let rows = statement.query_map([], |row| row.get(0))?;
                rows.collect::<Result<_, _>>()?
            };
            trx.execute("delete from outbox", [])?;
            let mut next = last_seq;
            for frame in kept {
                let ClientMessage::Event(mut event) = decode_client(&frame)? else {
                    return Err("the outbox holds a frame that is not an Event".into());
                };
                next += 1;
                event.seq = next;
                trx.execute(
                    "insert into outbox (seq, message) values (?1, ?2)",
                    params![next, encode_client(&ClientMessage::Event(event))?],
                )?;
            }
            // With nothing kept, nothing above moved the sequence.
            let moved = trx.execute(
                "update sqlite_sequence set seq = ?1 where name = 'outbox'",
                params![next],
            )?;
            if moved == 0 {
                trx.execute(
                    "insert into sqlite_sequence (name, seq) values ('outbox', ?1)",
                    params![next],
                )?;
            }
            trx.commit()?;
            Ok(true)
        })
        .await
    }

    /// Changes whenever an ack moves past the highest seq acked so far in this
    /// process; the value is that seq.
    pub fn acked(&self) -> watch::Receiver<u64> {
        self.inner.acked.subscribe()
    }

    /// Drops every event up to and including `seq`: the control plane has applied them.
    pub async fn ack_through(&self, seq: u64) -> Result<(), DrError> {
        self.call(move |connection| {
            connection.execute("delete from outbox where seq <= ?1", params![seq])?;
            Ok(())
        })
        .await?;
        self.inner.acked.send_if_modified(|highest| {
            let higher = seq > *highest;
            if higher {
                *highest = seq;
            }
            higher
        });
        Ok(())
    }

    /// The next frames kept after `seq`, in seq order, holding at most
    /// `max_bytes` of frame text: what the connection resends after a
    /// reconnect, a page at a time, so a backlog of segments never sits in
    /// memory at once. The first frame always comes, even past the budget, so
    /// paging moves on; empty once nothing is left.
    pub async fn pending_page(
        &self,
        seq: u64,
        max_bytes: usize,
    ) -> Result<Vec<(u64, String)>, DrError> {
        self.call(move |connection| {
            // Bytes, not characters: a blob's length. The text column is only
            // fetched for frames that fit, so the stop costs no frame copy.
            let mut statement = connection.prepare(
                "select seq, length(cast(message as blob)), message from outbox where seq > ?1 order by seq",
            )?;
            let mut rows = statement.query(params![seq])?;
            let mut page = Vec::new();
            let mut used = 0usize;
            while let Some(row) = rows.next()? {
                let length = usize::try_from(row.get::<_, i64>(1)?)?;
                if !page.is_empty() && used + length > max_bytes {
                    break;
                }
                used += length;
                page.push((row.get(0)?, row.get(2)?));
            }
            Ok(page)
        })
        .await
    }

    /// Every frame kept after `seq`, in seq order, with no bound: for tests
    /// and inspection. The connection pages with [`Store::pending_page`].
    pub async fn pending_after(&self, seq: u64) -> Result<Vec<(u64, String)>, DrError> {
        self.call(move |connection| {
            let mut statement = connection
                .prepare("select seq, message from outbox where seq > ?1 order by seq")?;
            let rows = statement.query_map(params![seq], |row| Ok((row.get(0)?, row.get(1)?)))?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
        .await
    }

    /// Inserts or replaces `run`.
    pub async fn put_run(&self, run: StoredRun) -> Result<(), DrError> {
        self.call(move |connection| {
            let run_dir = run
                .run_dir
                .to_str()
                .ok_or_else(|| format!("run dir {} is not UTF-8", run.run_dir.display()))?;
            let identity = run.identity.as_ref();
            connection.execute(
                "insert or replace into runs
                    (run_id, job_json, state, leader_pid, leader_start_time, boot_id, run_dir, members_json)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    run.run_id,
                    serde_json::to_string(&run.job)?,
                    run.state,
                    identity.map(|identity| identity.pid),
                    identity.map(|identity| identity.start_time),
                    identity.map(|identity| identity.boot_id.as_str()),
                    run_dir,
                    serde_json::to_string(&run.members)?,
                ],
            )?;
            Ok(())
        })
        .await
    }

    /// Records the leader process of `run`.
    pub async fn set_identity(&self, run: &str, identity: RunIdentity) -> Result<(), DrError> {
        let run = run.to_owned();
        self.call(move |connection| {
            connection.execute(
                "update runs set leader_pid = ?2, leader_start_time = ?3, boot_id = ?4 where run_id = ?1",
                params![run, identity.pid, identity.start_time, identity.boot_id],
            )?;
            Ok(())
        })
        .await
    }

    /// Replaces the processes known to belong to `run`.
    pub async fn record_members(
        &self,
        run: &str,
        members: Vec<ProcessIdentity>,
    ) -> Result<(), DrError> {
        let run = run.to_owned();
        self.call(move |connection| {
            connection.execute(
                "update runs set members_json = ?2 where run_id = ?1",
                params![run, serde_json::to_string(&members)?],
            )?;
            Ok(())
        })
        .await
    }

    /// Every run not forgotten yet, in the order they were first put.
    pub async fn runs_in_flight(&self) -> Result<Vec<StoredRun>, DrError> {
        self.call(|connection| {
            let mut statement = connection.prepare(
                "select run_id, job_json, state, leader_pid, leader_start_time, boot_id, run_dir, members_json
                 from runs order by rowid",
            )?;
            let mut rows = statement.query([])?;
            let mut runs = Vec::new();
            while let Some(row) = rows.next()? {
                runs.push(stored_run(row)?);
            }
            Ok(runs)
        })
        .await
    }

    /// Whether this store still knows `run`: it is in flight, or an event of
    /// it waits in the outbox (a run that ended is forgotten as soon as its
    /// `RunFinished` is appended, before the control plane applied it).
    pub async fn knows_run(&self, run: &str) -> Result<bool, DrError> {
        let run = run.to_owned();
        self.call(move |connection| {
            let known: bool = connection.query_row(KNOWS_RUN, params![run], |row| row.get(0))?;
            Ok(known)
        })
        .await
    }

    /// The runs named by an event still in the outbox.
    pub async fn outbox_runs(&self) -> Result<BTreeSet<String>, DrError> {
        self.call(|connection| {
            let mut statement = connection.prepare(OUTBOX_RUNS)?;
            let rows = statement.query_map([], |row| row.get(0))?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
        .await
    }

    /// Drops `run` once it has ended and its last event is in the outbox.
    pub async fn forget_run(&self, run: &str) -> Result<(), DrError> {
        let run = run.to_owned();
        self.call(move |connection| {
            connection.execute("delete from runs where run_id = ?1", params![run])?;
            Ok(())
        })
        .await
    }

    /// Runs `work` on the store thread and waits for its answer.
    async fn call<T, F>(&self, work: F) -> Result<T, DrError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, Failure> + Send + 'static,
    {
        let (reply, answer) = oneshot::channel();
        self.inner
            .requests
            .send(Box::new(move |connection| {
                let _ = reply.send(work(connection));
            }))
            .map_err(|_| self.unusable(STOPPED))?;
        answer
            .await
            .map_err(|_| self.unusable(STOPPED))?
            .map_err(|error| self.unusable(&error.to_string()))
    }

    fn unusable(&self, reason: &str) -> DrError {
        unusable(&self.inner.path, reason)
    }
}

const STOPPED: &str = "the store thread stopped";

fn unusable(path: &Path, reason: &str) -> DrError {
    DrError::new(
        "DR550",
        json!({ "path": path.display().to_string(), "reason": reason }),
    )
}

fn stored_run(row: &Row<'_>) -> Result<StoredRun, Failure> {
    let pid: Option<u32> = row.get(3)?;
    let start_time: Option<u64> = row.get(4)?;
    let boot_id: Option<String> = row.get(5)?;
    let identity = match (pid, start_time, boot_id) {
        (Some(pid), Some(start_time), Some(boot_id)) => Some(RunIdentity {
            pid,
            start_time,
            boot_id,
        }),
        _ => None,
    };
    Ok(StoredRun {
        run_id: row.get(0)?,
        job: serde_json::from_str(&row.get::<_, String>(1)?)?,
        state: row.get(2)?,
        identity,
        run_dir: PathBuf::from(row.get::<_, String>(6)?),
        members: serde_json::from_str(&row.get::<_, String>(7)?)?,
    })
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::{KNOWS_RUN, OUTBOX_RUNS, SCHEMA};

    fn plan(connection: &Connection, sql: &str) -> String {
        let mut statement = connection
            .prepare(&format!("explain query plan {sql}"))
            .expect("prepare");
        let run = vec!["run"; statement.parameter_count()];
        let details = statement
            .query_map(rusqlite::params_from_iter(run), |row| {
                row.get::<_, String>(3)
            })
            .expect("plan")
            .collect::<Result<Vec<_>, _>>()
            .expect("rows");
        details.join("; ")
    }

    // The outbox holds every event not acked yet, which can be many while the
    // control plane is unreachable; an Offer and each sweep look runs up in it.
    #[test]
    fn outbox_lookups_by_run_use_the_index() {
        let connection = Connection::open_in_memory().expect("open");
        connection.execute_batch(SCHEMA).expect("schema");

        for sql in [KNOWS_RUN, OUTBOX_RUNS] {
            let plan = plan(&connection, sql);
            assert!(plan.contains("outbox_run"), "{plan}");
        }
    }
}
