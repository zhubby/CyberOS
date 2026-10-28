use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cyberos_monitoring_contracts::{MetricKind, metric};
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::sync::mpsc;

use crate::domain::metric::CollectorState;
use crate::domain::metric::MetricSample;

const QUEUE_CAPACITY: usize = 128;
const MAX_EVENT_BYTES: usize = 256 * 1024;

#[derive(Clone)]
pub struct MetricsEventPublisher {
    sender: mpsc::Sender<PendingEvent>,
    sequence: Arc<std::sync::atomic::AtomicU64>,
    baselines: Arc<Mutex<BTreeMap<String, (i64, f64)>>>,
}

pub struct CollectionCommitted {
    pub attempted_at_ms: i64,
    pub samples: Vec<MetricSample>,
    pub collector: &'static str,
    pub state: CollectorState,
    pub degraded: bool,
    pub last_success_at_ms: Option<i64>,
    pub duration_ms: f64,
    pub consecutive_failures: i64,
    pub error: Option<String>,
}

impl MetricsEventPublisher {
    pub fn start(socket_path: PathBuf) -> Self {
        let (sender, receiver) = mpsc::channel(QUEUE_CAPACITY);
        tokio::spawn(publish_loop(socket_path, receiver));
        Self {
            sender,
            sequence: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            baselines: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    pub fn publish_collection(&self, committed: CollectionCommitted) {
        let sequence = self
            .sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .saturating_add(1);
        let samples = committed
            .samples
            .into_iter()
            .map(|sample| self.map_sample(sample))
            .collect();
        let event = MonitoringSamplesEvent {
            protocol_version: 1,
            source: "monitor",
            sequence,
            event_type: "samples",
            sampled_at: iso(committed.attempted_at_ms),
            samples,
            collectors: vec![MonitoringCollectorEvent {
                collector: committed.collector.to_owned(),
                state: committed.state.as_str().to_owned(),
                last_attempt_at: iso(committed.attempted_at_ms),
                last_success_at: committed.last_success_at_ms.map(iso),
                duration_ms: committed.duration_ms.max(0.0),
                consecutive_failures: committed.consecutive_failures,
                error: committed.error.as_deref().map(sanitize_error),
            }],
            status: if committed.degraded {
                "degraded"
            } else {
                "ready"
            },
        };
        let Ok(payload) = serde_json::to_vec(&event) else {
            return;
        };
        if payload.len() > MAX_EVENT_BYTES {
            tracing::warn!("monitoring event exceeded size limit");
            return;
        }
        let mut line = payload;
        line.push(b'\n');
        let _ = self.sender.try_send(PendingEvent(line));
    }

    fn map_sample(&self, sample: MetricSample) -> MonitoringSampleEvent {
        let key = format!(
            "{}:{}",
            sample.metric,
            serde_json::to_string(&sample.labels).unwrap_or_default()
        );
        let rate = if metric(&sample.metric)
            .is_some_and(|definition| definition.kind == MetricKind::Counter)
        {
            let mut baselines = self
                .baselines
                .lock()
                .expect("monitor event baseline mutex poisoned");
            let rate = baselines.get(&key).and_then(|(timestamp_ms, previous)| {
                let elapsed = (sample.timestamp_ms - *timestamp_ms) as f64 / 1_000.0;
                if elapsed <= 0.0 {
                    return None;
                }
                Some(if sample.value >= *previous {
                    (sample.value - *previous) / elapsed
                } else {
                    sample.value / elapsed
                })
            });
            baselines.insert(key, (sample.timestamp_ms, sample.value));
            rate
        } else {
            None
        };
        MonitoringSampleEvent {
            metric: sample.metric,
            labels: sample.labels,
            timestamp: iso(sample.timestamp_ms),
            value: sample.value,
            rate,
        }
    }
}

struct PendingEvent(Vec<u8>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitoringSamplesEvent {
    protocol_version: u8,
    source: &'static str,
    sequence: u64,
    #[serde(rename = "type")]
    event_type: &'static str,
    sampled_at: String,
    samples: Vec<MonitoringSampleEvent>,
    collectors: Vec<MonitoringCollectorEvent>,
    status: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitoringSampleEvent {
    metric: String,
    labels: BTreeMap<String, String>,
    timestamp: String,
    value: f64,
    rate: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitoringCollectorEvent {
    collector: String,
    state: String,
    last_attempt_at: String,
    last_success_at: Option<String>,
    duration_ms: f64,
    consecutive_failures: i64,
    error: Option<&'static str>,
}

async fn publish_loop(socket_path: PathBuf, mut receiver: mpsc::Receiver<PendingEvent>) {
    let mut stream: Option<UnixStream> = None;
    while let Some(PendingEvent(payload)) = receiver.recv().await {
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

fn iso(timestamp_ms: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(timestamp_ms) * 1_000_000)
        .ok()
        .and_then(|value| {
            value
                .format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_owned())
}

fn sanitize_error(_error: &str) -> &'static str {
    "Collector failed"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counter_rate_handles_reset() {
        let publisher = MetricsEventPublisher {
            sender: mpsc::channel(1).0,
            sequence: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            baselines: Arc::new(Mutex::new(BTreeMap::new())),
        };
        let first = publisher.map_sample(MetricSample::new(
            "cyberos_host_network_receive_bytes_total",
            1_000,
            100.0,
        ));
        let second = publisher.map_sample(MetricSample::new(
            "cyberos_host_network_receive_bytes_total",
            2_000,
            10.0,
        ));
        assert_eq!(first.rate, None);
        assert_eq!(second.rate, Some(10.0));
    }
}
