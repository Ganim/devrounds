use std::{collections::HashMap, time::Duration};

use serde::{Deserialize, Serialize};

use crate::{QuantileSketch, Sample, Subject};

/// Median, 95th percentile and peak of a byte series.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ByteSummary {
    pub p50: u64,
    pub p95: u64,
    pub peak: u64,
}

/// Median, 95th percentile and peak of a CPU percent series.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct CpuSummary {
    pub p50: f64,
    pub p95: f64,
    pub peak: f64,
}

/// Resource profile of one run, computed from its run-total samples.
/// Percentiles are sketch estimates within 1%. The footprint peak is the
/// larger of the sampled peak and the job's own peak, which the kernel keeps
/// exactly; the CPU and RSS peaks are sampled.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunSummary {
    pub run: String,
    pub started_ms: u64,
    pub ended_ms: u64,
    pub samples: u64,
    pub footprint: ByteSummary,
    pub cpu: CpuSummary,
    pub rss_peak: u64,
    /// CPU time the run used, in seconds: each sample's share of a core over
    /// the time since the previous sample (or the start).
    pub cpu_seconds: f64,
}

impl RunSummary {
    /// Wall-clock length of the run.
    pub fn duration(&self) -> Duration {
        Duration::from_millis(self.ended_ms.saturating_sub(self.started_ms))
    }
}

#[derive(Debug, Clone)]
struct ActiveRun {
    started_ms: u64,
    last_ms: u64,
    footprint: QuantileSketch,
    cpu: QuantileSketch,
    rss_peak: u64,
    cpu_seconds: f64,
}

impl ActiveRun {
    /// Builds the summary as of `ended_ms`, with `job_peak` (0 when unknown)
    /// raising the footprint peak.
    fn summary(&self, run: String, ended_ms: u64, job_peak: u64) -> RunSummary {
        let bytes = |q: f64| self.footprint.quantile(q).map_or(0, |v| v.round() as u64);
        let cpu = |q: f64| self.cpu.quantile(q).unwrap_or(0.0);
        RunSummary {
            run,
            started_ms: self.started_ms,
            ended_ms,
            samples: self.footprint.count(),
            footprint: ByteSummary {
                p50: bytes(0.5),
                p95: bytes(0.95),
                peak: self.footprint.max().map_or(0, |v| v as u64).max(job_peak),
            },
            cpu: CpuSummary {
                p50: cpu(0.5),
                p95: cpu(0.95),
                peak: self.cpu.max().unwrap_or(0.0),
            },
            rss_peak: self.rss_peak,
            cpu_seconds: self.cpu_seconds,
        }
    }
}

/// Builds per-run summaries from [`Subject::Run`] samples.
#[derive(Debug, Clone, Default)]
pub struct RunTracker {
    runs: HashMap<String, ActiveRun>,
}

impl RunTracker {
    /// Starts tracking a run. Restarting an id discards its previous data.
    pub fn start(&mut self, run: String, started_ms: u64) {
        self.runs.insert(
            run,
            ActiveRun {
                started_ms,
                last_ms: started_ms,
                footprint: QuantileSketch::default(),
                cpu: QuantileSketch::default(),
                rss_peak: 0,
                cpu_seconds: 0.0,
            },
        );
    }

    /// Feeds a run-total sample to its run. Other subjects, unknown runs and
    /// samples taken before the run started are ignored.
    pub fn observe(&mut self, sample: &Sample) {
        let Subject::Run { run } = &sample.subject else {
            return;
        };
        let Some(active) = self.runs.get_mut(run) else {
            return;
        };
        if sample.ts_ms >= active.started_ms {
            active.footprint.add(sample.footprint_bytes as f64);
            active.cpu.add(sample.cpu_percent);
            active.rss_peak = active.rss_peak.max(sample.rss_bytes);
            // Collectors report CPU as the share since their previous reading,
            // so share times the gap since the previous sample is CPU time.
            let gap_ms = sample.ts_ms.saturating_sub(active.last_ms);
            active.cpu_seconds += sample.cpu_percent.max(0.0) / 100.0 * gap_ms as f64 / 1000.0;
            active.last_ms = active.last_ms.max(sample.ts_ms);
        }
    }

    /// Feeds every sample through [`RunTracker::observe`].
    pub fn observe_all(&mut self, samples: &[Sample]) {
        samples.iter().for_each(|sample| self.observe(sample));
    }

    /// Returns the live summary of an active run, ending at its latest sample.
    pub fn current(&self, run: &str) -> Option<RunSummary> {
        self.runs
            .get(run)
            .map(|active| active.summary(run.to_owned(), active.last_ms, 0))
    }

    /// Stops tracking a run and returns its final summary for persistence.
    /// `job_peak` is the most memory the run's job ever committed at once
    /// (0 when unknown); the footprint peak is the larger of it and the
    /// sampled peak, so a spike between samples still counts.
    pub fn finish(&mut self, run: &str, ended_ms: u64, job_peak: u64) -> Option<RunSummary> {
        self.runs
            .remove(run)
            .map(|active| active.summary(run.to_owned(), ended_ms.max(active.started_ms), job_peak))
    }
}

/// Which past runs count toward a baseline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BaselinePolicy {
    /// Most recent qualifying runs to use.
    pub runs: usize,
    /// Shorter runs are skipped: they mostly measure startup.
    pub min_duration: Duration,
}

impl Default for BaselinePolicy {
    /// Uses the last 10 runs of at least 2 minutes.
    fn default() -> Self {
        Self {
            runs: 10,
            min_duration: Duration::from_secs(120),
        }
    }
}

/// Typical load of a job type: the median of recent runs' p95 values.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Baseline {
    pub footprint_p95: u64,
    pub cpu_p95: f64,
    /// Number of runs the medians were taken over.
    pub runs: usize,
}

/// Computes a baseline from one job type's past runs, in any order. Runs without
/// samples or shorter than the policy minimum are ignored; the newest
/// `policy.runs` by end time are used. Returns `None` when no run qualifies.
pub fn baseline(runs: &[RunSummary], policy: BaselinePolicy) -> Option<Baseline> {
    let mut recent: Vec<&RunSummary> = runs
        .iter()
        .filter(|run| run.samples > 0 && run.duration() >= policy.min_duration)
        .collect();
    recent.sort_unstable_by_key(|run| std::cmp::Reverse(run.ended_ms));
    recent.truncate(policy.runs.max(1));
    let mut footprint: Vec<f64> = recent.iter().map(|run| run.footprint.p95 as f64).collect();
    let mut cpu: Vec<f64> = recent.iter().map(|run| run.cpu.p95).collect();
    Some(Baseline {
        footprint_p95: median(&mut footprint)?.round() as u64,
        cpu_p95: median(&mut cpu)?,
        runs: recent.len(),
    })
}

/// Median with the mean of the middle pair for even lengths.
fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable_by(f64::total_cmp);
    let mid = values.len() / 2;
    Some(if values.len().is_multiple_of(2) {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    })
}
