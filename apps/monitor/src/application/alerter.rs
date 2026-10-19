use crate::error::MonitorError;
use crate::ports::{AlertRepository, MetricsReaderPort};

const MAX_RULE_SERIES: usize = 64;

pub(crate) fn evaluate_repository<R, Q>(
    store: &mut R,
    metrics: &Q,
    monitoring_enabled: bool,
    now_ms: i64,
) -> Result<(), MonitorError>
where
    R: AlertRepository,
    Q: MetricsReaderPort,
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
                store.mark_rule_error(&rule.id, "Alert rule expands beyond 64 series", now_ms)?;
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
    store.sync_health_incidents(now_ms)?;
    if let Err(error) = store.schedule_due_deliveries(now_ms) {
        cycle_error = Some(error.sanitized().to_owned());
    }
    store.maintain(now_ms)?;
    store.finish_cycle(now_ms, cycle_error.as_deref())?;
    Ok(())
}
