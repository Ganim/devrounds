//! `devrounds-executor run`: config, home lock, store, connection, admission
//! and the run loop of one executor process.

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use devrounds_core::{
    DrError,
    clock::{Clock, TokioClock},
    gate::MemoryPressure,
};
use devrounds_executor::{
    admission::Admission,
    config::{self, HomeLock, STORE_FILE},
    connection::{Connection, Handler},
    runs::{RunLoop, RunLoopDeps},
};
use devrounds_metrics_windows::WindowsPressure;
use devrounds_protocol::{MachineReport, ServerMessage};
use devrounds_runner_windows::WindowsRunner;
use devrounds_store::Store;
use devrounds_sys_windows::{proc, usage};
use serde_json::json;
use tokio::sync::watch;

/// How often the machine figures of `MachineReport` are read.
const FIGURES_EVERY: Duration = Duration::from_secs(5);

pub async fn serve() -> Result<(), DrError> {
    let home = config::executor_home()?;
    config::prepare_home(&home).await?;
    let _lock = HomeLock::acquire(&home).await?;
    let (config, token) = config::load_pairing(&home).await?;
    let store = Store::open(&home.join(STORE_FILE)).await?;
    let connection = Connection::new(store.clone());
    let clock: Arc<dyn Clock> = Arc::new(TokioClock::new());
    let admission = Admission::new(config.admission, Arc::new(WindowsPressure::new()), clock);
    // Names and values that are not Unicode cannot be allowlisted by name, so
    // no run could receive them anyway.
    let machine_env: BTreeMap<String, String> = std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect();
    let runs = RunLoop::new(RunLoopDeps {
        store,
        admission: Arc::new(admission),
        runner: WindowsRunner::default(),
        connected: connection.connected(),
        runs_dir: home.join("runs"),
        machine_env,
    });
    let boot_id = tokio::task::spawn_blocking(proc::boot_id)
        .await
        .map_err(|error| internal(&error))?
        .map_err(|error| internal(&error))?;
    let mut machine = Machine {
        boot_id,
        runs,
        figures: figures(),
    };
    connection.run(&config, &token, &mut machine).await
}

fn internal(error: &dyn std::fmt::Display) -> DrError {
    DrError::new("DR501", json!({ "reason": error.to_string() }))
}

struct Machine {
    boot_id: String,
    runs: RunLoop,
    figures: watch::Receiver<Figures>,
}

impl Handler for Machine {
    fn boot_id(&self) -> String {
        self.boot_id.clone()
    }

    fn report(&mut self) -> MachineReport {
        let figures = *self.figures.borrow();
        MachineReport {
            total_memory: figures.total_memory,
            available_memory: figures.available_memory,
            commit_total: figures.commit_total,
            commit_limit: figures.commit_limit,
            cpu_percent: figures.cpu_percent,
            memory_pressure: figures.memory_pressure,
            running: self.runs.running(),
            executor_private_bytes: figures.executor_private_bytes,
        }
    }

    fn on_message(&mut self, message: ServerMessage) {
        self.runs.handle(message);
    }
}

/// The latest machine readings; zeros until the first one.
#[derive(Debug, Clone, Copy)]
struct Figures {
    total_memory: u64,
    available_memory: u64,
    commit_total: u64,
    commit_limit: u64,
    cpu_percent: f64,
    memory_pressure: MemoryPressure,
    executor_private_bytes: u64,
}

/// What a reading that failed reports.
const NO_FIGURES: Figures = Figures {
    total_memory: 0,
    available_memory: 0,
    commit_total: 0,
    commit_limit: 0,
    cpu_percent: 0.0,
    memory_pressure: MemoryPressure::Normal,
    executor_private_bytes: 0,
};

/// Reads the figures every [`FIGURES_EVERY`] off the async threads. Its own
/// pressure source: CPU is the busy share since the source's previous read,
/// so sharing admission's would shorten both intervals.
fn figures() -> watch::Receiver<Figures> {
    let (tx, rx) = watch::channel(NO_FIGURES);
    let pressure = Arc::new(WindowsPressure::new());
    tokio::spawn(async move {
        let mut every = tokio::time::interval(FIGURES_EVERY);
        loop {
            every.tick().await;
            let pressure = Arc::clone(&pressure);
            let read = tokio::task::spawn_blocking(move || {
                let mut figures = NO_FIGURES;
                if let Ok(sample) = pressure.sample_blocking() {
                    figures.cpu_percent = sample.cpu_percent.unwrap_or(0.0);
                    figures.memory_pressure = sample.memory.unwrap_or(MemoryPressure::Normal);
                }
                if let Ok(memory) = usage::memory_status() {
                    figures.total_memory = memory.total_physical;
                    figures.available_memory = memory.available_physical;
                    figures.commit_total = memory.commit_total;
                    figures.commit_limit = memory.commit_limit;
                }
                figures.executor_private_bytes = usage::self_private_bytes().unwrap_or(0);
                figures
            })
            .await;
            match read {
                Ok(figures) => {
                    if tx.send(figures).is_err() {
                        return;
                    }
                }
                Err(error) => eprintln!("devrounds-executor: machine figures not read: {error}"),
            }
        }
    });
    rx
}
