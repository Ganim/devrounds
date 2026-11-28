//! The OpenTelemetry exporter: nothing exists without an endpoint, and with
//! one a run's spans continue the trace its `Offer` carries. The receiver is
//! a fake OTLP/HTTP collector on `127.0.0.1:0`.

use devrounds_executor::telemetry::Telemetry;

#[test]
fn no_exporter_without_endpoint() {
    assert!(Telemetry::from_config(None).is_none());
    assert!(Telemetry::from_config(Some("")).is_none());
    assert!(Telemetry::from_config(Some("   ")).is_none());
    assert!(Telemetry::from_config(Some("file:///C:/spans")).is_none());
    assert!(Telemetry::from_config(Some("127.0.0.1:4318")).is_none());
    assert!(Telemetry::from_config(Some("http://127.0.0.1:4318")).is_some());
}

#[cfg(windows)]
mod live {
    use std::{
        collections::BTreeMap,
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        sync::{Arc, mpsc},
        time::Duration,
    };

    use async_trait::async_trait;
    use devrounds_core::{
        Error, JobSpec,
        clock::{Clock, TokioClock},
        gate::{MemoryPressure, PressureSample, PressureSource},
    };
    use devrounds_executor::{
        admission::{Admission, AdmissionConfig, DEFAULT_MEMORY_NEED},
        runs::{RunLoop, RunLoopDeps, run_log_options},
        telemetry::Telemetry,
    };
    use devrounds_protocol::{Offer, ServerMessage};
    use devrounds_runner_windows::WindowsRunner;
    use devrounds_store::Store;
    use serde_json::Value;
    use tokio::sync::watch;

    const LIMIT: Duration = Duration::from_secs(60);
    const TRACE_ID: &str = "4bf92f3577b34da6a3ce929d0e0e4736";
    const DISPATCH_SPAN: &str = "00f067aa0ba902b7";

    struct Roomy;

    #[async_trait]
    impl PressureSource for Roomy {
        fn name(&self) -> &'static str {
            "roomy"
        }

        async fn sample(&self) -> Result<PressureSample, Error> {
            Ok(PressureSample {
                cpu_percent: Some(5.0),
                memory: Some(MemoryPressure::Normal),
                cpu_stall_percent: None,
            })
        }

        async fn available_memory(&self) -> Result<Option<u64>, Error> {
            Ok(Some(64 << 30))
        }
    }

    /// A fake collector: answers every request `200 {}` and passes on its
    /// path and JSON body.
    fn receiver() -> (String, mpsc::Receiver<(String, Value)>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let endpoint = format!("http://{}", listener.local_addr().expect("address"));
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                let mut line = String::new();
                reader.read_line(&mut line).expect("request line");
                let path = line.split(' ').nth(1).unwrap_or_default().to_owned();
                let mut length = 0;
                loop {
                    line.clear();
                    reader.read_line(&mut line).expect("header");
                    if line.trim().is_empty() {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':')
                        && name.eq_ignore_ascii_case("content-length")
                    {
                        length = value.trim().parse().expect("length");
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).expect("body");
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                    .expect("answer");
                let body = serde_json::from_slice(&body).expect("JSON body");
                if tx.send((path, body)).is_err() {
                    return;
                }
            }
        });
        (endpoint, rx)
    }

    fn spans(body: &Value) -> Vec<Value> {
        let mut found = Vec::new();
        for resource in body["resourceSpans"].as_array().into_iter().flatten() {
            for scope in resource["scopeSpans"].as_array().into_iter().flatten() {
                found.extend(scope["spans"].as_array().into_iter().flatten().cloned());
            }
        }
        found
    }

    fn attribute<'a>(span: &'a Value, key: &str) -> Option<&'a str> {
        span["attributes"]
            .as_array()?
            .iter()
            .find(|a| a["key"] == key)?["value"]["stringValue"]
            .as_str()
    }

    // Multi-threaded: the receiver channel is read with block_in_place.
    #[tokio::test(flavor = "multi_thread")]
    async fn run_spans_continue_the_offer_trace() {
        let (endpoint, received) = receiver();
        tokio::time::timeout(LIMIT, async {
            let home = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("tempdir");
            let store = Store::open(&home.path().join("executor.db"))
                .await
                .expect("store");
            let clock: Arc<dyn Clock> = Arc::new(TokioClock::new());
            let admission = Admission::new(AdmissionConfig::default(), Arc::new(Roomy), clock);
            let (_connected, connected) = watch::channel(true);
            let runs = RunLoop::new(RunLoopDeps {
                store,
                admission: Arc::new(admission),
                runner: WindowsRunner::default(),
                connected,
                runs_dir: home.path().join("runs"),
                machine_env: std::env::vars().collect::<BTreeMap<_, _>>(),
                log_options: run_log_options(),
                telemetry: Telemetry::from_config(Some(&endpoint)),
            });
            runs.handle(ServerMessage::Offer(Offer {
                run: "run-traced".to_owned(),
                job: JobSpec {
                    job_type: "check".to_owned(),
                    program: devrounds_test_fixtures::tree_fixture_path()
                        .to_string_lossy()
                        .into_owned(),
                    args: vec!["--print".to_owned(), "1".to_owned()],
                    cwd: home.path().display().to_string(),
                    env_allow: ["SystemRoot", "windir", "TEMP", "TMP", "PATH"]
                        .map(str::to_owned)
                        .into(),
                    timeout_s: 600,
                    env_set: Default::default(),
                    environment_probe: None,
                },
                memory_need: DEFAULT_MEMORY_NEED,
                trace_parent: Some(format!("00-{TRACE_ID}-{DISPATCH_SPAN}-01")),
            }));

            let mut exported = Vec::new();
            while !["run.admission", "run.execute"]
                .iter()
                .all(|name| exported.iter().any(|span: &Value| span["name"] == *name))
            {
                let next = tokio::task::block_in_place(|| received.recv_timeout(LIMIT));
                let (path, body) = next.expect("spans exported");
                assert_eq!(path, "/v1/traces");
                exported.extend(spans(&body));
            }
            for span in &exported {
                assert_eq!(span["traceId"], TRACE_ID, "{span}");
                assert_eq!(span["parentSpanId"], DISPATCH_SPAN, "{span}");
                assert_eq!(attribute(span, "devrounds.run.id"), Some("run-traced"));
                assert_eq!(attribute(span, "devrounds.job_type"), Some("check"));
                let start: u64 = span["startTimeUnixNano"]
                    .as_str()
                    .expect("start")
                    .parse()
                    .expect("number");
                let end: u64 = span["endTimeUnixNano"]
                    .as_str()
                    .expect("end")
                    .parse()
                    .expect("number");
                assert!(start > 0 && start <= end, "{span}");
            }
            let execute = exported
                .iter()
                .find(|s| s["name"] == "run.execute")
                .expect("run.execute");
            assert_eq!(
                attribute(execute, "devrounds.finish_reason"),
                Some("exited")
            );
        })
        .await
        .expect("bounded");
    }
}
