//! Ring, percentile, run summary and baseline math.

use std::time::Duration;

use devrounds_metrics::{
    BaselinePolicy, ByteSummary, CpuSummary, JobTotals, QuantileSketch, Ring, RunSummary,
    RunTracker, Sample, Subject, baseline,
};

/// Builds a run-total sample.
fn run_sample(run: &str, ts_ms: u64, cpu: f64, footprint: u64) -> Sample {
    Sample {
        subject: Subject::Run { run: run.into() },
        cpu_percent: cpu,
        footprint_bytes: footprint,
        rss_bytes: footprint / 2,
        ts_ms,
    }
}

#[test]
fn ring_evicts_oldest_when_full() {
    let mut ring = Ring::new(3);
    assert_eq!(ring.push(1), None);
    assert_eq!(ring.push(2), None);
    assert_eq!(ring.push(3), None);
    assert_eq!(ring.push(4), Some(1));
    assert_eq!(ring.iter().copied().collect::<Vec<_>>(), [2, 3, 4]);
    assert_eq!(
        (ring.first(), ring.last(), ring.len()),
        (Some(&2), Some(&4), 3)
    );
    assert_eq!(Ring::<u8>::new(0).capacity(), 1);
}

#[test]
fn sketch_quantiles_stay_within_relative_accuracy() {
    let mut sketch = QuantileSketch::default();
    assert_eq!(sketch.quantile(0.5), None);
    for value in 1..=1_000 {
        sketch.add(f64::from(value));
    }
    let close = |actual: f64, expected: f64| (actual - expected).abs() <= expected * 0.01 + 1e-9;
    let p50 = sketch.quantile(0.5).expect("p50");
    let p95 = sketch.quantile(0.95).expect("p95");
    // Lower ranks: floor(0.5 * 999) = 499 (value 500), floor(0.95 * 999) = 949 (value 950).
    assert!(close(p50, 500.0), "p50 {p50}");
    assert!(close(p95, 950.0), "p95 {p95}");
    assert_eq!(sketch.quantile(0.0), Some(1.0));
    assert_eq!(sketch.quantile(1.0), Some(1_000.0));
    assert_eq!(sketch.max(), Some(1_000.0));

    let mut zeros = QuantileSketch::default();
    for value in [0.0, 0.0, 0.0, 50.0, f64::NAN, -3.0] {
        zeros.add(value);
    }
    assert_eq!(zeros.count(), 5);
    assert_eq!(zeros.quantile(0.5), Some(0.0));
    assert_eq!(zeros.quantile(1.0), Some(50.0));
}

#[test]
fn run_tracker_summarizes_only_its_run_and_window() {
    let mut tracker = RunTracker::default();
    tracker.start("run-7".into(), 10_000);
    tracker.observe(&run_sample("run-7", 9_000, 999.0, 999_999));
    tracker.observe(&run_sample("run-8", 11_000, 999.0, 999_999));
    let samples: Vec<Sample> = (1..=100)
        .map(|i| run_sample("run-7", 10_000 + i * 1_000, i as f64, i * 1_000))
        .collect();
    tracker.observe_all(&samples);
    let live = tracker.current("run-7").expect("live");
    assert_eq!((live.samples, live.ended_ms), (100, 110_000));

    let job = JobTotals {
        peak_bytes: 0,
        cpu_seconds: 12.5,
    };
    let summary = tracker.finish("run-7", 200_000, job).expect("summary");
    assert!(tracker.current("run-7").is_none());
    assert_eq!(summary.run, "run-7");
    assert_eq!(summary.samples, 100);
    assert_eq!(summary.duration(), Duration::from_secs(190));
    assert_eq!(summary.footprint.peak, 100_000);
    assert_eq!(summary.cpu.peak, 100.0);
    assert_eq!(summary.rss_peak, 50_000);
    // The job's CPU time, not anything derived from the samples.
    assert_eq!(summary.cpu_seconds, 12.5);
    let within = |actual: f64, expected: f64| (actual - expected).abs() <= expected * 0.01;
    assert!(
        within(summary.footprint.p50 as f64, 50_000.0),
        "{:?}",
        summary.footprint
    );
    assert!(
        within(summary.footprint.p95 as f64, 95_000.0),
        "{:?}",
        summary.footprint
    );
    assert!(within(summary.cpu.p95, 95.0), "{:?}", summary.cpu);
    assert!(tracker.finish("run-99", 1, JobTotals::default()).is_none());
}

#[test]
fn summary_reports_p50_p95_peak() {
    const MIB: u64 = 1 << 20;
    let mut tracker = RunTracker::default();
    tracker.start("run-1".into(), 0);
    let samples: Vec<Sample> = (100..=200)
        .map(|mib| run_sample("run-1", mib * 1_000, 0.0, mib * MIB))
        .collect();
    tracker.observe_all(&samples);
    // A job peak below the sampled one leaves the sampled peak.
    let job = |peak_bytes| JobTotals {
        peak_bytes,
        cpu_seconds: 0.0,
    };
    let summary = tracker
        .finish("run-1", 201_000, job(150 * MIB))
        .expect("summary");
    assert_eq!(summary.samples, 101);
    // Lower rank floor(0.95 * 100) = 95: the 195 MiB sample.
    let p95 = summary.footprint.p95 as f64;
    let expected = (195 * MIB) as f64;
    assert!((p95 - expected).abs() <= expected * 0.01, "{summary:?}");
    let p50 = summary.footprint.p50 as f64;
    let expected = (150 * MIB) as f64;
    assert!((p50 - expected).abs() <= expected * 0.01, "{summary:?}");
    assert_eq!(summary.footprint.peak, 200 * MIB);

    // The job's peak counts when it saw more than any sample.
    tracker.start("run-2".into(), 0);
    tracker.observe(&run_sample("run-2", 1_000, 0.0, 10 * MIB));
    let summary = tracker
        .finish("run-2", 2_000, job(300 * MIB))
        .expect("summary");
    assert_eq!(summary.footprint.peak, 300 * MIB);
}

/// Builds a finished run summary with the given p95 values.
fn run(id: u32, ended_ms: u64, duration_s: u64, footprint_p95: u64, cpu_p95: f64) -> RunSummary {
    RunSummary {
        run: format!("run-{id}"),
        started_ms: ended_ms - duration_s * 1_000,
        ended_ms,
        samples: duration_s,
        footprint: ByteSummary {
            p50: footprint_p95 / 2,
            p95: footprint_p95,
            peak: footprint_p95 * 2,
        },
        cpu: CpuSummary {
            p50: cpu_p95 / 2.0,
            p95: cpu_p95,
            peak: cpu_p95 * 2.0,
        },
        rss_peak: 0,
        cpu_seconds: 0.0,
    }
}

#[test]
fn baseline_is_median_of_recent_qualifying_p95() {
    let policy = BaselinePolicy {
        runs: 3,
        min_duration: Duration::from_secs(120),
    };
    assert_eq!(baseline(&[], policy), None);
    let runs = [
        run(1, 1_000_000, 600, 900, 90.0), // oldest, outside the last 3
        run(2, 2_000_000, 600, 300, 30.0),
        run(3, 3_000_000, 60, 5_000, 500.0), // too short
        run(4, 4_000_000, 600, 100, 10.0),
        run(5, 5_000_000, 600, 200, 20.0),
    ];
    let result = baseline(&runs, policy).expect("baseline");
    assert_eq!(
        (result.footprint_p95, result.cpu_p95, result.runs),
        (200, 20.0, 3)
    );

    let even = BaselinePolicy { runs: 4, ..policy };
    let result = baseline(&runs, even).expect("baseline");
    // p95s 900, 300, 100, 200 -> median of the middle pair (200, 300).
    assert_eq!(
        (result.footprint_p95, result.cpu_p95, result.runs),
        (250, 25.0, 4)
    );

    let defaults = BaselinePolicy::default();
    assert_eq!(
        (defaults.runs, defaults.min_duration),
        (10, Duration::from_secs(120))
    );
}

#[test]
fn subjects_are_serde_tagged() {
    let subject = Subject::Process {
        run: "run-1".into(),
        pid: 42,
        start_time: 7,
    };
    let json = serde_json::to_value(&subject).expect("serialize");
    assert_eq!(
        json,
        serde_json::json!({"kind": "process", "run": "run-1", "pid": 42, "start_time": 7})
    );
    assert_eq!(subject.run(), Some("run-1"));
    assert_eq!(Subject::Daemon.run(), None);
}
