use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::sync::mpsc;

use crate::ports::AlertSummary;

const QUEUE_CAPACITY: usize = 64;
const MAX_EVENT_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub struct AlertEventPublisher {
    sender: mpsc::Sender<Vec<u8>>,
    sequence: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl AlertEventPublisher {
    pub fn start(socket_path: PathBuf) -> Self {
        let (sender, receiver) = mpsc::channel(QUEUE_CAPACITY);
        tokio::spawn(publish_loop(socket_path, receiver));
        Self {
            sender,
            sequence: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    pub fn publish_summary(&self, summary: AlertSummary, updated_at: String) {
        let sequence = self
            .sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .saturating_add(1);
        let event = AlertSummaryEvent {
            protocol_version: 1,
            source: "alerter",
            sequence,
            event_type: "alert_summary",
            updated_at,
            summary: AlertSummaryPayload {
                unread_count: summary.unread_count,
                firing_count: summary.firing_count,
                alerter_status: summary.alerter_status,
                last_evaluation_at: summary.last_evaluation_at,
                pending_deliveries: summary.pending_deliveries,
            },
        };
        let Ok(mut payload) = serde_json::to_vec(&event) else {
            return;
        };
        if payload.len() > MAX_EVENT_BYTES {
            return;
        }
        payload.push(b'\n');
        let _ = self.sender.try_send(payload);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlertSummaryEvent {
    protocol_version: u8,
    source: &'static str,
    sequence: u64,
    #[serde(rename = "type")]
    event_type: &'static str,
    updated_at: String,
    summary: AlertSummaryPayload,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlertSummaryPayload {
    unread_count: i64,
    firing_count: i64,
    alerter_status: String,
    last_evaluation_at: Option<String>,
    pending_deliveries: i64,
}

async fn publish_loop(socket_path: PathBuf, mut receiver: mpsc::Receiver<Vec<u8>>) {
    let mut stream: Option<UnixStream> = None;
    while let Some(payload) = receiver.recv().await {
        if stream.is_none() {
            stream = connect(&socket_path).await;
        }
        let Some(current) = stream.as_mut() else {
            continue;
        };
        if current.write_all(&payload).await.is_err() {
            stream = None;
        }
    }
}

async fn connect(socket_path: &PathBuf) -> Option<UnixStream> {
    match tokio::time::timeout(Duration::from_millis(250), UnixStream::connect(socket_path)).await {
        Ok(Ok(stream)) => Some(stream),
        _ => {
            tokio::time::sleep(Duration::from_secs(1)).await;
            None
        }
    }
}
