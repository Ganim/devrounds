//! The executor home: its location, its owner-only check, the singleton
//! lock, `config.json` and the control plane URL rules.

use std::fs::{self, File, TryLockError};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use devrounds_core::DrError;
use devrounds_sys_windows::security::{self, Problem};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_tungstenite::tungstenite::http::Uri;

/// Overrides the default home, `~/.devrounds/executor`.
pub const HOME_ENV: &str = "DEVROUNDS_EXECUTOR_HOME";
pub const CONFIG_FILE: &str = "config.json";
/// The machine token; never logged, never in `config.json`.
pub const TOKEN_FILE: &str = "machine-token";
const LOCK_FILE: &str = "executor.lock";
/// The lock holder's pid. A separate file: Windows byte-range locks block
/// other processes from reading the locked file itself.
const PID_FILE: &str = "executor.pid";

/// `<home>/config.json`. Later tasks add `admission` and `otlp_endpoint`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutorConfig {
    /// The control plane base URL, `http(s)://host[:port][/prefix]`.
    pub url: String,
    pub machine_id: String,
}

/// `DEVROUNDS_EXECUTOR_HOME`, else `~/.devrounds/executor`.
pub fn executor_home() -> Result<PathBuf, DrError> {
    if let Some(home) = std::env::var_os(HOME_ENV).filter(|home| !home.is_empty()) {
        return Ok(PathBuf::from(home));
    }
    let user = std::env::home_dir().ok_or_else(|| {
        DrError::new(
            "DR551",
            json!({ "reason": format!("no user profile directory; set {HOME_ENV}") }),
        )
    })?;
    Ok(user.join(".devrounds").join("executor"))
}

/// Creates `home` (and its parents) if missing and makes sure only this
/// user can reach it; DR550 when it cannot be made owner-only.
pub async fn prepare_home(home: &Path) -> Result<(), DrError> {
    let home = home.to_path_buf();
    blocking(move || {
        if let Some(parent) = home.parent() {
            fs::create_dir_all(parent).map_err(|error| unusable(parent, &error.to_string()))?;
        }
        match security::ensure_private_dir(&home) {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(problem)) => Err(unusable(&home, &describe(&problem))),
            Err(error) => Err(unusable(&home, &error.to_string())),
        }
    })
    .await
}

/// Writes `config.json` and the token file inside a prepared home. Each file
/// is written beside its target and renamed over it, so a crash leaves the
/// old pairing or the new one, never half of one; both inherit the home's
/// owner-only access list.
pub async fn save_pairing(
    home: &Path,
    config: &ExecutorConfig,
    token: &str,
) -> Result<(), DrError> {
    let home = home.to_path_buf();
    let config = serde_json::to_vec_pretty(config)
        .map_err(|error| unusable(&home.join(CONFIG_FILE), &error.to_string()))?;
    let token = token.as_bytes().to_vec();
    blocking(move || {
        let token_path = home.join(TOKEN_FILE);
        write_replacing(&token_path, &token)?;
        match security::check_private_file(&token_path) {
            Ok(Ok(())) => {}
            Ok(Err(problem)) => return Err(unusable(&token_path, &describe(&problem))),
            Err(error) => return Err(unusable(&token_path, &error.to_string())),
        }
        write_replacing(&home.join(CONFIG_FILE), &config)
    })
    .await
}

fn write_replacing(path: &Path, bytes: &[u8]) -> Result<(), DrError> {
    let temp = path.with_extension("tmp");
    let written = (|| -> io::Result<()> {
        let mut file = File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    written.map_err(|error| {
        let _ = fs::remove_file(&temp);
        unusable(path, &error.to_string())
    })
}

/// Holds `<home>/executor.lock` while alive: one executor per home.
#[derive(Debug)]
pub struct HomeLock {
    _file: File,
}

impl HomeLock {
    /// Takes the lock; DR352 with the holder's pid when another process has it.
    pub async fn acquire(home: &Path) -> Result<HomeLock, DrError> {
        let home = home.to_path_buf();
        blocking(move || {
            let lock_path = home.join(LOCK_FILE);
            let file = File::options()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&lock_path)
                .map_err(|error| unusable(&lock_path, &error.to_string()))?;
            let pid_path = home.join(PID_FILE);
            match file.try_lock() {
                Ok(()) => {}
                Err(TryLockError::WouldBlock) => {
                    let pid = fs::read_to_string(&pid_path)
                        .ok()
                        .map(|text| text.trim().to_owned())
                        .filter(|pid| !pid.is_empty())
                        .unwrap_or_else(|| "unknown".to_owned());
                    return Err(DrError::new(
                        "DR352",
                        json!({ "home": home.display().to_string(), "pid": pid }),
                    ));
                }
                Err(TryLockError::Error(error)) => {
                    return Err(unusable(&lock_path, &error.to_string()));
                }
            }
            fs::write(&pid_path, std::process::id().to_string())
                .map_err(|error| unusable(&pid_path, &error.to_string()))?;
            Ok(HomeLock { _file: file })
        })
        .await
    }
}

/// A checked control plane URL. Plain `http`/`ws` only reach a loopback
/// host: the pairing code, the machine token and every message would
/// otherwise cross the network in clear.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlPlaneUrl {
    secure: bool,
    authority: String,
    prefix: String,
}

impl ControlPlaneUrl {
    /// DR551 for anything but `http(s)://host[:port][/prefix]`, and for
    /// `http` to a host other than `127.0.0.1`, `::1` or `localhost`.
    pub fn parse(url: &str) -> Result<Self, DrError> {
        let invalid = |reason: String| DrError::new("DR551", json!({ "reason": reason }));
        let uri: Uri = url
            .parse()
            .map_err(|error| invalid(format!("url {url} is not a URL: {error}")))?;
        let secure = match uri.scheme_str() {
            Some("https") => true,
            Some("http") => false,
            _ => {
                return Err(invalid(format!(
                    "url {url} must start with http:// or https://"
                )));
            }
        };
        let (Some(authority), Some(host)) = (uri.authority(), uri.host()) else {
            return Err(invalid(format!("url {url} has no host")));
        };
        if uri.query().is_some() {
            return Err(invalid(format!("url {url} must not carry a query")));
        }
        if !secure && !matches!(host, "127.0.0.1" | "[::1]" | "::1" | "localhost") {
            return Err(invalid(format!(
                "ws:// and http:// reach only 127.0.0.1, ::1 or localhost; use https:// for {host}"
            )));
        }
        Ok(Self {
            secure,
            authority: authority.as_str().to_owned(),
            prefix: uri.path().trim_end_matches('/').to_owned(),
        })
    }

    /// `http(s)://…/<path>`, `path` starting with `/`.
    pub fn http(&self, path: &str) -> String {
        let scheme = if self.secure { "https" } else { "http" };
        format!("{scheme}://{}{}{path}", self.authority, self.prefix)
    }

    /// `ws(s)://…/<path>`, `path` starting with `/`.
    pub fn ws(&self, path: &str) -> String {
        let scheme = if self.secure { "wss" } else { "ws" };
        format!("{scheme}://{}{}{path}", self.authority, self.prefix)
    }
}

/// Runs blocking file and OS calls off the async threads.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, DrError> + Send + 'static,
) -> Result<T, DrError> {
    tokio::task::spawn_blocking(work).await.map_err(|error| {
        DrError::new(
            "DR501",
            json!({ "reason": format!("blocking task failed: {error}") }),
        )
    })?
}

pub(crate) fn unusable(path: &Path, reason: &str) -> DrError {
    DrError::new(
        "DR550",
        json!({ "path": path.display().to_string(), "reason": reason }),
    )
}

fn describe(problem: &Problem) -> String {
    match problem {
        Problem::NotADirectory => "not a directory".to_owned(),
        Problem::NotAFile => "not a regular file".to_owned(),
        Problem::ReparsePoint => "a link or junction".to_owned(),
        Problem::Owner(sid) => format!("owned by another account ({sid})"),
        Problem::Acl(sids) => {
            let sids: Vec<String> = sids.iter().map(ToString::to_string).collect();
            format!("other accounts have access ({})", sids.join(", "))
        }
        Problem::HardLinks(count) => format!("has {count} names (hard links)"),
        Problem::Unreadable => "its owner or access list cannot be read".to_owned(),
    }
}
