//! The shared fixtures under `fixtures/` are the wire contract: the control
//! plane's `protocol.test.ts` validates the same files against TypeBox.

use std::{collections::BTreeSet, path::PathBuf};

use devrounds_protocol::{
    ClientMessage, FEATURES, RunEvent, ServerMessage, decode_client, decode_server, encode_client,
    encode_server, negotiate,
};
use serde_json::Value;

/// Executor → control plane types; `Event` fixtures are named `Event.<kind>`.
const CLIENT_TYPES: [&str; 3] = ["Hello", "MachineReport", "LogChunk"];
const RUN_EVENT_KINDS: [&str; 8] = [
    "Admitted",
    "Delayed",
    "RunStarted",
    "StepStarted",
    "StepFinished",
    "LogSegment",
    "RunFinished",
    "Orphans",
];
/// Control plane → executor types.
const SERVER_TYPES: [&str; 5] = ["HelloAck", "Offer", "Stop", "Ack", "Resync"];

fn fixtures() -> Vec<(String, String)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    let mut all = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("fixtures directory") {
        let path = entry.expect("fixture entry").path();
        let name = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .expect("fixture name")
            .to_owned();
        let text = std::fs::read_to_string(&path).expect("fixture text");
        all.push((name, text));
    }
    all
}

fn is_server(name: &str) -> bool {
    SERVER_TYPES.contains(&name)
}

#[test]
/// Each fixture decodes to a known message and encodes back to the same JSON value.
fn every_fixture_round_trips() {
    for (name, text) in fixtures() {
        let original: Value = serde_json::from_str(&text).expect("fixture is JSON");
        let encoded = if is_server(&name) {
            let message = decode_server(&text).expect(&name);
            assert_ne!(message, ServerMessage::Unknown, "{name}");
            encode_server(&message).expect(&name)
        } else {
            let message = decode_client(&text).expect(&name);
            assert_ne!(message, ClientMessage::Unknown, "{name}");
            if let ClientMessage::Event(event) = &message {
                assert_ne!(event.event, RunEvent::Unknown, "{name}");
            }
            encode_client(&message).expect(&name)
        };
        let again: Value = serde_json::from_str(&encoded).expect("encoded is JSON");
        assert_eq!(again, original, "{name}");
    }
}

#[test]
/// A control plane that predates feature `withdraw` sends no `withdrawn`; it
/// reads as none withdrawn.
fn hello_ack_without_withdrawn_reads_as_empty() {
    let message = decode_server(
        r#"{"type":"HelloAck","protocol":1,"features":["seq"],"machine_id":"m","last_seq":0}"#,
    );
    match message {
        Ok(ServerMessage::HelloAck(ack)) => assert!(ack.withdrawn.is_empty()),
        other => panic!("expected a HelloAck, got {other:?}"),
    }
}

#[test]
/// The Offer fixture carries `env_set`; a control plane that predates
/// feature `job-env` sends none, which reads as no values.
fn offer_env_set_reads_from_the_fixture_and_defaults_to_empty() {
    let text = fixtures()
        .into_iter()
        .find(|(name, _)| name == "Offer")
        .map(|(_, text)| text)
        .expect("Offer fixture");
    match decode_server(&text) {
        Ok(ServerMessage::Offer(offer)) => {
            assert_eq!(offer.job.env_set["DB_NAME"], "devrounds_test_1");
        }
        other => panic!("expected an Offer, got {other:?}"),
    }
    let mut value: Value = serde_json::from_str(&text).expect("fixture is JSON");
    value["job"]
        .as_object_mut()
        .expect("job")
        .remove("env_set")
        .expect("env_set");
    let older = value.to_string();
    match decode_server(&older) {
        Ok(ServerMessage::Offer(offer)) => assert!(offer.job.env_set.is_empty(), "{older}"),
        other => panic!("expected an Offer, got {other:?}"),
    }
}

#[test]
/// Fixture names cover every message type and event kind, and nothing else.
fn every_message_type_has_a_fixture() {
    let expected: BTreeSet<String> = CLIENT_TYPES
        .iter()
        .chain(SERVER_TYPES.iter())
        .map(|name| (*name).to_owned())
        .chain(RUN_EVENT_KINDS.iter().map(|kind| format!("Event.{kind}")))
        .collect();
    let found: BTreeSet<String> = fixtures().into_iter().map(|(name, _)| name).collect();
    assert_eq!(found, expected);
}

#[test]
/// A newer peer may send types and kinds this side does not know: they decode
/// to `Unknown` instead of failing.
fn unknown_type_and_kind_are_ignored() {
    assert_eq!(
        decode_server(r#"{"type":"Drain","deadline":30}"#),
        Ok(ServerMessage::Unknown)
    );
    assert_eq!(
        decode_client(r#"{"type":"Telemetry","spans":[]}"#),
        Ok(ClientMessage::Unknown)
    );
    let event = decode_client(
        r#"{"type":"Event","seq":9,"at":"2026-11-18T12:00:00Z","event":{"kind":"Paused","run":"r"}}"#,
    );
    match event {
        Ok(ClientMessage::Event(event)) => {
            assert_eq!(event.seq, 9);
            assert_eq!(event.event, RunEvent::Unknown);
        }
        other => panic!("expected an event, got {other:?}"),
    }
}

#[test]
/// A known type with a bad shape answers DR150 naming the type.
fn a_known_type_with_a_bad_field_is_dr150() {
    let error = decode_server(r#"{"type":"Ack","seq":"seven"}"#).expect_err("bad seq");
    assert_eq!(error.code, "DR150");
    assert_eq!(error.data["type"], "Ack");
    let error = decode_server("not json").expect_err("not JSON");
    assert_eq!(error.code, "DR150");
    let error = decode_server(r#"{"seq":1}"#).expect_err("no type");
    assert_eq!(error.data["path"], "/type");
}

#[test]
/// The negotiated features are the shared ones, in our order.
fn negotiate_keeps_shared_features() {
    let theirs = ["trace-context", "seq", "telepathy"];
    assert_eq!(negotiate(&FEATURES, &theirs), ["seq", "trace-context"]);
    assert!(negotiate(&FEATURES, &[] as &[&str]).is_empty());
}
