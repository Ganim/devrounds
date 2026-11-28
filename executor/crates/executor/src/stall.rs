//! Feature `stall`: a run whose job has `stall_s` is stopped once it has
//! written no output and used next to no CPU for that long. A session that
//! waits on a remote answer writes nothing for minutes but keeps a little CPU
//! busy; one that hangs (a dead socket, a prompt nobody answers) does neither.

use std::time::{Duration, Instant};

/// How often a run with `stall_s` is looked at; a stall is seen at most this
/// late.
pub const STALL_EVERY: Duration = Duration::from_secs(5);

/// CPU time below this share of the wall time between two looks counts as
/// none: an idle process still wakes for timers and garbage collection.
const IDLE_CPU_SHARE: f64 = 0.01;

/// The progress seen so far of one run: output bytes, CPU time and when
/// either last moved.
#[derive(Debug)]
pub struct StallWatch {
    limit: Duration,
    output_bytes: u64,
    cpu: Duration,
    looked_at: Instant,
    progressed_at: Instant,
}

impl StallWatch {
    /// A watch that starts counting at `now`, the run's start.
    pub fn new(limit: Duration, now: Instant) -> Self {
        Self {
            limit,
            output_bytes: 0,
            cpu: Duration::ZERO,
            looked_at: now,
            progressed_at: now,
        }
    }

    /// Records one look at the run; true once it has stalled: no output
    /// growth and no CPU beyond the idle share for `limit`.
    pub fn observe(&mut self, output_bytes: u64, cpu: Duration, now: Instant) -> bool {
        let wall = now.saturating_duration_since(self.looked_at);
        let used = cpu.saturating_sub(self.cpu);
        let busy = used.as_secs_f64() > wall.as_secs_f64() * IDLE_CPU_SHARE;
        if output_bytes != self.output_bytes || busy {
            self.progressed_at = now;
        }
        self.output_bytes = output_bytes;
        self.cpu = self.cpu.max(cpu);
        self.looked_at = now;
        now.saturating_duration_since(self.progressed_at) >= self.limit
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMIT: Duration = Duration::from_secs(30);

    #[test]
    /// Silence and an idle CPU for the whole limit is a stall; output or CPU
    /// work at any look starts the count over.
    fn stalls_only_after_the_limit_without_output_or_cpu() {
        let start = Instant::now();
        let at = |s: u64| start + Duration::from_secs(s);
        let mut watch = StallWatch::new(LIMIT, start);
        assert!(!watch.observe(0, Duration::ZERO, at(10)));
        assert!(!watch.observe(0, Duration::ZERO, at(20)));
        // New output at 25 s: the 30 s count starts there.
        assert!(!watch.observe(120, Duration::ZERO, at(25)));
        assert!(!watch.observe(120, Duration::ZERO, at(50)));
        // 2 s of CPU in 5 s is work.
        assert!(!watch.observe(120, Duration::from_secs(2), at(55)));
        assert!(!watch.observe(120, Duration::from_secs(2), at(80)));
        assert!(watch.observe(120, Duration::from_secs(2), at(85)));
    }

    #[test]
    /// A few milliseconds of CPU per look (timers, GC) is still idle.
    fn idle_cpu_does_not_count_as_progress() {
        let start = Instant::now();
        let mut watch = StallWatch::new(LIMIT, start);
        let mut cpu = Duration::ZERO;
        let mut stalled = false;
        for look in 1..=7 {
            cpu += Duration::from_millis(10);
            stalled = watch.observe(0, cpu, start + Duration::from_secs(5 * look));
        }
        assert!(stalled);
    }
}
