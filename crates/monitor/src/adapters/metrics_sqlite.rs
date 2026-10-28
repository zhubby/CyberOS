use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use cyberos_monitoring_contracts::METRICS_SCHEMA_VERSION;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use tokio::sync::{mpsc, oneshot};

use crate::adapters::catalog;
use crate::adapters::monitoring_events::{CollectionCommitted, MetricsEventPublisher};
use crate::domain::config::MonitoringConfig;
#[cfg(test)]
use crate::domain::metric::MetricKind;
use crate::domain::metric::{CollectorState, MetricSample};
use crate::error::MonitorError;
use crate::ports::MetricsStorePort;

const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const MAX_SERIES_PER_METRIC: i64 = 64;
const MAX_SERIES: i64 = 512;
const INACTIVE_SERIES_AFTER_MS: i64 = 24 * 60 * 60 * 1_000;

const MIGRATIONS: &[(i64, &str)] = &[
    (
        1,
        include_str!("../../../../packages/monitoring/contracts/migrations/001_initial.sql"),
    ),
    (
        2,
        include_str!(
            "../../../../packages/monitoring/contracts/migrations/002_counter_increase.sql"
        ),
    ),
    (
        3,
        include_str!(
            "../../../../packages/monitoring/contracts/migrations/003_counter_boundary.sql"
        ),
    ),
];

pub struct MetricsStore {
    connection: Connection,
    database_path: PathBuf,
    config: MonitoringConfig,
    writes_paused: bool,
}

impl MetricsStore {
    pub fn open(path: impl Into<PathBuf>, config: MonitoringConfig) -> Result<Self, MonitorError> {
        let database_path = path.into();
        if let Some(parent) = database_path.parent() {
            fs::create_dir_all(parent)?;
        }
        match Self::open_once(database_path.clone(), config.clone()) {
            Ok(store) => Ok(store),
            Err(error) if is_corruption(&error) => {
                quarantine(&database_path)?;
                Self::open_once(database_path, config)
            }
            Err(error) => Err(error),
        }
    }

    fn open_once(database_path: PathBuf, config: MonitoringConfig) -> Result<Self, MonitorError> {
        let mut connection = Connection::open(&database_path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let version = schema_version(&connection)?;
        if version > METRICS_SCHEMA_VERSION {
            return Err(MonitorError::FutureMetricsSchema(version));
        }
        ensure_incremental_vacuum(&connection)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        migrate(&mut connection, version)?;
        let writes_paused = connection
            .query_row(
                "SELECT value FROM monitoring_metadata WHERE key = 'writes_paused'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .is_some_and(|value| value == "1");
        Ok(Self {
            connection,
            database_path,
            config,
            writes_paused,
        })
    }

    pub fn write_samples(&mut self, samples: &[MetricSample]) -> Result<usize, MonitorError> {
        if self.writes_paused || samples.is_empty() {
            return Ok(0);
        }
        for sample in samples {
            validate_sample(sample)?;
        }
        let transaction = self.connection.transaction()?;
        let mut touched_minutes = BTreeSet::new();
        let mut touched_hours = BTreeSet::new();
        let mut written = 0;
        for sample in samples {
            let Some(series_id) = ensure_series(&transaction, sample)? else {
                continue;
            };
            transaction.execute(
                "INSERT INTO metric_samples_raw(series_id, timestamp_ms, value) VALUES (?, ?, ?) \
                 ON CONFLICT(series_id, timestamp_ms) DO UPDATE SET value = excluded.value",
                params![series_id, sample.timestamp_ms, sample.value],
            )?;
            touched_minutes.insert((series_id, sample.timestamp_ms));
            touched_hours.insert((series_id, sample.timestamp_ms));
            written += 1;
        }
        for (series_id, timestamp_ms) in touched_minutes {
            rebuild_rollup_and_next(
                &transaction,
                "metric_rollups_1m",
                series_id,
                timestamp_ms,
                MINUTE_MS,
            )?;
        }
        for (series_id, timestamp_ms) in touched_hours {
            rebuild_rollup_and_next(
                &transaction,
                "metric_rollups_1h",
                series_id,
                timestamp_ms,
                HOUR_MS,
            )?;
        }
        transaction.commit()?;
        Ok(written)
    }

    pub fn record_collector(
        &mut self,
        collector: &str,
        state: CollectorState,
        attempted_at_ms: i64,
        duration_ms: f64,
        error: Option<&str>,
    ) -> Result<(), MonitorError> {
        if collector.is_empty() || collector.len() > 64 {
            return Err(MonitorError::Collector("invalid collector id".to_owned()));
        }
        let previous: Option<(Option<i64>, i64)> = self
            .connection
            .query_row(
                "SELECT last_success_ms, consecutive_failures FROM collector_status WHERE collector_id = ?",
                [collector],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let succeeded = matches!(state, CollectorState::Ready | CollectorState::Unsupported);
        let last_success = if succeeded {
            Some(attempted_at_ms)
        } else {
            previous.as_ref().and_then(|value| value.0)
        };
        let failures = if state == CollectorState::Error {
            previous.map_or(1, |value| value.1 + 1)
        } else {
            0
        };
        self.connection.execute(
            "INSERT INTO collector_status(collector_id, state, last_attempt_ms, last_success_ms, duration_ms, consecutive_failures, error) \
             VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(collector_id) DO UPDATE SET \
             state = excluded.state, last_attempt_ms = excluded.last_attempt_ms, last_success_ms = excluded.last_success_ms, \
             duration_ms = excluded.duration_ms, consecutive_failures = excluded.consecutive_failures, error = excluded.error",
            params![
                collector,
                state.as_str(),
                attempted_at_ms,
                last_success,
                duration_ms.max(0.0),
                failures,
                error.map(sanitize_error)
            ],
        )?;
        Ok(())
    }

    pub fn maintain(&mut self, now_ms: i64) -> Result<(), MonitorError> {
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "DELETE FROM metric_samples_raw WHERE timestamp_ms < ?",
            [now_ms - duration_ms(self.config.raw_retention)],
        )?;
        transaction.execute(
            "DELETE FROM metric_rollups_1m WHERE bucket_ms < ?",
            [now_ms - duration_ms(self.config.minute_retention)],
        )?;
        transaction.execute(
            "DELETE FROM metric_rollups_1h WHERE bucket_ms < ?",
            [now_ms - duration_ms(self.config.hour_retention)],
        )?;
        prune_series(&transaction)?;
        transaction.commit()?;
        checkpoint(&self.connection)?;

        let target = self.config.max_database_bytes.saturating_mul(4) / 5;
        let mut bytes = database_bytes(&self.database_path);
        if bytes > self.config.max_database_bytes {
            reclaim(&self.connection, &self.database_path, target)?;
            bytes = database_bytes(&self.database_path);
            for table in [
                "metric_samples_raw",
                "metric_rollups_1m",
                "metric_rollups_1h",
            ] {
                while bytes > target {
                    let column = if table == "metric_samples_raw" {
                        "timestamp_ms"
                    } else {
                        "bucket_ms"
                    };
                    let sql = format!(
                        "DELETE FROM {table} WHERE (series_id, {column}) IN \
                         (SELECT series_id, {column} FROM {table} ORDER BY {column} ASC LIMIT 5000)"
                    );
                    if self.connection.execute(&sql, [])? == 0 {
                        break;
                    }
                    checkpoint(&self.connection)?;
                    reclaim(&self.connection, &self.database_path, target)?;
                    bytes = database_bytes(&self.database_path);
                }
                if bytes <= target {
                    break;
                }
            }
            let transaction = self.connection.transaction()?;
            prune_series(&transaction)?;
            transaction.commit()?;
        }
        self.writes_paused = database_bytes(&self.database_path) > self.config.max_database_bytes;
        self.connection.execute(
            "INSERT INTO monitoring_metadata(key, value) VALUES ('writes_paused', ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [if self.writes_paused { "1" } else { "0" }],
        )?;
        checkpoint(&self.connection)?;
        Ok(())
    }

    pub fn database_bytes(&self) -> u64 {
        database_bytes(&self.database_path)
    }

    pub fn writes_paused(&self) -> bool {
        self.writes_paused
    }
}

#[derive(Clone)]
pub struct MetricsStoreHandle {
    sender: mpsc::Sender<StoreCommand>,
}

impl MetricsStoreHandle {
    pub async fn start(path: PathBuf, config: MonitoringConfig) -> Result<Self, MonitorError> {
        Self::start_with_publisher(path, config, None).await
    }

    pub async fn start_with_publisher(
        path: PathBuf,
        config: MonitoringConfig,
        publisher: Option<MetricsEventPublisher>,
    ) -> Result<Self, MonitorError> {
        let store = tokio::task::spawn_blocking(move || MetricsStore::open(path, config))
            .await
            .map_err(|error| MonitorError::Collector(error.to_string()))??;
        let (sender, mut receiver) = mpsc::channel::<StoreCommand>(64);
        tokio::task::spawn_blocking(move || {
            let mut store = store;
            while let Some(command) = receiver.blocking_recv() {
                match command {
                    StoreCommand::Collection {
                        collector,
                        state,
                        samples,
                        attempted_at_ms,
                        duration_ms,
                        error,
                        reply,
                    } => {
                        let result = record_collection(
                            &mut store,
                            collector,
                            state,
                            &samples,
                            attempted_at_ms,
                            duration_ms,
                            error.as_deref(),
                        );
                        if let (Ok(committed), Some(publisher)) = (&result, publisher.as_ref()) {
                            publisher.publish_collection(CollectionCommitted {
                                attempted_at_ms: committed.attempted_at_ms,
                                samples: committed.samples.clone(),
                                collector: committed.collector,
                                state: committed.state,
                                degraded: committed.degraded,
                                last_success_at_ms: committed.last_success_at_ms,
                                duration_ms: committed.duration_ms,
                                consecutive_failures: committed.consecutive_failures,
                                error: committed.error.clone(),
                            });
                        }
                        let _ = reply.send(result.map(|_| ()));
                    }
                    StoreCommand::Maintain { now_ms, reply } => {
                        let _ = reply.send(store.maintain(now_ms));
                    }
                    StoreCommand::Stop { reply } => {
                        let _ = checkpoint(&store.connection);
                        let _ = reply.send(());
                        break;
                    }
                }
            }
        });
        Ok(Self { sender })
    }

    pub async fn record_collection(
        &self,
        collector: &'static str,
        state: CollectorState,
        samples: Vec<MetricSample>,
        attempted_at_ms: i64,
        duration_ms: f64,
        error: Option<String>,
    ) -> Result<(), MonitorError> {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(StoreCommand::Collection {
                collector,
                state,
                samples,
                attempted_at_ms,
                duration_ms,
                error,
                reply,
            })
            .await
            .map_err(|_| MonitorError::WorkerStopped)?;
        response.await.map_err(|_| MonitorError::WorkerStopped)?
    }

    pub async fn maintain(&self, now_ms: i64) -> Result<(), MonitorError> {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(StoreCommand::Maintain { now_ms, reply })
            .await
            .map_err(|_| MonitorError::WorkerStopped)?;
        response.await.map_err(|_| MonitorError::WorkerStopped)?
    }

    pub async fn stop(&self) {
        let (reply, response) = oneshot::channel();
        if self.sender.send(StoreCommand::Stop { reply }).await.is_ok() {
            let _ = response.await;
        }
    }
}

#[async_trait::async_trait]
impl MetricsStorePort for MetricsStoreHandle {
    async fn record_collection(
        &self,
        collector: &'static str,
        state: CollectorState,
        samples: Vec<MetricSample>,
        attempted_at_ms: i64,
        duration_ms: f64,
        error: Option<String>,
    ) -> Result<(), MonitorError> {
        Self::record_collection(
            self,
            collector,
            state,
            samples,
            attempted_at_ms,
            duration_ms,
            error,
        )
        .await
    }

    async fn maintain(&self, now_ms: i64) -> Result<(), MonitorError> {
        Self::maintain(self, now_ms).await
    }

    async fn stop(&self) {
        Self::stop(self).await;
    }
}

enum StoreCommand {
    Collection {
        collector: &'static str,
        state: CollectorState,
        samples: Vec<MetricSample>,
        attempted_at_ms: i64,
        duration_ms: f64,
        error: Option<String>,
        reply: oneshot::Sender<Result<(), MonitorError>>,
    },
    Maintain {
        now_ms: i64,
        reply: oneshot::Sender<Result<(), MonitorError>>,
    },
    Stop {
        reply: oneshot::Sender<()>,
    },
}

fn record_collection(
    store: &mut MetricsStore,
    collector: &'static str,
    state: CollectorState,
    samples: &[MetricSample],
    attempted_at_ms: i64,
    duration_ms: f64,
    error: Option<&str>,
) -> Result<CollectionCommitted, MonitorError> {
    let mut actual_state = state;
    let mut actual_error = error.map(str::to_owned);
    if state != CollectorState::Error {
        let written = store.write_samples(samples)?;
        if written != samples.len() {
            actual_state = CollectorState::Error;
            actual_error = Some(if store.writes_paused() {
                "Monitoring sample writes are paused because the database is over capacity"
                    .to_owned()
            } else {
                format!(
                    "Monitoring series limit rejected {} samples",
                    samples.len() - written
                )
            });
        }
    }
    store.record_collector(
        collector,
        actual_state,
        attempted_at_ms,
        duration_ms,
        actual_error.as_deref(),
    )?;
    let up = f64::from(actual_state != CollectorState::Error);
    let failures = store.connection.query_row(
        "SELECT consecutive_failures FROM collector_status WHERE collector_id = ?",
        [collector],
        |row| row.get::<_, i64>(0),
    )?;
    let last_success_at_ms = store.connection.query_row(
        "SELECT last_success_ms FROM collector_status WHERE collector_id = ?",
        [collector],
        |row| row.get::<_, Option<i64>>(0),
    )?;
    let degraded = store.connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM collector_status WHERE state = 'error')",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    let mut self_samples = vec![
        MetricSample::new("cyberos_monitor_collector_up", attempted_at_ms, up)
            .with_label("collector", collector),
        MetricSample::new(
            "cyberos_monitor_collector_duration_seconds",
            attempted_at_ms,
            duration_ms / 1000.0,
        )
        .with_label("collector", collector),
        MetricSample::new(
            "cyberos_monitor_collector_consecutive_failures",
            attempted_at_ms,
            failures as f64,
        )
        .with_label("collector", collector),
        MetricSample::new(
            "cyberos_monitor_database_size_bytes",
            attempted_at_ms,
            store.database_bytes() as f64,
        ),
    ];
    if actual_state != CollectorState::Error {
        self_samples.push(MetricSample::new(
            "cyberos_monitor_last_sample_timestamp_seconds",
            attempted_at_ms,
            attempted_at_ms as f64 / 1000.0,
        ));
    }
    let _ = store.write_samples(&self_samples)?;
    let mut published_samples = if actual_state == CollectorState::Error {
        Vec::new()
    } else {
        samples.to_vec()
    };
    published_samples.extend(self_samples);
    Ok(CollectionCommitted {
        attempted_at_ms,
        samples: published_samples,
        collector,
        state: actual_state,
        degraded,
        last_success_at_ms,
        duration_ms,
        consecutive_failures: failures,
        error: actual_error,
    })
}

fn schema_version(connection: &Connection) -> Result<i64, MonitorError> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'monitoring_schema_migrations')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(0);
    }
    Ok(connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM monitoring_schema_migrations",
        [],
        |row| row.get(0),
    )?)
}

fn migrate(connection: &mut Connection, current: i64) -> Result<(), MonitorError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS monitoring_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;",
    )?;
    for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version > current) {
        let transaction = connection.transaction()?;
        transaction.execute_batch(sql)?;
        transaction.execute(
            "INSERT INTO monitoring_schema_migrations(version, applied_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [version],
        )?;
        transaction.commit()?;
    }
    Ok(())
}

fn validate_sample(sample: &MetricSample) -> Result<(), MonitorError> {
    let definition = catalog::metric(&sample.metric)
        .ok_or_else(|| MonitorError::Collector(format!("unknown metric: {}", sample.metric)))?;
    if !sample.value.is_finite() || sample.timestamp_ms < 0 {
        return Err(MonitorError::Collector("invalid metric sample".to_owned()));
    }
    let keys: Vec<_> = sample.labels.keys().map(String::as_str).collect();
    let expected: Vec<_> = definition.label_keys.iter().map(String::as_str).collect();
    if keys != expected
        || sample
            .labels
            .values()
            .any(|value| value.is_empty() || value.len() > 128)
    {
        return Err(MonitorError::Collector(format!(
            "metric {} has invalid labels",
            sample.metric
        )));
    }
    Ok(())
}

fn ensure_series(
    transaction: &Transaction<'_>,
    sample: &MetricSample,
) -> Result<Option<i64>, MonitorError> {
    let labels = serde_json::to_string(&sample.labels)?;
    if let Some(id) = transaction
        .query_row(
            "SELECT id FROM metric_series WHERE metric_name = ? AND labels_key = ?",
            params![sample.metric, labels],
            |row| row.get(0),
        )
        .optional()?
    {
        return Ok(Some(id));
    }
    let mut metric_total: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM metric_series WHERE metric_name = ?",
        [&sample.metric],
        |row| row.get(0),
    )?;
    if metric_total >= MAX_SERIES_PER_METRIC {
        reclaim_inactive_series(transaction, Some(&sample.metric), sample.timestamp_ms)?;
        metric_total = transaction.query_row(
            "SELECT COUNT(*) FROM metric_series WHERE metric_name = ?",
            [&sample.metric],
            |row| row.get(0),
        )?;
        if metric_total >= MAX_SERIES_PER_METRIC {
            return Ok(None);
        }
    }
    let mut total: i64 =
        transaction.query_row("SELECT COUNT(*) FROM metric_series", [], |row| row.get(0))?;
    if total >= MAX_SERIES {
        reclaim_inactive_series(transaction, None, sample.timestamp_ms)?;
        total =
            transaction.query_row("SELECT COUNT(*) FROM metric_series", [], |row| row.get(0))?;
        if total >= MAX_SERIES {
            return Ok(None);
        }
    }
    transaction.execute(
        "INSERT INTO metric_series(metric_name, labels_key, labels_json, created_at_ms) VALUES (?, ?, ?, ?)",
        params![sample.metric, labels, labels, sample.timestamp_ms],
    )?;
    Ok(Some(transaction.last_insert_rowid()))
}

fn reclaim_inactive_series(
    transaction: &Transaction<'_>,
    metric: Option<&str>,
    now_ms: i64,
) -> Result<(), MonitorError> {
    let cutoff = now_ms.saturating_sub(INACTIVE_SERIES_AFTER_MS);
    if let Some(metric) = metric {
        transaction.execute(
            "DELETE FROM metric_series WHERE id IN (\
             SELECT series.id FROM metric_series series \
             WHERE series.metric_name = ? \
               AND NOT EXISTS (SELECT 1 FROM metric_samples_raw raw WHERE raw.series_id = series.id AND raw.timestamp_ms >= ?) \
             ORDER BY COALESCE((SELECT MAX(timestamp_ms) FROM metric_samples_raw raw WHERE raw.series_id = series.id), series.created_at_ms) ASC \
             LIMIT 1)",
            params![metric, cutoff],
        )?;
    } else {
        transaction.execute(
            "DELETE FROM metric_series WHERE id IN (\
             SELECT series.id FROM metric_series series \
             WHERE NOT EXISTS (SELECT 1 FROM metric_samples_raw raw WHERE raw.series_id = series.id AND raw.timestamp_ms >= ?) \
             ORDER BY COALESCE((SELECT MAX(timestamp_ms) FROM metric_samples_raw raw WHERE raw.series_id = series.id), series.created_at_ms) ASC \
             LIMIT 1)",
            [cutoff],
        )?;
    }
    Ok(())
}

#[derive(Debug)]
struct RawPoint {
    timestamp_ms: i64,
    value: f64,
}

fn rebuild_rollup_and_next(
    transaction: &Transaction<'_>,
    table: &str,
    series_id: i64,
    timestamp_ms: i64,
    bucket_size_ms: i64,
) -> Result<(), MonitorError> {
    rebuild_rollup(transaction, table, series_id, timestamp_ms, bucket_size_ms)?;
    let next_bucket = (timestamp_ms.div_euclid(bucket_size_ms) + 1) * bucket_size_ms;
    let next: Option<i64> = transaction.query_row(
        "SELECT MIN(timestamp_ms) FROM metric_samples_raw WHERE series_id = ? AND timestamp_ms >= ?",
        params![series_id, next_bucket],
        |row| row.get(0),
    )?;
    if let Some(next) = next {
        rebuild_rollup(transaction, table, series_id, next, bucket_size_ms)?;
    }
    Ok(())
}

fn rebuild_rollup(
    transaction: &Transaction<'_>,
    table: &str,
    series_id: i64,
    timestamp_ms: i64,
    bucket_size_ms: i64,
) -> Result<(), MonitorError> {
    let bucket_ms = timestamp_ms.div_euclid(bucket_size_ms) * bucket_size_ms;
    let mut statement = transaction.prepare(
        "SELECT timestamp_ms, value FROM metric_samples_raw WHERE series_id = ? AND timestamp_ms >= ? AND timestamp_ms < ? ORDER BY timestamp_ms ASC",
    )?;
    let points: Vec<_> = statement
        .query_map(
            params![series_id, bucket_ms, bucket_ms + bucket_size_ms],
            |row| {
                Ok(RawPoint {
                    timestamp_ms: row.get(0)?,
                    value: row.get(1)?,
                })
            },
        )?
        .collect::<Result<_, _>>()?;
    let Some(first) = points.first() else {
        return Ok(());
    };
    let last = points.last().expect("non-empty points");
    let mut min = first.value;
    let mut max = first.value;
    let mut sum = 0.0;
    let mut increase = 0.0;
    let mut previous = first.value;
    for point in &points {
        min = min.min(point.value);
        max = max.max(point.value);
        sum += point.value;
        if point.timestamp_ms != first.timestamp_ms {
            increase += if point.value >= previous {
                point.value - previous
            } else {
                point.value
            };
            previous = point.value;
        }
    }
    let prior: Option<f64> = transaction
        .query_row(
            "SELECT value FROM metric_samples_raw WHERE series_id = ? AND timestamp_ms < ? ORDER BY timestamp_ms DESC LIMIT 1",
            params![series_id, first.timestamp_ms],
            |row| row.get(0),
        )
        .optional()?;
    let boundary = prior.map_or(0.0, |prior| {
        if first.value >= prior {
            first.value - prior
        } else {
            first.value
        }
    });
    let sql = format!(
        "INSERT INTO {table}(series_id, bucket_ms, first_timestamp_ms, last_timestamp_ms, first_value, last_value, min_value, max_value, sum_value, sample_count, increase_value, boundary_increase_value) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(series_id, bucket_ms) DO UPDATE SET \
         first_timestamp_ms=excluded.first_timestamp_ms, last_timestamp_ms=excluded.last_timestamp_ms, first_value=excluded.first_value, \
         last_value=excluded.last_value, min_value=excluded.min_value, max_value=excluded.max_value, sum_value=excluded.sum_value, \
         sample_count=excluded.sample_count, increase_value=excluded.increase_value, boundary_increase_value=excluded.boundary_increase_value"
    );
    transaction.execute(
        &sql,
        params![
            series_id,
            bucket_ms,
            first.timestamp_ms,
            last.timestamp_ms,
            first.value,
            last.value,
            min,
            max,
            sum,
            points.len() as i64,
            increase,
            boundary
        ],
    )?;
    Ok(())
}

fn ensure_incremental_vacuum(connection: &Connection) -> Result<(), MonitorError> {
    let mode: i64 = connection.pragma_query_value(None, "auto_vacuum", |row| row.get(0))?;
    if mode == 2 {
        return Ok(());
    }
    connection.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    let updated: i64 = connection.pragma_query_value(None, "auto_vacuum", |row| row.get(0))?;
    if updated != 2 {
        connection.execute_batch("VACUUM")?;
    }
    Ok(())
}

fn checkpoint(connection: &Connection) -> Result<bool, MonitorError> {
    let busy: i64 =
        connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
    Ok(busy == 0)
}

fn reclaim(connection: &Connection, path: &Path, target: u64) -> Result<(), MonitorError> {
    while database_bytes(path) > target {
        let free: i64 = connection.pragma_query_value(None, "freelist_count", |row| row.get(0))?;
        if free <= 0 {
            break;
        }
        let before = database_bytes(path);
        connection.execute_batch(&format!("PRAGMA incremental_vacuum({})", free.min(4096)))?;
        if !checkpoint(connection)? || database_bytes(path) >= before {
            break;
        }
    }
    Ok(())
}

fn prune_series(transaction: &Transaction<'_>) -> Result<(), MonitorError> {
    transaction.execute_batch(
        "DELETE FROM metric_series WHERE NOT EXISTS (SELECT 1 FROM metric_samples_raw WHERE series_id = metric_series.id) \
         AND NOT EXISTS (SELECT 1 FROM metric_rollups_1m WHERE series_id = metric_series.id) \
         AND NOT EXISTS (SELECT 1 FROM metric_rollups_1h WHERE series_id = metric_series.id);",
    )?;
    Ok(())
}

fn database_bytes(path: &Path) -> u64 {
    ["", "-wal", "-shm", "-journal"]
        .iter()
        .filter_map(|suffix| fs::metadata(format!("{}{}", path.display(), suffix)).ok())
        .map(|metadata| metadata.len())
        .sum()
}

fn duration_ms(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

fn sanitize_error(error: &str) -> String {
    let normalized = error.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.starts_with("Monitoring sample writes are paused")
        || normalized.starts_with("Monitoring series limit rejected")
    {
        return normalized.chars().take(240).collect();
    }
    let lower = normalized.to_lowercase();
    if lower.contains("permission denied") || lower.contains("eacces") || lower.contains("eperm") {
        "Collector permission denied".to_owned()
    } else if lower.contains("timed out") || lower.contains("etimedout") {
        "Collector timed out".to_owned()
    } else if lower.contains("unavailable")
        || lower.contains("not found")
        || lower.contains("no such file")
    {
        "Collector dependency unavailable".to_owned()
    } else {
        "Collector failed".to_owned()
    }
}

fn is_corruption(error: &MonitorError) -> bool {
    matches!(
        error,
        MonitorError::Storage(rusqlite::Error::SqliteFailure(code, _))
            if matches!(code.code, rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)
    )
}

fn quarantine(path: &Path) -> Result<(), MonitorError> {
    let suffix = format!(".corrupt-{}", unix_ms());
    for sidecar in ["", "-wal", "-shm", "-journal"] {
        let source = PathBuf::from(format!("{}{}", path.display(), sidecar));
        if source.exists() {
            fs::rename(&source, format!("{}{}{}", path.display(), sidecar, suffix))?;
        }
    }
    let Some(directory) = path.parent() else {
        return Ok(());
    };
    let basename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("metrics.sqlite");
    let mut suffixes: Vec<_> = fs::read_dir(directory)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.strip_prefix(&format!("{basename}.corrupt-"))
                .map(str::to_owned)
        })
        .collect();
    suffixes.sort();
    suffixes.reverse();
    for old in suffixes.into_iter().skip(1) {
        for sidecar in ["", "-wal", "-shm", "-journal"] {
            let candidate = directory.join(format!("{basename}{sidecar}.corrupt-{old}"));
            let _ = fs::remove_file(candidate);
        }
    }
    Ok(())
}

fn unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParityFixture {
        samples: Vec<FixtureSample>,
        collector_updates: Vec<FixtureCollectorUpdate>,
        expected: FixtureExpected,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureSample {
        metric: String,
        labels: std::collections::BTreeMap<String, String>,
        timestamp_ms: i64,
        value: f64,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureCollectorUpdate {
        collector: String,
        state: String,
        attempted_at_ms: i64,
        duration_ms: f64,
        error: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureExpected {
        raw: Vec<ExpectedRaw>,
        rollups_1m: Vec<ExpectedRollup>,
        rollups_1h: Vec<ExpectedRollup>,
        collector_status: ExpectedCollectorStatus,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct ExpectedRaw {
        metric: String,
        labels: std::collections::BTreeMap<String, String>,
        timestamp_ms: i64,
        value: f64,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct ExpectedRollup {
        metric: String,
        bucket_ms: i64,
        first_timestamp_ms: i64,
        last_timestamp_ms: i64,
        first_value: f64,
        last_value: f64,
        min_value: f64,
        max_value: f64,
        sum_value: f64,
        sample_count: i64,
        increase_value: f64,
        boundary_increase_value: f64,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct ExpectedCollectorStatus {
        collector: String,
        state: String,
        last_attempt_ms: i64,
        last_success_ms: i64,
        duration_ms: f64,
        consecutive_failures: i64,
        error: Option<String>,
    }

    fn config() -> MonitoringConfig {
        MonitoringConfig::default()
    }

    #[test]
    fn matches_the_shared_typescript_v3_golden_fixture() {
        let fixture: ParityFixture = serde_json::from_str(include_str!(
            "../../../../packages/monitoring/contracts/golden/metrics-parity.json"
        ))
        .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let mut store =
            MetricsStore::open(directory.path().join("metrics.sqlite"), config()).unwrap();
        for sample in fixture.samples {
            store
                .write_samples(&[MetricSample {
                    metric: sample.metric,
                    labels: sample.labels,
                    timestamp_ms: sample.timestamp_ms,
                    value: sample.value,
                }])
                .unwrap();
        }
        for update in fixture.collector_updates {
            let state = match update.state.as_str() {
                "ready" => CollectorState::Ready,
                "error" => CollectorState::Error,
                "unsupported" => CollectorState::Unsupported,
                _ => CollectorState::Disabled,
            };
            store
                .record_collector(
                    &update.collector,
                    state,
                    update.attempted_at_ms,
                    update.duration_ms,
                    update.error.as_deref(),
                )
                .unwrap();
        }

        assert_eq!(read_raw(&store.connection), fixture.expected.raw);
        assert_eq!(
            read_rollups(&store.connection, "metric_rollups_1m"),
            fixture.expected.rollups_1m
        );
        assert_eq!(
            read_rollups(&store.connection, "metric_rollups_1h"),
            fixture.expected.rollups_1h
        );
        let status = store
            .connection
            .query_row(
                "SELECT collector_id, state, last_attempt_ms, last_success_ms, duration_ms, \
                 consecutive_failures, error FROM collector_status WHERE collector_id = 'fast-host'",
                [],
                |row| {
                    Ok(ExpectedCollectorStatus {
                        collector: row.get(0)?,
                        state: row.get(1)?,
                        last_attempt_ms: row.get(2)?,
                        last_success_ms: row.get(3)?,
                        duration_ms: row.get(4)?,
                        consecutive_failures: row.get(5)?,
                        error: row.get(6)?,
                    })
                },
            )
            .unwrap();
        assert_eq!(status, fixture.expected.collector_status);
    }

    fn read_raw(connection: &Connection) -> Vec<ExpectedRaw> {
        let mut statement = connection
            .prepare(
                "SELECT series.metric_name, series.labels_json, sample.timestamp_ms, sample.value \
                 FROM metric_samples_raw sample JOIN metric_series series ON series.id = sample.series_id \
                 ORDER BY series.metric_name, series.labels_key, sample.timestamp_ms",
            )
            .unwrap();
        statement
            .query_map([], |row| {
                let labels: String = row.get(1)?;
                Ok(ExpectedRaw {
                    metric: row.get(0)?,
                    labels: serde_json::from_str(&labels).unwrap(),
                    timestamp_ms: row.get(2)?,
                    value: row.get(3)?,
                })
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    fn read_rollups(connection: &Connection, table: &str) -> Vec<ExpectedRollup> {
        let mut statement = connection
            .prepare(&format!(
                "SELECT series.metric_name, rollup.bucket_ms, rollup.first_timestamp_ms, \
                 rollup.last_timestamp_ms, rollup.first_value, rollup.last_value, rollup.min_value, \
                 rollup.max_value, rollup.sum_value, rollup.sample_count, rollup.increase_value, \
                 rollup.boundary_increase_value FROM {table} rollup \
                 JOIN metric_series series ON series.id = rollup.series_id \
                 ORDER BY series.metric_name, series.labels_key, rollup.bucket_ms"
            ))
            .unwrap();
        statement
            .query_map([], |row| {
                Ok(ExpectedRollup {
                    metric: row.get(0)?,
                    bucket_ms: row.get(1)?,
                    first_timestamp_ms: row.get(2)?,
                    last_timestamp_ms: row.get(3)?,
                    first_value: row.get(4)?,
                    last_value: row.get(5)?,
                    min_value: row.get(6)?,
                    max_value: row.get(7)?,
                    sum_value: row.get(8)?,
                    sample_count: row.get(9)?,
                    increase_value: row.get(10)?,
                    boundary_increase_value: row.get(11)?,
                })
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    #[test]
    fn migrates_writes_and_builds_reset_aware_rollups() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("metrics.sqlite");
        let mut store = MetricsStore::open(&path, config()).unwrap();
        for (timestamp, value) in [
            (5_000, 100.0),
            (15_000, 110.0),
            (25_000, 0.0),
            (35_000, 150.0),
        ] {
            store
                .write_samples(&[MetricSample::new(
                    "cyberos_host_network_receive_bytes_total",
                    timestamp,
                    value,
                )
                .with_label("interface", "eth0")])
                .unwrap();
        }
        let row: (f64, f64, i64) = store
            .connection
            .query_row(
                "SELECT increase_value, boundary_increase_value, sample_count FROM metric_rollups_1m",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, (160.0, 0.0, 4));
        assert_eq!(schema_version(&store.connection).unwrap(), 3);
    }

    #[test]
    fn rejects_future_schema_without_quarantining_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("metrics.sqlite");
        let store = MetricsStore::open(&path, config()).unwrap();
        store
            .connection
            .execute(
                "INSERT INTO monitoring_schema_migrations(version, applied_at) VALUES (999, 'now')",
                [],
            )
            .unwrap();
        drop(store);
        assert!(matches!(
            MetricsStore::open(&path, config()),
            Err(MonitorError::FutureMetricsSchema(999))
        ));
        assert!(fs::read_dir(directory.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("corrupt")
        }));
    }

    #[test]
    fn quarantines_only_the_metrics_database() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("metrics.sqlite");
        fs::write(&path, "not sqlite").unwrap();
        fs::write(directory.path().join("cyberos.sqlite"), "sentinel").unwrap();
        let mut store = MetricsStore::open(&path, config()).unwrap();
        store
            .write_samples(&[MetricSample::new("cyberos_host_load1", 1_000, 1.0)])
            .unwrap();
        assert_eq!(
            fs::read_to_string(directory.path().join("cyberos.sqlite")).unwrap(),
            "sentinel"
        );
        assert!(fs::read_dir(directory.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("metrics.sqlite.corrupt-")
        }));
    }

    #[test]
    fn validates_labels_against_the_shared_catalog() {
        let directory = tempfile::tempdir().unwrap();
        let mut store =
            MetricsStore::open(directory.path().join("metrics.sqlite"), config()).unwrap();
        let error = store
            .write_samples(&[MetricSample::new("cyberos_queue_depth", 1, 1.0)])
            .unwrap_err();
        assert!(error.to_string().contains("invalid labels"));
    }

    #[test]
    fn reports_database_size_with_wal_sidecars() {
        let directory = tempfile::tempdir().unwrap();
        let store = MetricsStore::open(directory.path().join("metrics.sqlite"), config()).unwrap();
        assert!(store.database_bytes() > 0);
    }

    #[test]
    fn reclaims_an_inactive_series_when_a_metric_reaches_its_limit() {
        let directory = tempfile::tempdir().unwrap();
        let mut store =
            MetricsStore::open(directory.path().join("metrics.sqlite"), config()).unwrap();
        let old_samples: Vec<_> = (0..MAX_SERIES_PER_METRIC)
            .map(|index| {
                MetricSample::new("cyberos_queue_depth", 1_000, index as f64)
                    .with_label("queue", format!("old-{index}"))
            })
            .collect();
        assert_eq!(
            store.write_samples(&old_samples).unwrap(),
            MAX_SERIES_PER_METRIC as usize
        );

        let replacement_time = 1_000 + INACTIVE_SERIES_AFTER_MS + 1;
        assert_eq!(
            store
                .write_samples(&[
                    MetricSample::new("cyberos_queue_depth", replacement_time, 1.0)
                        .with_label("queue", "replacement"),
                ])
                .unwrap(),
            1
        );

        let count: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM metric_series WHERE metric_name = 'cyberos_queue_depth'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let replacement: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM metric_series WHERE metric_name = 'cyberos_queue_depth' AND labels_json = '{\"queue\":\"replacement\"}'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, MAX_SERIES_PER_METRIC);
        assert_eq!(replacement, 1);
    }

    #[test]
    fn catalog_marks_counter_metrics() {
        assert_eq!(
            catalog::metric("cyberos_host_disk_read_bytes_total")
                .unwrap()
                .kind,
            MetricKind::Counter
        );
    }
}
