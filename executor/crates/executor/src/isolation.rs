//! How a job spec becomes the launch spec of one run. `none` is the only
//! mode in P1: the child runs as the executor's user on the executor's
//! machine, so the environment allowlist is the only thing between it and the
//! executor's secrets.

use std::{collections::BTreeMap, fmt, path::Path};

use devrounds_core::{JobSpec, LaunchSpec, RunOutput};

/// Name of the variable that tells a run which run it is.
pub const RUN_ID_VAR: &str = "DEVROUNDS_RUN_ID";

/// Why a run could not be prepared. The run fails before it starts.
#[derive(Debug, PartialEq, Eq)]
pub enum PrepareError {
    /// The machine cannot host the run as specified. `summary` names what is
    /// wrong and carries no environment values.
    Environment { summary: String },
}

impl fmt::Display for PrepareError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Environment { summary } => write!(f, "environment: {summary}"),
        }
    }
}

impl std::error::Error for PrepareError {}

pub trait Isolation {
    /// Builds the launch spec of run `run`, writing output into `run_dir`.
    /// `machine_env` is the executor's own environment; only the names in the
    /// job's allowlist are copied from it, then the job's `env_set` values.
    fn prepare(
        &self,
        run: &str,
        job: &JobSpec,
        run_dir: &Path,
        machine_env: &BTreeMap<String, String>,
    ) -> Result<LaunchSpec, PrepareError>;
}

/// No isolation beyond the environment allowlist.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoneIsolation;

impl Isolation for NoneIsolation {
    fn prepare(
        &self,
        run: &str,
        job: &JobSpec,
        run_dir: &Path,
        machine_env: &BTreeMap<String, String>,
    ) -> Result<LaunchSpec, PrepareError> {
        let cwd = Path::new(&job.cwd);
        if !cwd.is_absolute() {
            return Err(PrepareError::Environment {
                summary: format!("working directory {} is not an absolute path", job.cwd),
            });
        }
        if !cwd.is_dir() {
            return Err(PrepareError::Environment {
                summary: format!("working directory {} does not exist", job.cwd),
            });
        }

        // Windows treats variable names case-insensitively, so the job's
        // `path` must find the machine's `Path`; the machine's spelling stays.
        let mut env: BTreeMap<String, String> = machine_env
            .iter()
            .filter(|(name, _)| {
                job.env_allow
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(name))
            })
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect();
        // A value the job sets wins over the machine's, under the job's
        // spelling: Windows would see `Path` and `PATH` as one variable.
        for (name, value) in &job.env_set {
            set_ignoring_case(&mut env, name, value);
        }
        // Last, so no `env_set` entry in any spelling can replace it.
        set_ignoring_case(&mut env, RUN_ID_VAR, run);

        Ok(LaunchSpec {
            program: job.program.clone(),
            args: job.args.clone(),
            cwd: cwd.to_path_buf(),
            env,
            output: RunOutput {
                stdout: run_dir.join("stdout.raw"),
                stderr: run_dir.join("stderr.raw"),
            },
        })
    }
}

/// Inserts `name`, first removing every key equal to it ignoring ASCII case.
fn set_ignoring_case(env: &mut BTreeMap<String, String>, name: &str, value: &str) {
    env.retain(|key, _| !key.eq_ignore_ascii_case(name));
    env.insert(name.to_owned(), value.to_owned());
}
