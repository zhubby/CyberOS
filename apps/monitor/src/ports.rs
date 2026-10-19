use std::collections::BTreeMap;
use std::time::Duration;

use async_trait::async_trait;

use crate::domain::alert::{AlertRule, SeriesValue};
use crate::domain::delivery::{ClaimedDelivery, SmtpSettings};
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

pub trait MetricsReaderPort {
    fn evaluate(&self, rule: &AlertRule, now_ms: i64) -> Result<Vec<SeriesValue>, MonitorError>;
}

pub trait AlertRepository {
    fn enabled_rules(&self) -> Result<Vec<AlertRule>, MonitorError>;
    fn apply_metric_evaluation(
        &mut self,
        rule: &AlertRule,
        series_key: &str,
        labels: &BTreeMap<String, String>,
        value: Option<f64>,
        now_ms: i64,
    ) -> Result<(), MonitorError>;
    fn mark_rule_error(
        &self,
        rule_id: &str,
        message: &str,
        now_ms: i64,
    ) -> Result<(), MonitorError>;
    fn clear_rule_error(&self, rule_id: &str, now_ms: i64) -> Result<(), MonitorError>;
    fn sync_health_incidents(&mut self, now_ms: i64) -> Result<(), MonitorError>;
    fn schedule_due_deliveries(&mut self, now_ms: i64) -> Result<(), MonitorError>;
    fn maintain(&self, now_ms: i64) -> Result<(), MonitorError>;
    fn finish_cycle(&self, now_ms: i64, error: Option<&str>) -> Result<(), MonitorError>;
    fn smtp_settings(&self) -> Result<SmtpSettings, MonitorError>;
    fn claim_delivery(&mut self, now_ms: i64) -> Result<Option<ClaimedDelivery>, MonitorError>;
    fn finish_delivery(
        &mut self,
        delivery: &ClaimedDelivery,
        now_ms: i64,
        error: Option<&str>,
    ) -> Result<(), MonitorError>;
}

#[async_trait]
pub trait MailTransport: Send + Sync {
    async fn deliver(
        &self,
        settings: &SmtpSettings,
        delivery: &ClaimedDelivery,
    ) -> Result<(), MonitorError>;
}
