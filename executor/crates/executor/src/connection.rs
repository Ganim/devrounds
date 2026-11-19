//! The executor's session with the control plane: it dials out over
//! WebSocket, sends `Hello`, hands every frame to a [`Handler`], sends a
//! `MachineReport` every 10 s and reconnects with backoff when the socket
//! drops.
//!
//! Events reach the control plane only through the [`Store`] outbox: each
//! session resends what is left after `HelloAck.last_seq`, then sends new
//! events as they are appended, never more than [`SEND_WINDOW_BYTES`] of them
//! unacked. `Ack` drops events from the outbox and
//! `Resync` resends from the seq it names, so an event is applied once and in
//! order whatever happens to the socket or the control plane.

use std::{collections::VecDeque, time::Duration};

use devrounds_core::DrError;
use devrounds_protocol::{
    Ack, ClientMessage, FEATURES, Hello, HelloAck, MachineReport, PROTOCOL, Resync, ServerMessage,
    decode_server, encode_client,
};
use devrounds_store::Store;
use futures_util::{Sink, SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::watch;
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
pub const MAX_MESSAGE: usize = 4 * 1024 * 1024;
/// What one resend read takes from the outbox: a backlog left by a long
/// disconnect is sent page by page, never loaded whole.
const RESEND_PAGE_BYTES: usize = 4 * 1024 * 1024;
/// Event bytes a session keeps sent but not acked. Past it the session waits
/// for `Ack`s, still reading frames, so a slow control plane neither queues a
/// whole backlog in its socket nor delays a `Stop` behind it.
pub const SEND_WINDOW_BYTES: usize = 8 * 1024 * 1024;

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

pub struct Connection {
    store: Store,
    connected: watch::Sender<bool>,
}

impl Connection {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            connected: watch::Sender::new(false),
        }
    }

    /// True while a session is past `HelloAck` and has resent the outbox. The
    /// run loop waits for it before spawning a granted run.
    pub fn connected(&self) -> watch::Receiver<bool> {
        self.connected.subscribe()
    }

    /// Keeps a session to the control plane at `config.url` until the token
    /// stops working (DR452), a newer session of this machine replaces this
    /// one (`Ok`) or the store fails (DR550). Refuses `ws://` to a
    /// non-loopback host with DR551. Reconnects after 1 s, doubling to 30 s;
    /// a session that got its `HelloAck` starts the backoff over.
    pub async fn run<H: Handler>(
        &self,
        config: &ExecutorConfig,
        token: &str,
        handler: &mut H,
    ) -> Result<(), DrError> {
        let url = ControlPlaneUrl::parse(&config.url)?.ws("/api/executor/connect");
        let mut backoff = FIRST_BACKOFF;
        loop {
            let ended = session(&url, token, handler, &self.store, &self.connected).await;
            self.connected.send_replace(false);
            match ended? {
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
async fn session<H: Handler>(
    url: &str,
    token: &str,
    handler: &mut H,
    store: &Store,
    connected: &watch::Sender<bool>,
) -> Result<Ended, DrError> {
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
    let acked_through = store.acked_through().await?;
    let hello = ClientMessage::Hello(Hello {
        protocol: PROTOCOL,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        features: FEATURES
            .iter()
            .map(|feature| (*feature).to_owned())
            .collect(),
        boot_id: handler.boot_id(),
        acked_through: Some(acked_through),
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
    let mut appended = store.appended();
    let mut acked = false;
    // The last seq this session has sent; events go out strictly after it.
    let mut sent = 0;
    let mut in_flight = InFlight::default();
    loop {
        tokio::select! {
            _ = reports.tick(), if acked => {
                let report = ClientMessage::MachineReport(handler.report());
                if sink.send(Message::text(encode_client(&report)?)).await.is_err() {
                    return Ok(Ended::Dropped { acked });
                }
            }
            changed = appended.changed(), if acked => {
                // The store this session holds owns the sender, so `changed` cannot fail; if it ever
                // did, dropping the session beats spinning on it.
                if changed.is_err() || !send_pending(&mut sink, store, &mut sent, &mut in_flight).await? {
                    return Ok(Ended::Dropped { acked });
                }
            }
            frame = stream.next() => match frame {
                Some(Ok(Message::Text(text))) => match decode_server(&text) {
                    Ok(ServerMessage::Unknown) => {}
                    Ok(message) => {
                        match &message {
                            ServerMessage::HelloAck(HelloAck { last_seq, .. }) if !acked => {
                                acked = true;
                                // The first report goes right after the ack.
                                reports.reset_immediately();
                                if store.raise_floor(*last_seq).await? {
                                    tracing::warn!(
                                        last_seq,
                                        "the control plane applied more events than this store holds; \
                                         the store was replaced, so new events continue after its last seq"
                                    );
                                }
                                store.ack_through(*last_seq).await?;
                                sent = *last_seq;
                                appended.mark_unchanged();
                                if !send_pending(&mut sink, store, &mut sent, &mut in_flight).await? {
                                    return Ok(Ended::Dropped { acked });
                                }
                                connected.send_replace(true);
                            }
                            ServerMessage::Ack(Ack { seq }) => {
                                store.ack_through(*seq).await?;
                                in_flight.acked(*seq);
                                if acked && !send_pending(&mut sink, store, &mut sent, &mut in_flight).await? {
                                    return Ok(Ended::Dropped { acked });
                                }
                            }
                            ServerMessage::Resync(Resync { from_seq }) if acked => {
                                in_flight.resent_from(*from_seq);
                                sent = from_seq.saturating_sub(1);
                                if !send_pending(&mut sink, store, &mut sent, &mut in_flight).await? {
                                    return Ok(Ended::Dropped { acked });
                                }
                            }
                            _ => {}
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

/// The frames a session sent and has not seen acked, oldest first.
#[derive(Default)]
struct InFlight {
    frames: VecDeque<(u64, usize)>,
    bytes: usize,
}

impl InFlight {
    /// Room for a frame of `len` bytes. A frame larger than the whole window
    /// still goes out once nothing else is in flight.
    fn fits(&self, len: usize) -> bool {
        self.frames.is_empty() || self.bytes + len <= SEND_WINDOW_BYTES
    }

    fn push(&mut self, seq: u64, len: usize) {
        self.frames.push_back((seq, len));
        self.bytes += len;
    }

    /// `Ack` is cumulative.
    fn acked(&mut self, seq: u64) {
        while let Some(&(front, len)) = self.frames.front() {
            if front > seq {
                break;
            }
            self.frames.pop_front();
            self.bytes -= len;
        }
    }

    /// A `Resync` from `from_seq`: what was sent from there on goes again.
    fn resent_from(&mut self, from_seq: u64) {
        while let Some(&(back, len)) = self.frames.back() {
            if back < from_seq {
                break;
            }
            self.frames.pop_back();
            self.bytes -= len;
        }
    }
}

/// Sends the outbox frames after `sent`, in seq order, moving `sent` along,
/// one page of at most [`RESEND_PAGE_BYTES`] at a time, until the outbox is
/// sent or [`SEND_WINDOW_BYTES`] are in flight; an `Ack` calls it again.
/// False when the socket failed.
async fn send_pending<S>(
    sink: &mut S,
    store: &Store,
    sent: &mut u64,
    in_flight: &mut InFlight,
) -> Result<bool, DrError>
where
    S: Sink<Message> + Unpin,
{
    loop {
        let page = store.pending_page(*sent, RESEND_PAGE_BYTES).await?;
        if page.is_empty() {
            return Ok(true);
        }
        for (seq, frame) in page {
            if !in_flight.fits(frame.len()) {
                return Ok(true);
            }
            in_flight.push(seq, frame.len());
            if sink.send(Message::text(frame)).await.is_err() {
                return Ok(false);
            }
            *sent = seq;
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
        // 1011 (a control plane fault, a failed token lookup included) and anything else: reconnect after the backoff.
        _ => Ended::Dropped { acked },
    }
}
