//! The executor's session with the control plane: it dials out over
//! WebSocket, sends `Hello`, hands every frame to a [`Handler`], sends a
//! `MachineReport` every 10 s and reconnects with backoff when the socket
//! drops.

use std::time::Duration;

use devrounds_core::DrError;
use devrounds_protocol::{
    ClientMessage, FEATURES, Hello, MachineReport, PROTOCOL, ServerMessage, decode_server,
    encode_client,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::{
    Message,
    client::IntoClientRequest,
    http::{HeaderValue, header::AUTHORIZATION},
    protocol::{CloseFrame, WebSocketConfig},
};

use crate::config::{ControlPlaneUrl, ExecutorConfig};

pub const REPORT_INTERVAL: Duration = Duration::from_secs(10);
const FIRST_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Matches the control plane's `maxPayload`.
const MAX_MESSAGE: usize = 4 * 1024 * 1024;

/// Close codes the control plane sends (see `control-plane/src/executor/gateway.ts`).
const CLOSE_TOKEN: u16 = 4401;
const CLOSE_REPLACED: u16 = 4409;

/// What a session feeds and is fed by.
pub trait Handler: Send {
    /// This boot's id, sent in `Hello`.
    fn boot_id(&self) -> String;
    /// The figures for the next `MachineReport`.
    fn report(&mut self) -> MachineReport;
    /// Every known frame from the control plane, `HelloAck` first. Unknown
    /// types are dropped before they get here.
    fn on_message(&mut self, message: ServerMessage);
}

/// Why one session ended.
enum Ended {
    /// The socket closed or failed; `acked` when it got as far as `HelloAck`.
    Dropped { acked: bool },
    /// The token is no longer valid: pairing again is the only way back.
    Revoked,
    /// A newer session of this machine took over.
    Replaced,
}

pub struct Connection;

impl Connection {
    /// Keeps a session to the control plane at `config.url` until the token
    /// stops working (DR452) or a newer session of this machine replaces
    /// this one (`Ok`). Refuses `ws://` to a non-loopback host with DR551.
    /// Reconnects after 1 s, doubling to 30 s; a session that got its
    /// `HelloAck` starts the backoff over.
    pub async fn run<H: Handler>(
        config: &ExecutorConfig,
        token: &str,
        handler: &mut H,
    ) -> Result<(), DrError> {
        let url = ControlPlaneUrl::parse(&config.url)?.ws("/api/executor/connect");
        let mut backoff = FIRST_BACKOFF;
        loop {
            match session(&url, token, handler).await? {
                Ended::Revoked => {
                    return Err(DrError::new("DR452", json!({})));
                }
                Ended::Replaced => {
                    tracing::warn!("a newer executor session of this machine took over");
                    return Ok(());
                }
                Ended::Dropped { acked } => {
                    if acked {
                        backoff = FIRST_BACKOFF;
                    }
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            }
        }
    }
}

/// One connection, from dialing to close. Errors only for what reconnecting
/// cannot fix.
async fn session<H: Handler>(url: &str, token: &str, handler: &mut H) -> Result<Ended, DrError> {
    let invalid = |reason: String| DrError::new("DR551", json!({ "reason": reason }));
    let mut request = url
        .into_client_request()
        .map_err(|error| invalid(format!("{url}: {error}")))?;
    let bearer = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| DrError::new("DR452", json!({})))?;
    request.headers_mut().insert(AUTHORIZATION, bearer);
    let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE));
    let socket =
        match tokio_tungstenite::connect_async_with_config(request, Some(config), true).await {
            Ok((socket, _)) => socket,
            Err(error) => {
                tracing::warn!(%url, %error, "control plane unreachable");
                return Ok(Ended::Dropped { acked: false });
            }
        };
    let (mut sink, mut stream) = socket.split();
    let hello = ClientMessage::Hello(Hello {
        protocol: PROTOCOL,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        features: FEATURES
            .iter()
            .map(|feature| (*feature).to_owned())
            .collect(),
        boot_id: handler.boot_id(),
    });
    if sink
        .send(Message::text(encode_client(&hello)?))
        .await
        .is_err()
    {
        return Ok(Ended::Dropped { acked: false });
    }
    let mut reports = tokio::time::interval(REPORT_INTERVAL);
    reports.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut acked = false;
    loop {
        tokio::select! {
            _ = reports.tick(), if acked => {
                let report = ClientMessage::MachineReport(handler.report());
                if sink.send(Message::text(encode_client(&report)?)).await.is_err() {
                    return Ok(Ended::Dropped { acked });
                }
            }
            frame = stream.next() => match frame {
                Some(Ok(Message::Text(text))) => match decode_server(&text) {
                    Ok(ServerMessage::Unknown) => {}
                    Ok(message) => {
                        if matches!(message, ServerMessage::HelloAck(_)) && !acked {
                            acked = true;
                            // The first report goes right after the ack.
                            reports.reset_immediately();
                        }
                        handler.on_message(message);
                    }
                    Err(error) => tracing::warn!(%error, "control plane message rejected"),
                },
                Some(Ok(Message::Close(frame))) => return Ok(closed(frame.as_ref(), acked)),
                Some(Ok(_)) => {}
                Some(Err(error)) => {
                    tracing::warn!(%error, "control plane connection failed");
                    return Ok(Ended::Dropped { acked });
                }
                None => return Ok(Ended::Dropped { acked }),
            },
        }
    }
}

fn closed(frame: Option<&CloseFrame>, acked: bool) -> Ended {
    let code = frame.map(|frame| u16::from(frame.code));
    let reason = frame.map(|frame| frame.reason.as_str()).unwrap_or_default();
    tracing::warn!(?code, %reason, "control plane closed the session");
    match code {
        Some(CLOSE_TOKEN) => Ended::Revoked,
        Some(CLOSE_REPLACED) => Ended::Replaced,
        _ => Ended::Dropped { acked },
    }
}
