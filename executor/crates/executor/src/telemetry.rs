//! OpenTelemetry spans of runs, off unless `otlp_endpoint` is set in
//! `config.json`. Spans go to `<otlp_endpoint>/v1/traces` as OTLP/HTTP JSON
//! through the `ureq` client pairing already uses, so the exporter adds no
//! crate, no thread and no buffer: each finished run posts its spans once,
//! on a blocking task, and a failed post is logged and dropped.
//!
//! A run's spans are `run.admission` (offer received → admitted) and
//! `run.execute` (spawned → finished), children of the control plane's
//! `run.dispatch` span named by the Offer's `trace_parent`. They carry the run
//! id, the job type and how the run ended; never output, env or the command.

use std::{
    hash::{BuildHasher, RandomState},
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use devrounds_protocol::FinishReason;
use serde_json::{Value, json};
use ureq::tls::{RootCerts, TlsConfig};

/// A collector that does not answer holds a blocking thread this long at most.
const EXPORT_TIMEOUT: Duration = Duration::from_secs(10);
/// Posts in flight at once; a run that finishes past it drops its spans
/// rather than queueing behind a collector that does not answer.
const MAX_IN_FLIGHT: usize = 4;
const SERVICE: &str = "devrounds-executor";
/// OTLP `SPAN_KIND_INTERNAL`.
const KIND_INTERNAL: u8 = 1;

/// The exporter; clones share it. Only exists when an endpoint is set.
#[derive(Clone)]
pub struct Telemetry {
    inner: Arc<Inner>,
}

struct Inner {
    url: String,
    /// `url` without `user:password@`, the only form that is logged.
    shown_url: String,
    agent: ureq::Agent,
    in_flight: AtomicUsize,
}

/// When a run reached each point, as the executor's clock read it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RunTimes {
    pub offered: SystemTime,
    pub admitted: Option<SystemTime>,
    pub started: Option<SystemTime>,
}

/// What a run's spans name.
pub(crate) struct RunTrace<'a> {
    pub run: &'a str,
    pub job_type: &'a str,
    pub trace_parent: Option<&'a str>,
    pub times: RunTimes,
    pub finished: SystemTime,
    pub reason: FinishReason,
    pub exit_code: Option<i64>,
}

impl Telemetry {
    /// `None`, and nothing built, without an endpoint (absent or blank).
    /// `otlp_endpoint` is the collector's base URL, as
    /// `OTEL_EXPORTER_OTLP_ENDPOINT`: `/v1/traces` is appended. Anything but
    /// an `http://` or `https://` URL is also `None`, with one warning.
    pub fn from_config(otlp_endpoint: Option<&str>) -> Option<Telemetry> {
        let endpoint = otlp_endpoint?.trim();
        if endpoint.is_empty() {
            return None;
        }
        let Some(rest) = after_http_scheme(endpoint) else {
            tracing::warn!(
                endpoint = %without_userinfo(endpoint),
                "otlp_endpoint is not an http:// or https:// URL; telemetry stays off"
            );
            return None;
        };
        if rest.is_empty() {
            tracing::warn!("otlp_endpoint has no host; telemetry stays off");
            return None;
        }
        let url = format!("{}/v1/traces", endpoint.trim_end_matches('/'));
        let agent = ureq::Agent::config_builder()
            .tls_config(
                TlsConfig::builder()
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .timeout_global(Some(EXPORT_TIMEOUT))
            .build()
            .into();
        Some(Telemetry {
            inner: Arc::new(Inner {
                shown_url: without_userinfo(&url),
                url,
                agent,
                in_flight: AtomicUsize::new(0),
            }),
        })
    }

    /// Posts the spans of a finished run in the background. Must be called
    /// inside a tokio runtime.
    pub(crate) fn export_run(&self, trace: &RunTrace<'_>) {
        if self.inner.in_flight.fetch_add(1, Ordering::SeqCst) >= MAX_IN_FLIGHT {
            self.inner.in_flight.fetch_sub(1, Ordering::SeqCst);
            tracing::warn!(run = %trace.run, "spans dropped: the collector has too many posts in flight");
            return;
        }
        let body = run_spans(trace).to_string();
        let inner = Arc::clone(&self.inner);
        let run = trace.run.to_owned();
        tokio::task::spawn_blocking(move || {
            let posted = inner
                .agent
                .post(&inner.url)
                .header("content-type", "application/json")
                .send(body);
            inner.in_flight.fetch_sub(1, Ordering::SeqCst);
            if let Err(error) = posted {
                tracing::warn!(%run, url = %inner.shown_url, %error, "spans not exported");
            }
        });
    }
}

/// The OTLP/JSON request body of `trace`'s spans: ids in hex, times as
/// decimal strings of Unix nanoseconds.
fn run_spans(trace: &RunTrace<'_>) -> Value {
    let (trace_id, parent) = match trace.trace_parent.and_then(parse_trace_parent) {
        Some((trace_id, span)) => (trace_id.to_owned(), Some(span.to_owned())),
        // No usable parent (the control plane exports nothing): a trace of
        // the run's own.
        None => (format!("{:016x}{:016x}", random_id(), random_id()), None),
    };
    let common = [
        ("devrounds.run.id", json!({ "stringValue": trace.run })),
        (
            "devrounds.job_type",
            json!({ "stringValue": trace.job_type }),
        ),
    ];
    let span = |name: &str, start: SystemTime, end: SystemTime, extra: Vec<(&str, Value)>| {
        let attributes: Vec<Value> = common
            .iter()
            .cloned()
            .chain(extra)
            .map(|(key, value)| json!({ "key": key, "value": value }))
            .collect();
        let mut span = json!({
            "traceId": trace_id,
            "spanId": format!("{:016x}", random_id()),
            "name": name,
            "kind": KIND_INTERNAL,
            "startTimeUnixNano": unix_nanos(start).to_string(),
            "endTimeUnixNano": unix_nanos(end.max(start)).to_string(),
            "attributes": attributes,
        });
        if let Some(parent) = &parent {
            span["parentSpanId"] = json!(parent);
        }
        span
    };
    let times = trace.times;
    let admitted = times.admitted.unwrap_or(trace.finished);
    let mut spans = vec![span(
        "run.admission",
        times.offered,
        admitted,
        vec![(
            "devrounds.admitted",
            json!({ "boolValue": times.admitted.is_some() }),
        )],
    )];
    if let Some(started) = times.started {
        let reason = serde_json::to_value(trace.reason)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default();
        let mut extra = vec![("devrounds.finish_reason", json!({ "stringValue": reason }))];
        if let Some(code) = trace.exit_code {
            // OTLP/JSON carries int64 as a decimal string.
            extra.push((
                "devrounds.exit_code",
                json!({ "intValue": code.to_string() }),
            ));
        }
        spans.push(span("run.execute", started, trace.finished, extra));
    }
    json!({
        "resourceSpans": [{
            "resource": { "attributes": [
                { "key": "service.name", "value": { "stringValue": SERVICE } },
                { "key": "service.version", "value": { "stringValue": env!("CARGO_PKG_VERSION") } },
            ] },
            "scopeSpans": [{
                "scope": { "name": SERVICE, "version": env!("CARGO_PKG_VERSION") },
                "spans": spans,
            }],
        }],
    })
}

/// The trace id and parent span id of a W3C `traceparent`
/// (`00-<32 hex>-<16 hex>-<2 hex>`); `None` for anything else or all-zero ids.
fn parse_trace_parent(value: &str) -> Option<(&str, &str)> {
    let mut parts = value.split('-');
    let (version, trace_id, span_id, flags) =
        (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    let hex = |part: &str, len: usize| {
        part.len() == len
            && part
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    let non_zero = |part: &str| part.bytes().any(|b| b != b'0');
    let usable = parts.next().is_none()
        && version == "00"
        && hex(trace_id, 32)
        && non_zero(trace_id)
        && hex(span_id, 16)
        && non_zero(span_id)
        && hex(flags, 2);
    usable.then_some((trace_id, span_id))
}

/// What follows `http://` or `https://` (any case); `None` for other schemes.
fn after_http_scheme(url: &str) -> Option<&str> {
    ["http://", "https://"].iter().find_map(|scheme| {
        url.get(..scheme.len())
            .filter(|head| head.eq_ignore_ascii_case(scheme))
            .map(|_| &url[scheme.len()..])
    })
}

/// `url` with any `user:password@` before the host removed, for logs.
fn without_userinfo(url: &str) -> String {
    let (scheme, rest) = url.split_once("://").unwrap_or(("", url));
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    if scheme.is_empty() {
        format!("{host}{tail}")
    } else {
        format!("{scheme}://{host}{tail}")
    }
}

/// A non-zero id, unique in practice: span ids need no secrecy, so std's
/// randomly keyed hasher over a counter does without a random crate.
fn random_id() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let id =
        RandomState::new().hash_one((COUNTER.fetch_add(1, Ordering::Relaxed), SystemTime::now()));
    id.max(1)
}

fn unix_nanos(at: SystemTime) -> u128 {
    at.duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_parent_is_read_only_when_well_formed() {
        let good = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
        assert_eq!(
            parse_trace_parent(good),
            Some(("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"))
        );
        for bad in [
            "",
            "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-x",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-zz",
        ] {
            assert_eq!(parse_trace_parent(bad), None, "{bad}");
        }
    }

    #[test]
    fn logged_url_has_no_userinfo() {
        assert_eq!(
            without_userinfo("https://user:s3cret@collector.example:4318/v1/traces"),
            "https://collector.example:4318/v1/traces"
        );
        assert_eq!(
            without_userinfo("http://127.0.0.1:4318/a@b"),
            "http://127.0.0.1:4318/a@b"
        );
    }
}
