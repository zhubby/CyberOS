use std::time::Duration;

use async_trait::async_trait;

use crate::domain::metric::Collection;
use crate::domain::metric::{CollectorState, MetricSample};
use crate::error::MonitorError;

#[async_trait]
pub trait Collector: Send {
    fn id(&self) -> &'static str;
    fn interval(&self) -> Duration;
    async fn collect(&mut self, timestamp_ms: i64) -> Result<Collection, MonitorError>;
}

pub trait Clock: Clone + Send + Sync + 'static {
    fn wall_time_ms(&self) -> i64;
}

#[async_trait]
pub trait MetricsStorePort: Clone + Send + Sync + 'static {
    async fn record_collection(
        &self,
        collector: &'static str,
        state: CollectorState,
        samples: Vec<MetricSample>,
        attempted_at_ms: i64,
        duration_ms: f64,
        error: Option<String>,
    ) -> Result<(), MonitorError>;

    async fn maintain(&self, now_ms: i64) -> Result<(), MonitorError>;
    async fn stop(&self);
}
