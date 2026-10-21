use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use zos_monitoring_contracts::{METRICS_SCHEMA_VERSION, MetricKind, SamplingIntervals, metric};

use crate::domain::rule::{Aggregation, AlertRule, MetricTransform, SeriesValue};
use crate::error::AlerterError;
use crate::ports::MetricsReader;

#[derive(Debug, Clone)]
pub struct MetricsQuery {
    path: PathBuf,
    sampling: SamplingIntervals,
}

impl MetricsQuery {
    pub fn new(path: impl Into<PathBuf>, sampling: SamplingIntervals) -> Self {
        Self {
            path: path.into(),
            sampling,
        }
    }

    pub fn evaluate(
        &self,
        rule: &AlertRule,
        now_ms: i64,
    ) -> Result<Vec<SeriesValue>, AlerterError> {
        // Reopening per evaluation makes database replacement visible without retaining a stale inode.
        let connection = open_reader(&self.path)?;
        let mut statement = connection.prepare(
            "SELECT id, labels_key, labels_json FROM metric_series WHERE metric_name = ? ORDER BY labels_key",
        )?;
        let rows = statement
            .query_map([&rule.metric], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let definition = metric(&rule.metric)
            .ok_or_else(|| AlerterError::AlertRule("unknown metric".to_owned()))?;
        let cadence = self.sampling.for_cadence(definition.cadence);
        let mut values = Vec::new();
        for (series_id, key, labels_json) in rows {
            let labels: BTreeMap<String, String> = serde_json::from_str(&labels_json)?;
            if !rule
                .selector
                .iter()
                .all(|(name, value)| labels.get(name) == Some(value))
            {
                continue;
            }
            let value = evaluate_series(
                &connection,
                series_id,
                rule,
                definition.kind,
                now_ms,
                cadence,
            )?;
            values.push(SeriesValue { key, labels, value });
        }
        if values.is_empty() && rule.selector.len() == definition.label_keys.len() {
            let key = serde_json::to_string(&rule.selector)?;
            values.push(SeriesValue {
                key,
                labels: rule.selector.clone(),
                value: None,
            });
        }
        Ok(values)
    }
}

impl MetricsReader for MetricsQuery {
    fn evaluate(&self, rule: &AlertRule, now_ms: i64) -> Result<Vec<SeriesValue>, AlerterError> {
        Self::evaluate(self, rule, now_ms)
    }
}

fn open_reader(path: &Path) -> Result<Connection, AlerterError> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "query_only", "ON")?;
    let version: i64 = connection
        .query_row(
            "SELECT MAX(version) FROM monitoring_schema_migrations",
            [],
            |row| row.get::<_, Option<i64>>(0),
        )?
        .unwrap_or_default();
    if version > METRICS_SCHEMA_VERSION {
        return Err(AlerterError::FutureMetricsSchema(version));
    }
    Ok(connection)
}

fn evaluate_series(
    connection: &Connection,
    series_id: i64,
    rule: &AlertRule,
    kind: MetricKind,
    now_ms: i64,
    cadence: Duration,
) -> Result<Option<f64>, AlerterError> {
    let start_ms = now_ms.saturating_sub(duration_ms(rule.window));
    let latest_timestamp: Option<i64> = connection
        .query_row(
            "SELECT MAX(timestamp_ms) FROM metric_samples_raw WHERE series_id = ? AND timestamp_ms <= ?",
            params![series_id, now_ms],
            |row| row.get(0),
        )?;
    let stale_after = duration_ms(cadence).saturating_mul(2);
    if latest_timestamp.is_none_or(|timestamp| now_ms.saturating_sub(timestamp) > stale_after) {
        return Ok(None);
    }

    if rule.metric == "zos_monitor_last_sample_timestamp_seconds" {
        let latest: Option<f64> = connection
            .query_row(
                "SELECT value FROM metric_samples_raw WHERE series_id = ? AND timestamp_ms <= ? ORDER BY timestamp_ms DESC LIMIT 1",
                params![series_id, now_ms],
                |row| row.get(0),
            )
            .optional()?;
        return Ok(latest.map(|timestamp| (now_ms as f64 / 1000.0 - timestamp).max(0.0)));
    }

    let mut statement = connection.prepare(
        "SELECT timestamp_ms, value FROM metric_samples_raw \
         WHERE series_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ? ORDER BY timestamp_ms",
    )?;
    let mut points = statement
        .query_map(params![series_id, start_ms, now_ms], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    if rule.transform == MetricTransform::Rate {
        if kind != MetricKind::Counter {
            return Err(AlerterError::AlertRule(
                "rate transform requires a counter".to_owned(),
            ));
        }
        let baseline: Option<(i64, f64)> = connection
            .query_row(
                "SELECT timestamp_ms, value FROM metric_samples_raw \
                 WHERE series_id = ? AND timestamp_ms < ? ORDER BY timestamp_ms DESC LIMIT 1",
                params![series_id, start_ms],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some(baseline) = baseline {
            points.insert(0, baseline);
        }
        return Ok(aggregate(&counter_rates(&points), rule.aggregation));
    }
    Ok(aggregate(&points, rule.aggregation))
}

fn aggregate(points: &[(i64, f64)], aggregation: Aggregation) -> Option<f64> {
    if points.is_empty() {
        return None;
    }
    match aggregation {
        Aggregation::Last => points.last().map(|point| point.1),
        Aggregation::Avg => {
            Some(points.iter().map(|point| point.1).sum::<f64>() / points.len() as f64)
        }
        Aggregation::Min => points.iter().map(|point| point.1).reduce(f64::min),
        Aggregation::Max => points.iter().map(|point| point.1).reduce(f64::max),
    }
}

fn counter_rates(points: &[(i64, f64)]) -> Vec<(i64, f64)> {
    points
        .windows(2)
        .filter_map(|pair| {
            let elapsed = (pair[1].0 - pair[0].0) as f64 / 1_000.0;
            if elapsed <= 0.0 {
                return None;
            }
            let increase = if pair[1].1 >= pair[0].1 {
                pair[1].1 - pair[0].1
            } else {
                pair[1].1
            };
            Some((pair[1].0, increase / elapsed))
        })
        .collect()
}

fn duration_ms(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::rule::{Comparator, NoDataPolicy, Severity};

    fn write_series(
        path: &Path,
        metric_name: &str,
        labels: &BTreeMap<String, String>,
        points: &[(i64, f64)],
    ) {
        let mut connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS monitoring_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;",
            )
            .unwrap();
        let version: i64 = connection
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM monitoring_schema_migrations",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let migrations = [
            include_str!("../../../../packages/monitoring/contracts/migrations/001_initial.sql"),
            include_str!(
                "../../../../packages/monitoring/contracts/migrations/002_counter_increase.sql"
            ),
            include_str!(
                "../../../../packages/monitoring/contracts/migrations/003_counter_boundary.sql"
            ),
        ];
        for (index, sql) in migrations.iter().enumerate().skip(version as usize) {
            connection.execute_batch(sql).unwrap();
            connection
                .execute(
                    "INSERT INTO monitoring_schema_migrations(version, applied_at) VALUES (?, 'test')",
                    [i64::try_from(index + 1).unwrap()],
                )
                .unwrap();
        }
        let labels_json = serde_json::to_string(labels).unwrap();
        connection
            .execute(
                "INSERT INTO metric_series(metric_name, labels_key, labels_json, created_at_ms) VALUES (?, ?, ?, 0)",
                params![metric_name, labels_json, labels_json],
            )
            .unwrap();
        let series_id = connection.last_insert_rowid();
        let transaction = connection.transaction().unwrap();
        for (timestamp_ms, value) in points {
            transaction
                .execute(
                    "INSERT INTO metric_samples_raw(series_id, timestamp_ms, value) VALUES (?, ?, ?)",
                    params![series_id, timestamp_ms, value],
                )
                .unwrap();
        }
        transaction.commit().unwrap();
    }

    #[test]
    fn counter_rate_handles_resets() {
        let points = [(0, 100.0), (10_000, 160.0), (20_000, 20.0), (30_000, 50.0)];
        assert_eq!(
            counter_rates(&points),
            vec![(10_000, 6.0), (20_000, 2.0), (30_000, 3.0)]
        );
    }

    #[test]
    fn counter_rate_is_aggregated_after_reset_aware_transformation() {
        let rates = counter_rates(&[(0, 100.0), (10_000, 160.0), (20_000, 20.0)]);
        assert_eq!(aggregate(&rates, Aggregation::Last), Some(2.0));
        assert_eq!(aggregate(&rates, Aggregation::Avg), Some(4.0));
        assert_eq!(aggregate(&rates, Aggregation::Min), Some(2.0));
        assert_eq!(aggregate(&rates, Aggregation::Max), Some(6.0));
    }

    #[test]
    fn accepts_schema_v3_and_rejects_a_future_schema() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("metrics.sqlite");
        write_series(&path, "zos_host_load1", &BTreeMap::new(), &[(10_000, 2.5)]);

        assert!(open_reader(&path).is_ok());

        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "INSERT INTO monitoring_schema_migrations(version, applied_at) VALUES (4, 'test')",
                [],
            )
            .unwrap();
        drop(connection);

        assert!(matches!(
            open_reader(&path),
            Err(AlerterError::FutureMetricsSchema(4))
        ));
    }

    #[test]
    fn alert_rate_matches_the_shared_golden_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/monitoring/contracts/golden/metrics-parity.json"
        ))
        .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("metrics.sqlite");
        let labels = BTreeMap::from([("interface".to_owned(), "eth0".to_owned())]);
        let mut points = Vec::new();
        for sample in fixture["samples"].as_array().unwrap() {
            if sample["metric"] != "zos_host_network_receive_bytes_total" {
                continue;
            }
            points.push((
                sample["timestampMs"].as_i64().unwrap(),
                sample["value"].as_f64().unwrap(),
            ));
        }
        write_series(
            &path,
            "zos_host_network_receive_bytes_total",
            &labels,
            &points,
        );
        let rule = AlertRule {
            id: "network-rate".to_owned(),
            name: "Network rate".to_owned(),
            metric: "zos_host_network_receive_bytes_total".to_owned(),
            selector: BTreeMap::from([("interface".to_owned(), "eth0".to_owned())]),
            transform: MetricTransform::Rate,
            aggregation: Aggregation::Last,
            window: Duration::from_secs(60),
            comparator: Comparator::Greater,
            trigger_threshold: 1.0,
            recovery_threshold: 0.5,
            trigger_duration: Duration::ZERO,
            recovery_duration: Duration::ZERO,
            severity: Severity::Warning,
            no_data: NoDataPolicy::Ignore,
        };
        let values = MetricsQuery::new(path, SamplingIntervals::default())
            .evaluate(&rule, 130_000)
            .unwrap();
        let expected = fixture["expected"]["query"]["alertCounterRate"]
            .as_f64()
            .unwrap();
        assert!((values[0].value.unwrap() - expected).abs() < f64::EPSILON);
    }

    #[test]
    fn stale_detection_uses_the_configured_collection_cadence() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("metrics.sqlite");
        let sampling = SamplingIntervals {
            fast: Duration::from_secs(60),
            standard: Duration::from_secs(60),
            ..SamplingIntervals::default()
        };
        write_series(&path, "zos_host_load1", &BTreeMap::new(), &[(10_000, 2.5)]);
        let mut rule = AlertRule {
            id: "load".to_owned(),
            name: "High load".to_owned(),
            metric: "zos_host_load1".to_owned(),
            selector: BTreeMap::new(),
            transform: MetricTransform::Value,
            aggregation: Aggregation::Last,
            window: Duration::from_secs(300),
            comparator: Comparator::Greater,
            trigger_threshold: 4.0,
            recovery_threshold: 3.0,
            trigger_duration: Duration::ZERO,
            recovery_duration: Duration::ZERO,
            severity: Severity::Warning,
            no_data: NoDataPolicy::Ignore,
        };

        let configured = MetricsQuery::new(&path, sampling)
            .evaluate(&rule, 100_000)
            .unwrap();
        assert_eq!(configured[0].value, Some(2.5));

        rule.no_data = NoDataPolicy::Firing;
        let defaults = MetricsQuery::new(&path, SamplingIntervals::default())
            .evaluate(&rule, 100_000)
            .unwrap();
        assert_eq!(defaults[0].value, None);
    }
}
