use std::path::{Path, PathBuf};
use std::time::Duration;

use sd_notify::NotifyState;
use tokio::time::{Instant, MissedTickBehavior};
use tokio_util::sync::CancellationToken;

use crate::adapters::alert_sqlite::AlertStore;
use crate::adapters::clock::SystemClock;
use crate::adapters::metrics_query::MetricsQuery;
use crate::adapters::smtp::LettreMailTransport;
use crate::application::alerter::evaluate_repository;
use crate::domain::config::{Config, MonitoringConfig};
use crate::error::MonitorError;
use crate::ports::{Clock, MailTransport};

const EVALUATION_INTERVAL: Duration = Duration::from_secs(10);
const DELIVERY_INTERVAL: Duration = Duration::from_secs(1);

pub struct AlerterService {
    config: Config,
    shutdown: CancellationToken,
}

impl AlerterService {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            shutdown: CancellationToken::new(),
        }
    }

    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    pub async fn run(self) -> Result<(), MonitorError> {
        let _ = sd_notify::notify(&[
            NotifyState::Status("Waiting for alert schema"),
            NotifyState::Ready,
        ]);
        let evaluation = run_evaluation_loop(self.config.clone(), self.shutdown.child_token());
        let delivery = run_delivery_loop(
            self.config.database_path.clone(),
            self.shutdown.child_token(),
        );
        let result = tokio::try_join!(evaluation, delivery);
        let _ = sd_notify::notify(&[NotifyState::Stopping]);
        result.map(|_| ())
    }
}

async fn run_evaluation_loop(
    config: Config,
    shutdown: CancellationToken,
) -> Result<(), MonitorError> {
    let mut schedule = tokio::time::interval_at(Instant::now(), EVALUATION_INTERVAL);
    schedule.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => break,
            _ = schedule.tick() => {
                let database_path = config.database_path.clone();
                let metrics_path = config.metrics_database_path.clone();
                let monitoring = config.monitoring.clone();
                let now_ms = SystemClock.wall_time_ms();
                let result = tokio::task::spawn_blocking(move || {
                    evaluate_once(&database_path, &metrics_path, &monitoring, now_ms)
                }).await.map_err(|error| MonitorError::Collector(error.to_string()))?;
                match result {
                    Ok(()) => {
                        let _ = sd_notify::notify(&[NotifyState::Status("Evaluating alerts")]);
                    }
                    Err(MonitorError::AlertSchemaUnavailable) => {
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
) -> Result<(), MonitorError> {
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
) -> Result<(), MonitorError>
where
    T: MailTransport,
    C: Clock,
{
    let database_path = database_path.to_path_buf();
    let claim_path = database_path.clone();
    let claim_clock = clock.clone();
    let claimed = tokio::task::spawn_blocking(move || {
        let mut store = AlertStore::open(&claim_path)?;
        let settings = store.smtp_settings()?;
        let delivery = if settings.enabled {
            store.claim_delivery(claim_clock.wall_time_ms())?
        } else {
            None
        };
        Ok::<_, MonitorError>((settings, delivery))
    })
    .await
    .map_err(|error| MonitorError::Collector(error.to_string()))??;
    let (settings, Some(delivery)) = claimed else {
        return Ok(());
    };
    let result = transport.deliver(&settings, &delivery).await;
    let error = result.as_ref().err().map(ToString::to_string);
    tokio::task::spawn_blocking(move || {
        let mut store = AlertStore::open(&database_path)?;
        store.finish_delivery(
            &delivery,
            clock.wall_time_ms(),
            error.as_deref().map_or(Ok(()), Err),
        )
    })
    .await
    .map_err(|error| MonitorError::Collector(error.to_string()))??;
    result
}

fn evaluate_once(
    database_path: &Path,
    metrics_path: &Path,
    monitoring: &MonitoringConfig,
    now_ms: i64,
) -> Result<(), MonitorError> {
    let mut store = AlertStore::open(database_path)?;
    let metrics = MetricsQuery::new(metrics_path, monitoring);
    evaluate_repository(&mut store, &metrics, monitoring.enabled, now_ms)
}
