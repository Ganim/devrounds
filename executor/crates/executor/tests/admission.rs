//! Admission over a manual clock and a scripted pressure source. Every test
//! runs on a current-thread runtime with a timeout; time only moves on `tick`.

use std::{
    future::Future,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use async_trait::async_trait;
use devrounds_core::{
    Error,
    clock::{Clock, ManualClock},
    gate::{MemoryPressure, PressureSample, PressureSource, StartSlot},
};
use devrounds_executor::admission::{
    Admission, AdmissionConfig, AdmissionStep, Admitting, DEFAULT_MEMORY_NEED, DelayReason,
};

const GIB: u64 = 1 << 30;

/// Upper bound for every test body.
const LIMIT: Duration = Duration::from_secs(10);

async fn bounded<F: Future<Output = ()>>(body: F) {
    tokio::time::timeout(LIMIT, body)
        .await
        .expect("test timed out");
}

/// Lets the gate driver run after the clock moved.
async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

/// Advances the clock in one-second steps, letting the driver read after each.
async fn tick(clock: &ManualClock, seconds: u64) {
    for _ in 0..seconds {
        clock.advance(Duration::from_secs(1));
        settle().await;
    }
}

/// Scripted readings: system CPU and available memory, changed by the test.
#[derive(Default)]
struct Scripted {
    cpu: Mutex<f64>,
    memory: Mutex<MemoryPressure>,
    available: Mutex<Option<u64>>,
}

impl Scripted {
    fn new(cpu: f64, available: u64) -> Arc<Self> {
        Arc::new(Self {
            cpu: Mutex::new(cpu),
            memory: Mutex::new(MemoryPressure::Normal),
            available: Mutex::new(Some(available)),
        })
    }

    fn set_memory(&self, level: MemoryPressure) {
        *self.memory.lock().unwrap_or_else(PoisonError::into_inner) = level;
    }

    fn set_cpu(&self, cpu: f64) {
        *self.cpu.lock().unwrap_or_else(PoisonError::into_inner) = cpu;
    }

    fn set_available(&self, bytes: u64) {
        *self
            .available
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(bytes);
    }
}

#[async_trait]
impl PressureSource for Scripted {
    fn name(&self) -> &'static str {
        "scripted"
    }

    async fn sample(&self) -> Result<PressureSample, Error> {
        Ok(PressureSample {
            cpu_percent: Some(*self.cpu.lock().unwrap_or_else(PoisonError::into_inner)),
            memory: Some(*self.memory.lock().unwrap_or_else(PoisonError::into_inner)),
            cpu_stall_percent: None,
        })
    }

    async fn available_memory(&self) -> Result<Option<u64>, Error> {
        Ok(*self
            .available
            .lock()
            .unwrap_or_else(PoisonError::into_inner))
    }
}

fn admission(config: AdmissionConfig, pressure: Arc<Scripted>) -> (Admission, ManualClock) {
    let clock = ManualClock::new();
    let clock_dyn: Arc<dyn Clock> = Arc::new(clock.clone());
    (Admission::new(config, pressure, clock_dyn), clock)
}

/// Steps until admitted. Only a memory delay may come first: the second start
/// of a busy period waits for the gate's first memory reading.
async fn admitted(admitting: &mut Admitting) -> StartSlot {
    loop {
        match admitting.next().await {
            AdmissionStep::Admitted(slot) => return slot,
            AdmissionStep::Delayed { reason, .. } => assert_eq!(reason, DelayReason::Memory),
        }
    }
}

fn window(admission: &Admission) -> Option<usize> {
    admission.snapshot().window
}

#[tokio::test]
async fn memory_hold_reports_delayed_memory_then_admits() {
    bounded(async {
        let pressure = Scripted::new(10.0, GIB);
        let (admission, clock) = admission(AdmissionConfig::default(), pressure.clone());
        // The first start of a busy period never waits for memory.
        let _first = admitted(&mut admission.admit("run-1", "test", DEFAULT_MEMORY_NEED)).await;
        let mut second = admission.admit("run-2", "test", 2 * GIB);
        match second.next().await {
            AdmissionStep::Delayed {
                reason,
                position,
                need,
                available,
            } => {
                assert_eq!(reason, DelayReason::Memory);
                assert_eq!(position, 1);
                assert_eq!(need, 2 * GIB);
                assert_eq!(available, Some(GIB));
            }
            AdmissionStep::Admitted(_) => panic!("2 GiB does not fit in 1 GiB"),
        }
        pressure.set_available(4 * GIB);
        clock.advance(Duration::from_secs(1));
        let _second = match second.next().await {
            AdmissionStep::Admitted(slot) => slot,
            other => panic!("expected admission once memory fits, got {other:?}"),
        };
        assert_eq!(admission.snapshot().in_flight, 2);
    })
    .await;
}

/// The reason of a `Delayed` step; panics on `Admitted`.
fn delayed(step: AdmissionStep) -> DelayReason {
    match step {
        AdmissionStep::Delayed { reason, .. } => reason,
        AdmissionStep::Admitted(_) => panic!("expected a delay"),
    }
}

/// Memory, then critical memory pressure, then memory again: each change is
/// one `Delayed`, the return to `Memory` included.
#[tokio::test]
async fn every_change_of_reason_reports_once_back_to_memory_included() {
    bounded(async {
        let pressure = Scripted::new(10.0, GIB);
        let (admission, clock) = admission(AdmissionConfig::default(), pressure.clone());
        let _first = admitted(&mut admission.admit("run-1", "test", DEFAULT_MEMORY_NEED)).await;
        let mut second = admission.admit("run-2", "test", 2 * GIB);
        assert_eq!(delayed(second.next().await), DelayReason::Memory);
        pressure.set_memory(MemoryPressure::Critical);
        clock.advance(Duration::from_secs(1));
        assert_eq!(delayed(second.next().await), DelayReason::MemoryCritical);
        pressure.set_memory(MemoryPressure::Normal);
        clock.advance(Duration::from_secs(1));
        assert_eq!(delayed(second.next().await), DelayReason::Memory);
    })
    .await;
}

#[tokio::test]
async fn full_window_reports_delayed_concurrency() {
    bounded(async {
        let config = AdmissionConfig {
            initial_window: 1,
            ..AdmissionConfig::default()
        };
        let (admission, _clock) = admission(config, Scripted::new(10.0, 64 * GIB));
        let _held = admitted(&mut admission.admit("run-1", "test", DEFAULT_MEMORY_NEED)).await;
        let mut waiting = admission.admit("run-2", "test", DEFAULT_MEMORY_NEED);
        match waiting.next().await {
            AdmissionStep::Delayed {
                reason, position, ..
            } => {
                assert_eq!(reason, DelayReason::Concurrency);
                assert_eq!(position, 1);
            }
            AdmissionStep::Admitted(_) => panic!("the window of 1 is taken"),
        }
    })
    .await;
}

#[tokio::test]
async fn aimd_halves_on_high_cpu_and_grows_by_one() {
    bounded(async {
        let config = AdmissionConfig {
            initial_window: 8,
            ..AdmissionConfig::default()
        };
        let pressure = Scripted::new(98.0, 64 * GIB);
        let (admission, clock) = admission(config, pressure.clone());
        let mut slots = Vec::new();
        for index in 0..8 {
            let mut admitting = admission.admit(&format!("run-{index}"), "test", GIB / 4);
            slots.push(admitted(&mut admitting).await);
        }
        // A queued start makes the window the limit, so it may grow.
        let _queued = admission.admit("run-8", "test", GIB / 4);
        assert_eq!(window(&admission), Some(8));
        // The first reading of a busy period carries no CPU; 98% counts from
        // the reading at 1 s and halves once it held for `high_for` (3 s).
        tick(&clock, 3).await;
        assert_eq!(window(&admission), Some(8));
        tick(&clock, 1).await;
        assert_eq!(window(&admission), Some(4));
        // Headroom for `grow_every` (2 s) adds exactly one.
        pressure.set_cpu(50.0);
        tick(&clock, 2).await;
        assert_eq!(window(&admission), Some(4));
        tick(&clock, 1).await;
        assert_eq!(window(&admission), Some(5));
        tick(&clock, 1).await;
        assert_eq!(window(&admission), Some(5));
    })
    .await;
}

#[tokio::test]
async fn dropping_admitting_leaves_the_queue() {
    bounded(async {
        let config = AdmissionConfig {
            initial_window: 1,
            ..AdmissionConfig::default()
        };
        let (admission, _clock) = admission(config, Scripted::new(10.0, 64 * GIB));
        let _held = admitted(&mut admission.admit("run-1", "test", DEFAULT_MEMORY_NEED)).await;
        let waiting = admission.admit("run-2", "test", DEFAULT_MEMORY_NEED);
        assert_eq!(admission.snapshot().queued.len(), 1);
        drop(waiting);
        assert!(admission.snapshot().queued.is_empty());
    })
    .await;
}

#[test]
fn need_defaults_to_512_mib() {
    assert_eq!(DEFAULT_MEMORY_NEED, 536_870_912);
}
