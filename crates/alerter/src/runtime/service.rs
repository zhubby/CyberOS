use std::env;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sd_notify::NotifyState;
use tokio::time::{Instant, MissedTickBehavior};
use tokio_util::sync::CancellationToken;

use crate::adapters::alert_store::AlertStore;
use crate::adapters::alerter_events::AlertEventPublisher;
use crate::adapters::clock::SystemClock;
use crate::adapters::metrics_sqlite::MetricsQuery;
use crate::adapters::smtp::LettreMailTransport;
use crate::application::evaluation::EvaluationCycle;
use crate::domain::config::AlerterConfig;
use crate::error::AlerterError;
use crate::ports::{Clock, DeliveryStore, MailTransport};

const EVALUATION_INTERVAL: Duration = Duration::from_secs(10);
const DELIVERY_INTERVAL: Duration = Duration::from_secs(1);

pub struct AlerterService {
    config: AlerterConfig,
    shutdown: CancellationToken,
}

impl AlerterService {
    pub fn new(config: AlerterConfig) -> Self {
        Self {
            config,
            shutdown: CancellationToken::new(),
        }
    }

    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    pub async fn run(self) -> Result<(), AlerterError> {
        let publisher = AlertEventPublisher::start(
            env::var_os("CYBEROS_MONITORING_EVENTS_SOCKET")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    if env::var("CYBEROS_ENVIRONMENT").as_deref() == Ok("development") {
                        self.config
                            .database_path
                            .parent()
                            .unwrap_or_else(|| Path::new("."))
                            .join("monitoring-events.sock")
                    } else {
                        PathBuf::from("/run/cyberos/monitoring-events.sock")
                    }
                }),
        );
        let _ = sd_notify::notify(&[NotifyState::Status("Waiting for alert schema")]);
        if !wait_for_first_evaluation(&self.config, self.shutdown.child_token(), publisher.clone())
            .await?
        {
            let _ = sd_notify::notify(&[NotifyState::Stopping]);
            return Ok(());
        }
        let _ = sd_notify::notify(&[NotifyState::Status("Evaluating alerts"), NotifyState::Ready]);
        let evaluation =
            run_evaluation_loop(self.config.clone(), self.shutdown.child_token(), publisher);
        let delivery = run_delivery_loop(
            self.config.database_path.clone(),
            self.shutdown.child_token(),
        );
        let result = tokio::try_join!(evaluation, delivery);
        let _ = sd_notify::notify(&[NotifyState::Stopping]);
        result.map(|_| ())
    }
}

async fn wait_for_first_evaluation(
    config: &AlerterConfig,
    shutdown: CancellationToken,
    publisher: AlertEventPublisher,
) -> Result<bool, AlerterError> {
    loop {
        let database_path = config.database_path.clone();
        let metrics_path = config.metrics_database_path.clone();
        let monitoring_enabled = config.monitoring_enabled;
        let sampling = config.sampling;
        let now_ms = SystemClock.wall_time_ms();
        let result = tokio::task::spawn_blocking(move || {
            evaluate_once(
                &database_path,
                &metrics_path,
                monitoring_enabled,
                sampling,
                now_ms,
            )
        })
        .await
        .map_err(|error| AlerterError::Runtime(error.to_string()))?;
        match result {
            Ok(summary) => {
                publisher.publish_summary(summary, iso(now_ms));
                return Ok(true);
            }
            Err(AlerterError::AlertSchemaUnavailable) => {
                tracing::info!("alert schema is not ready; retrying");
            }
            Err(error) => return Err(error),
        }
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(false),
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
    }
}

async fn run_evaluation_loop(
    config: AlerterConfig,
    shutdown: CancellationToken,
    publisher: AlertEventPublisher,
) -> Result<(), AlerterError> {
    let mut schedule =
        tokio::time::interval_at(Instant::now() + EVALUATION_INTERVAL, EVALUATION_INTERVAL);
    schedule.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => break,
            _ = schedule.tick() => {
                let database_path = config.database_path.clone();
                let metrics_path = config.metrics_database_path.clone();
                let monitoring_enabled = config.monitoring_enabled;
                let sampling = config.sampling;
                let now_ms = SystemClock.wall_time_ms();
                let result = tokio::task::spawn_blocking(move || {
                    evaluate_once(
                        &database_path,
                        &metrics_path,
                        monitoring_enabled,
                        sampling,
                        now_ms,
                    )
                }).await.map_err(|error| AlerterError::Runtime(error.to_string()))?;
                match result {
                    Ok(summary) => {
                        publisher.publish_summary(summary, iso(now_ms));
                        let _ = sd_notify::notify(&[NotifyState::Status("Evaluating alerts")]);
                    }
                    Err(AlerterError::AlertSchemaUnavailable) => {
                        tracing::info!("alert schema is not ready; retrying");
                    }
                    Err(error) => {
                        tracing::warn!(error = %error, "alert evaluation failed");
                    }
                }
            }
        }
    }
    Ok(())
}

async fn run_delivery_loop(
    database_path: PathBuf,
    shutdown: CancellationToken,
) -> Result<(), AlerterError> {
    let mut schedule = tokio::time::interval_at(Instant::now(), DELIVERY_INTERVAL);
    schedule.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => break,
            _ = schedule.tick() => {
                if let Err(error) = dispatch_one(&database_path, &LettreMailTransport, SystemClock).await {
                    tracing::warn!(error = %error, "alert delivery dispatch failed");
                }
            }
        }
    }
    Ok(())
}

async fn dispatch_one<T, C>(
    database_path: &Path,
    transport: &T,
    clock: C,
) -> Result<(), AlerterError>
where
    T: MailTransport,
    C: Clock,
{
    let database_path = database_path.to_path_buf();
    let claim_path = database_path.clone();
    let claim_clock = clock.clone();
    let claimed = tokio::task::spawn_blocking(move || {
        let mut store = AlertStore::open(&claim_path)?;
        let settings = DeliveryStore::smtp_settings(&store)?;
        let delivery = if settings.enabled {
            DeliveryStore::claim_delivery(&mut store, claim_clock.wall_time_ms())?
        } else {
            None
        };
        Ok::<_, AlerterError>((settings, delivery))
    })
    .await
    .map_err(|error| AlerterError::Runtime(error.to_string()))??;
    let (settings, Some(delivery)) = claimed else {
        return Ok(());
    };
    let result = transport.deliver(&settings, &delivery).await;
    let error = result.as_ref().err().map(ToString::to_string);
    tokio::task::spawn_blocking(move || {
        let mut store = AlertStore::open(&database_path)?;
        DeliveryStore::finish_delivery(
            &mut store,
            &delivery,
            clock.wall_time_ms(),
            error.as_deref(),
        )
    })
    .await
    .map_err(|error| AlerterError::Runtime(error.to_string()))??;
    result
}

fn evaluate_once(
    database_path: &Path,
    metrics_path: &Path,
    monitoring_enabled: bool,
    sampling: cyberos_monitoring_contracts::SamplingIntervals,
    now_ms: i64,
) -> Result<crate::ports::AlertSummary, AlerterError> {
    let mut store = AlertStore::open(database_path)?;
    let metrics = MetricsQuery::new(metrics_path, sampling);
    EvaluationCycle::run(&mut store, &metrics, monitoring_enabled, now_ms)?;
    store.summary(now_ms)
}

fn iso(now_ms: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(now_ms) * 1_000_000)
        .ok()
        .and_then(|value| {
            value
                .format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cyberos_monitoring_contracts::SamplingIntervals;

    #[tokio::test]
    async fn cancellation_stops_both_runtime_loops() {
        let directory = tempfile::tempdir().unwrap();
        let config = AlerterConfig {
            database_path: directory.path().join("cyberos.sqlite"),
            metrics_database_path: directory.path().join("metrics.sqlite"),
            monitoring_enabled: false,
            sampling: SamplingIntervals::default(),
        };
        let service = AlerterService::new(config);
        let shutdown = service.shutdown_token();
        let task = tokio::spawn(service.run());

        tokio::task::yield_now().await;
        shutdown.cancel();

        let result = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("alerter runtime should stop after cancellation")
            .expect("alerter runtime task should not panic");
        assert!(result.is_ok());
    }
}
