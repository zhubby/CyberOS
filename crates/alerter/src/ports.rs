use std::collections::BTreeMap;

use async_trait::async_trait;

use crate::domain::delivery::{ClaimedDelivery, SmtpSettings};
use crate::domain::rule::{AlertRule, SeriesValue};
use crate::error::AlerterError;

pub trait Clock: Clone + Send + Sync + 'static {
    fn wall_time_ms(&self) -> i64;
}

pub trait MetricsReader {
    fn evaluate(&self, rule: &AlertRule, now_ms: i64) -> Result<Vec<SeriesValue>, AlerterError>;
}

pub trait AlertEvaluationStore {
    fn enabled_rules(&self) -> Result<Vec<AlertRule>, AlerterError>;
    fn apply_metric_evaluation(
        &mut self,
        rule: &AlertRule,
        series_key: &str,
        labels: &BTreeMap<String, String>,
        value: Option<f64>,
        now_ms: i64,
    ) -> Result<(), AlerterError>;
    fn mark_rule_error(
        &self,
        rule_id: &str,
        message: &str,
        now_ms: i64,
    ) -> Result<(), AlerterError>;
    fn clear_rule_error(&self, rule_id: &str, now_ms: i64) -> Result<(), AlerterError>;
    fn sync_health_incidents(&mut self, now_ms: i64) -> Result<(), AlerterError>;
    fn finish_cycle(&self, now_ms: i64, error: Option<&str>) -> Result<(), AlerterError>;
}

pub trait EscalationStore {
    fn schedule_due_deliveries(&mut self, now_ms: i64) -> Result<(), AlerterError>;
}

pub trait MaintenanceStore {
    fn maintain(&self, now_ms: i64) -> Result<(), AlerterError>;
}

pub trait DeliveryStore {
    fn smtp_settings(&self) -> Result<SmtpSettings, AlerterError>;
    fn claim_delivery(&mut self, now_ms: i64) -> Result<Option<ClaimedDelivery>, AlerterError>;
    fn finish_delivery(
        &mut self,
        delivery: &ClaimedDelivery,
        now_ms: i64,
        error: Option<&str>,
    ) -> Result<(), AlerterError>;
}

#[async_trait]
pub trait MailTransport: Send + Sync {
    async fn deliver(
        &self,
        settings: &SmtpSettings,
        delivery: &ClaimedDelivery,
    ) -> Result<(), AlerterError>;
}
