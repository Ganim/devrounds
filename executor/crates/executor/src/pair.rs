//! `devrounds-executor pair`: trades a one-time pairing code for this
//! machine's token and writes the executor home.

use std::path::Path;
use std::time::Duration;

use devrounds_core::DrError;
use serde::Deserialize;
use serde_json::{Value, json};
use ureq::tls::{RootCerts, TlsConfig};

use crate::config::{
    ControlPlaneUrl, ExecutorConfig, HomeLock, prepare_home, save_pairing, tuned_settings,
};

const PAIR_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Paired {
    machine_id: String,
    token: String,
}

/// Pairs this machine with the control plane at `url` using `code`, then
/// writes `<home>/machine-token` (owner-only) and `<home>/config.json`.
/// Pairing again replaces both, keeping the `admission` and `otlp_endpoint`
/// settings of the existing `config.json`. DR550 when `home` cannot be made owner-only,
/// DR551 for a URL that is not allowed, DR352 when an executor runs on
/// `home`, and the control plane's DR450/DR451 as it answered them.
pub async fn pair(home: &Path, url: &str, code: &str) -> Result<(), DrError> {
    let url = ControlPlaneUrl::parse(url)?;
    prepare_home(home).await?;
    let _lock = HomeLock::acquire(home).await?;
    let endpoint = url.http("/api/executor/pair");
    let body = json!({
        "code": code,
        "os": std::env::consts::OS,
        "version": env!("CARGO_PKG_VERSION"),
    });
    let paired = tokio::task::spawn_blocking(move || post(&endpoint, &body))
        .await
        .map_err(|error| internal(format!("pairing task failed: {error}")))??;
    let tuned = tuned_settings(home).await;
    let config = ExecutorConfig {
        url: url.http(""),
        machine_id: paired.machine_id,
        admission: tuned.admission,
        otlp_endpoint: tuned.otlp_endpoint,
    };
    save_pairing(home, &config, &paired.token).await
}

fn post(endpoint: &str, body: &Value) -> Result<Paired, DrError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(
            TlsConfig::builder()
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .http_status_as_error(false)
        .timeout_global(Some(PAIR_TIMEOUT))
        .build()
        .into();
    let mut response = agent.post(endpoint).send_json(body).map_err(|error| {
        internal(format!(
            "control plane at {endpoint} did not answer: {error}"
        ))
    })?;
    let status = response.status().as_u16();
    let answer: Value = response.body_mut().read_json().map_err(|error| {
        internal(format!(
            "HTTP {status} from {endpoint} is not JSON: {error}"
        ))
    })?;
    if (200..300).contains(&status) {
        return serde_json::from_value(answer).map_err(|error| {
            internal(format!(
                "HTTP {status} from {endpoint} is not a pairing: {error}"
            ))
        });
    }
    let data = answer.get("data").cloned().unwrap_or_else(|| json!({}));
    // The words live in the control plane; the code and data come through as it sent them.
    Err(match answer.get("code").and_then(Value::as_str) {
        Some("DR450") => DrError::new("DR450", data),
        Some("DR451") => DrError::new("DR451", data),
        Some("DR101") => DrError::new("DR101", data),
        other => internal(format!(
            "HTTP {status} from {endpoint} with code {}",
            other.unwrap_or("none")
        )),
    })
}

fn internal(reason: String) -> DrError {
    DrError::new("DR501", json!({ "reason": reason }))
}
