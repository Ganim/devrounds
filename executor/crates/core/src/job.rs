//! What the control plane asks the executor to run.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// One job as dispatched: the program, its arguments and working directory,
/// the names of the environment variables the job type allows, and the
/// values the job type and job set. Machine values never travel in it; the
/// executor reads them from its own environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobSpec {
    pub job_type: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// Environment variable names, never values.
    pub env_allow: Vec<String>,
    pub timeout_s: u32,
    /// Feature `job-env`: values set on the job type and the job, stored by
    /// the control plane, so never secrets. Absent from older control planes.
    #[serde(default)]
    pub env_set: BTreeMap<String, String>,
    /// Feature `environment`: a command run in `cwd`, with the run's
    /// environment, just before the run starts; its stdout, read as JSON, goes
    /// back on `RunStarted`. The control plane takes it from the job type's
    /// environment provider, so the executor names no tool. Absent from older
    /// control planes and for job types without an environment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment_probe: Option<Probe>,
    /// Feature `stall`: seconds without output growth and without CPU after
    /// which the executor stops the run as stalled. Absent: never.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stall_s: Option<u32>,
}

/// A command run for its output; see [`JobSpec::environment_probe`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Probe {
    pub program: String,
    pub args: Vec<String>,
}
