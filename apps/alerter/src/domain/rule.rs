use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetricTransform {
    Value,
    Rate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Aggregation {
    Last,
    Avg,
    Min,
    Max,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Comparator {
    #[serde(rename = ">")]
    Greater,
    #[serde(rename = ">=")]
    GreaterOrEqual,
    #[serde(rename = "<")]
    Less,
    #[serde(rename = "<=")]
    LessOrEqual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warning,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoDataPolicy {
    Ignore,
    Firing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlertRule {
    pub id: String,
    pub name: String,
    pub metric: String,
    pub selector: BTreeMap<String, String>,
    pub transform: MetricTransform,
    pub aggregation: Aggregation,
    pub window: Duration,
    pub comparator: Comparator,
    pub trigger_threshold: f64,
    pub recovery_threshold: f64,
    pub trigger_duration: Duration,
    pub recovery_duration: Duration,
    pub severity: Severity,
    pub no_data: NoDataPolicy,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SeriesValue {
    pub key: String,
    pub labels: BTreeMap<String, String>,
    pub value: Option<f64>,
}

impl AlertRule {
    pub fn validate(&self) -> Result<(), AlertRuleError> {
        if self.id.is_empty() || self.name.trim().is_empty() || self.metric.is_empty() {
            return Err(invalid_rule("id, name, and metric are required"));
        }
        if !matches!(self.window.as_secs(), 60 | 300 | 900 | 1_800 | 3_600) {
            return Err(invalid_rule("window is not supported"));
        }
        if self.trigger_duration > Duration::from_secs(86_400)
            || self.recovery_duration > Duration::from_secs(86_400)
        {
            return Err(invalid_rule("duration exceeds 24 hours"));
        }
        if !self.trigger_threshold.is_finite() || !self.recovery_threshold.is_finite() {
            return Err(invalid_rule("threshold must be finite"));
        }
        let hysteresis_is_valid = match self.comparator {
            Comparator::Greater | Comparator::GreaterOrEqual => {
                self.recovery_threshold < self.trigger_threshold
            }
            Comparator::Less | Comparator::LessOrEqual => {
                self.recovery_threshold > self.trigger_threshold
            }
        };
        if !hysteresis_is_valid {
            return Err(invalid_rule("recovery threshold does not form hysteresis"));
        }
        Ok(())
    }

    pub fn is_triggering(&self, value: f64) -> bool {
        match self.comparator {
            Comparator::Greater => value > self.trigger_threshold,
            Comparator::GreaterOrEqual => value >= self.trigger_threshold,
            Comparator::Less => value < self.trigger_threshold,
            Comparator::LessOrEqual => value <= self.trigger_threshold,
        }
    }

    pub fn is_recovered(&self, value: f64) -> bool {
        match self.comparator {
            Comparator::Greater | Comparator::GreaterOrEqual => value <= self.recovery_threshold,
            Comparator::Less | Comparator::LessOrEqual => value >= self.recovery_threshold,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstanceState {
    Normal,
    Pending,
    Firing,
    Recovering,
    Resolved,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AlertInstance {
    pub state: InstanceState,
    pub state_since_ms: i64,
    pub last_value: Option<f64>,
}

impl AlertInstance {
    pub fn normal(now_ms: i64) -> Self {
        Self {
            state: InstanceState::Normal,
            state_since_ms: now_ms,
            last_value: None,
        }
    }

    pub fn evaluate(
        &mut self,
        rule: &AlertRule,
        value: Option<f64>,
        now_ms: i64,
    ) -> EvaluationOutcome {
        let previous = self.state;
        if value.is_none() && rule.no_data == NoDataPolicy::Ignore {
            return EvaluationOutcome::Unchanged;
        }
        self.last_value = value;
        let triggering = value.is_none_or(|current| rule.is_triggering(current));
        let recovered = value.is_some_and(|current| rule.is_recovered(current));

        match self.state {
            InstanceState::Normal | InstanceState::Resolved if triggering => {
                if rule.trigger_duration.is_zero() {
                    self.transition(InstanceState::Firing, now_ms);
                } else {
                    self.transition(InstanceState::Pending, now_ms);
                }
            }
            InstanceState::Pending if !triggering => {
                self.transition(InstanceState::Normal, now_ms);
            }
            InstanceState::Pending
                if elapsed(now_ms, self.state_since_ms) >= rule.trigger_duration =>
            {
                self.transition(InstanceState::Firing, now_ms);
            }
            InstanceState::Firing if recovered => {
                if rule.recovery_duration.is_zero() {
                    self.transition(InstanceState::Resolved, now_ms);
                } else {
                    self.transition(InstanceState::Recovering, now_ms);
                }
            }
            InstanceState::Recovering if triggering => {
                self.transition(InstanceState::Firing, now_ms);
            }
            InstanceState::Recovering
                if recovered && elapsed(now_ms, self.state_since_ms) >= rule.recovery_duration =>
            {
                self.transition(InstanceState::Resolved, now_ms);
            }
            _ => {}
        }

        match (previous, self.state) {
            (before, InstanceState::Firing) if before != InstanceState::Firing => {
                EvaluationOutcome::Fired
            }
            (before, InstanceState::Resolved) if before != InstanceState::Resolved => {
                EvaluationOutcome::Resolved
            }
            (before, after) if before != after => EvaluationOutcome::StateChanged(after),
            _ => EvaluationOutcome::Unchanged,
        }
    }

    fn transition(&mut self, state: InstanceState, now_ms: i64) {
        self.state = state;
        self.state_since_ms = now_ms;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvaluationOutcome {
    Unchanged,
    StateChanged(InstanceState),
    Fired,
    Resolved,
}

fn elapsed(now_ms: i64, since_ms: i64) -> Duration {
    Duration::from_millis(u64::try_from(now_ms.saturating_sub(since_ms)).unwrap_or_default())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlertRuleError(String);

impl std::fmt::Display for AlertRuleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for AlertRuleError {}

fn invalid_rule(message: &str) -> AlertRuleError {
    AlertRuleError(message.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule() -> AlertRule {
        AlertRule {
            id: "cpu".to_owned(),
            name: "High CPU".to_owned(),
            metric: "zos_host_cpu_usage_ratio".to_owned(),
            selector: BTreeMap::new(),
            transform: MetricTransform::Value,
            aggregation: Aggregation::Avg,
            window: Duration::from_secs(300),
            comparator: Comparator::Greater,
            trigger_threshold: 0.9,
            recovery_threshold: 0.8,
            trigger_duration: Duration::from_secs(60),
            recovery_duration: Duration::from_secs(120),
            severity: Severity::Warning,
            no_data: NoDataPolicy::Ignore,
        }
    }

    #[test]
    fn validates_hysteresis_and_fixed_windows() {
        let mut current = rule();
        assert!(current.validate().is_ok());
        current.recovery_threshold = 0.95;
        assert!(current.validate().is_err());
        current.recovery_threshold = 0.8;
        current.window = Duration::from_secs(120);
        assert!(current.validate().is_err());
    }

    #[test]
    fn transitions_through_pending_firing_recovering_and_resolved() {
        let current = rule();
        let mut instance = AlertInstance::normal(0);
        assert_eq!(
            instance.evaluate(&current, Some(0.95), 1_000),
            EvaluationOutcome::StateChanged(InstanceState::Pending)
        );
        assert_eq!(
            instance.evaluate(&current, Some(0.96), 61_000),
            EvaluationOutcome::Fired
        );
        assert_eq!(
            instance.evaluate(&current, Some(0.85), 70_000),
            EvaluationOutcome::Unchanged
        );
        assert_eq!(
            instance.evaluate(&current, Some(0.75), 80_000),
            EvaluationOutcome::StateChanged(InstanceState::Recovering)
        );
        assert_eq!(
            instance.evaluate(&current, Some(0.75), 200_000),
            EvaluationOutcome::Resolved
        );
    }

    #[test]
    fn no_data_ignore_does_not_change_an_instance() {
        let current = rule();
        let mut instance = AlertInstance::normal(0);
        assert_eq!(
            instance.evaluate(&current, None, 100_000),
            EvaluationOutcome::Unchanged
        );
        assert_eq!(instance.state, InstanceState::Normal);
    }

    #[test]
    fn no_data_firing_uses_the_trigger_duration() {
        let mut current = rule();
        current.no_data = NoDataPolicy::Firing;
        let mut instance = AlertInstance::normal(0);
        instance.evaluate(&current, None, 1_000);
        assert_eq!(instance.state, InstanceState::Pending);
        assert_eq!(
            instance.evaluate(&current, None, 61_000),
            EvaluationOutcome::Fired
        );
    }
}
