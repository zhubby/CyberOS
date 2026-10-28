use crate::error::AlerterError;
use crate::ports::{AlertEvaluationStore, EscalationStore, MaintenanceStore, MetricsReader};

const MAX_RULE_SERIES: usize = 64;

pub struct EvaluationCycle;

impl EvaluationCycle {
    pub fn run<R, Q>(
        store: &mut R,
        metrics: &Q,
        monitoring_enabled: bool,
        now_ms: i64,
    ) -> Result<(), AlerterError>
    where
        R: AlertEvaluationStore + EscalationStore + MaintenanceStore,
        Q: MetricsReader,
    {
        let mut cycle_error = AlertEvaluator::evaluate(store, metrics, monitoring_enabled, now_ms)?;
        HealthIncidentSynchronizer::sync(store, now_ms)?;
        if let Err(error) = EscalationCoordinator::schedule(store, now_ms) {
            cycle_error = Some(error.sanitized().to_owned());
        }
        RetentionCoordinator::maintain(store, now_ms)?;
        store.finish_cycle(now_ms, cycle_error.as_deref())?;
        Ok(())
    }
}

pub struct AlertEvaluator;

impl AlertEvaluator {
    fn evaluate<R, Q>(
        store: &mut R,
        metrics: &Q,
        monitoring_enabled: bool,
        now_ms: i64,
    ) -> Result<Option<String>, AlerterError>
    where
        R: AlertEvaluationStore,
        Q: MetricsReader,
    {
        let rules = store.enabled_rules()?;
        let mut cycle_error = None;
        for rule in rules.into_iter().filter(|_| monitoring_enabled) {
            if let Err(error) = rule.validate() {
                store.mark_rule_error(&rule.id, &error.to_string(), now_ms)?;
                cycle_error = Some("Alert rule is invalid".to_owned());
                continue;
            }
            match metrics.evaluate(&rule, now_ms) {
                Ok(values) if values.len() <= MAX_RULE_SERIES => {
                    let mut evaluation_failed = false;
                    for value in values {
                        if let Err(error) = store.apply_metric_evaluation(
                            &rule,
                            &value.key,
                            &value.labels,
                            value.value,
                            now_ms,
                        ) {
                            store.mark_rule_error(&rule.id, error.sanitized(), now_ms)?;
                            cycle_error = Some(error.sanitized().to_owned());
                            evaluation_failed = true;
                        }
                    }
                    if !evaluation_failed {
                        store.clear_rule_error(&rule.id, now_ms)?;
                    }
                }
                Ok(_) => {
                    store.mark_rule_error(
                        &rule.id,
                        "Alert rule expands beyond 64 series",
                        now_ms,
                    )?;
                    cycle_error = Some("Alert rule expands beyond 64 series".to_owned());
                }
                Err(error) if rule.id == "builtin-monitor-stale" => {
                    store.apply_metric_evaluation(
                        &rule,
                        "{}",
                        &std::collections::BTreeMap::new(),
                        None,
                        now_ms,
                    )?;
                    store.mark_rule_error(&rule.id, error.sanitized(), now_ms)?;
                    cycle_error = Some(error.sanitized().to_owned());
                }
                Err(error) => {
                    store.mark_rule_error(&rule.id, error.sanitized(), now_ms)?;
                    cycle_error = Some(error.sanitized().to_owned());
                }
            }
        }
        Ok(cycle_error)
    }
}

pub struct HealthIncidentSynchronizer;

impl HealthIncidentSynchronizer {
    fn sync(store: &mut impl AlertEvaluationStore, now_ms: i64) -> Result<(), AlerterError> {
        store.sync_health_incidents(now_ms)
    }
}

pub struct EscalationCoordinator;

impl EscalationCoordinator {
    fn schedule(store: &mut impl EscalationStore, now_ms: i64) -> Result<(), AlerterError> {
        store.schedule_due_deliveries(now_ms)
    }
}

pub struct RetentionCoordinator;

impl RetentionCoordinator {
    fn maintain(store: &impl MaintenanceStore, now_ms: i64) -> Result<(), AlerterError> {
        store.maintain(now_ms)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::collections::BTreeMap;
    use std::time::Duration;

    use super::*;
    use crate::domain::rule::{
        Aggregation, AlertRule, Comparator, MetricTransform, NoDataPolicy, SeriesValue, Severity,
    };
    use crate::ports::AlertEvaluationStore;

    struct EvaluationStore {
        rules: Vec<AlertRule>,
    }

    impl AlertEvaluationStore for EvaluationStore {
        fn enabled_rules(&self) -> Result<Vec<AlertRule>, AlerterError> {
            Ok(self.rules.clone())
        }

        fn apply_metric_evaluation(
            &mut self,
            _rule: &AlertRule,
            _series_key: &str,
            _labels: &BTreeMap<String, String>,
            _value: Option<f64>,
            _now_ms: i64,
        ) -> Result<(), AlerterError> {
            Ok(())
        }

        fn mark_rule_error(
            &self,
            _rule_id: &str,
            _message: &str,
            _now_ms: i64,
        ) -> Result<(), AlerterError> {
            Ok(())
        }

        fn clear_rule_error(&self, _rule_id: &str, _now_ms: i64) -> Result<(), AlerterError> {
            Ok(())
        }

        fn sync_health_incidents(&mut self, _now_ms: i64) -> Result<(), AlerterError> {
            Ok(())
        }

        fn finish_cycle(&self, _now_ms: i64, _error: Option<&str>) -> Result<(), AlerterError> {
            Ok(())
        }
    }

    struct CountingMetricsReader {
        calls: Cell<usize>,
    }

    impl MetricsReader for CountingMetricsReader {
        fn evaluate(
            &self,
            _rule: &AlertRule,
            _now_ms: i64,
        ) -> Result<Vec<SeriesValue>, AlerterError> {
            self.calls.set(self.calls.get() + 1);
            Ok(Vec::new())
        }
    }

    #[test]
    fn disabled_monitoring_skips_metric_rule_evaluation() {
        let mut store = EvaluationStore {
            rules: vec![AlertRule {
                id: "load".to_owned(),
                name: "High load".to_owned(),
                metric: "cyberos_host_load1".to_owned(),
                selector: BTreeMap::new(),
                transform: MetricTransform::Value,
                aggregation: Aggregation::Last,
                window: Duration::from_secs(60),
                comparator: Comparator::Greater,
                trigger_threshold: 4.0,
                recovery_threshold: 3.0,
                trigger_duration: Duration::ZERO,
                recovery_duration: Duration::ZERO,
                severity: Severity::Warning,
                no_data: NoDataPolicy::Ignore,
            }],
        };
        let metrics = CountingMetricsReader {
            calls: Cell::new(0),
        };

        let result = AlertEvaluator::evaluate(&mut store, &metrics, false, 0).unwrap();

        assert_eq!(result, None);
        assert_eq!(metrics.calls.get(), 0);
    }
}
