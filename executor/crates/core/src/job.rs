//! What the control plane asks the executor to run.

use serde::{Deserialize, Serialize};

/// One job as dispatched: the program, its arguments and working directory,
/// and the names of the environment variables the job type allows. Values
/// never travel in it; the executor reads them from its own environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobSpec {
    pub job_type: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// Environment variable names, never values.
    pub env_allow: Vec<String>,
    pub timeout_s: u32,
}
