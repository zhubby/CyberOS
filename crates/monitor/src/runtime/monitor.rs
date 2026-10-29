use std::{env, path::PathBuf};

use sd_notify::NotifyState;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::adapters::clock::SystemClock;
use crate::adapters::collectors::default_collectors;
use crate::adapters::metrics_sqlite::MetricsStoreHandle;
use crate::adapters::monitoring_events::MetricsEventPublisher;
use crate::application::monitor::{run_collector, run_maintenance};
use crate::domain::config::MonitorConfig;
use crate::error::MonitorError;
use crate::ports::MetricsStorePort;

pub struct MonitorService {
    config: MonitorConfig,
    shutdown: CancellationToken,
}

impl MonitorService {
    pub fn new(config: MonitorConfig) -> Self {
        Self {
            config,
            shutdown: CancellationToken::new(),
        }
    }

    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    pub async fn run(mut self) -> Result<(), MonitorError> {
        let publisher = MetricsEventPublisher::start(
            env::var_os("CYBEROS_MONITORING_EVENTS_SOCKET")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    if env::var("CYBEROS_ENVIRONMENT").as_deref() == Ok("development") {
                        self.config.state_dir.join("monitoring-events.sock")
                    } else {
                        PathBuf::from("/run/cyberos/monitoring-events.sock")
                    }
                }),
        );
        let _ = sd_notify::notify(&[NotifyState::Ready]);
        loop {
            if self.shutdown.is_cancelled() {
                break;
            }
            if !self.config.monitoring.enabled {
                let _ = sd_notify::notify(&[NotifyState::Status("Monitoring disabled")]);
                tokio::select! {
                    _ = self.shutdown.cancelled() => break,
                    _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
                }
                self.refresh_config();
                continue;
            }
            let next = self.run_generation(publisher.clone()).await?;
            if let Some(monitoring) = next {
                self.config.monitoring = monitoring;
            } else {
                break;
            }
        }
        let _ = sd_notify::notify(&[NotifyState::Stopping]);
        Ok(())
    }

    fn refresh_config(&mut self) {
        match self.config.refresh_monitoring() {
            Ok(monitoring) => self.config.monitoring = monitoring,
            Err(error) => {
                tracing::warn!(error = %error, "monitor settings reload failed; keeping last valid settings")
            }
        }
    }

    async fn run_generation(
        &self,
        publisher: MetricsEventPublisher,
    ) -> Result<Option<crate::domain::config::MonitoringConfig>, MonitorError> {
        let store = MetricsStoreHandle::start_with_publisher(
            self.config.metrics_database_path.clone(),
            self.config.monitoring.clone(),
            Some(publisher),
        )
        .await?;
        let generation_shutdown = self.shutdown.child_token();
        let mut tasks = JoinSet::new();
        for collector in default_collectors(&self.config) {
            tasks.spawn(run_collector(
                collector,
                store.clone(),
                SystemClock,
                generation_shutdown.child_token(),
            ));
        }
        tasks.spawn(run_maintenance(
            store.clone(),
            SystemClock,
            generation_shutdown.child_token(),
        ));
        let _ = sd_notify::notify(&[NotifyState::Status("Collecting system metrics")]);
        let next = loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => break None,
                _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {
                    match self.config.refresh_monitoring() {
                        Ok(monitoring) if monitoring != self.config.monitoring => break Some(monitoring),
                        Ok(_) => {}
                        Err(error) => tracing::warn!(error = %error, "monitor settings reload failed; keeping last valid settings"),
                    }
                }
            }
        };
        generation_shutdown.cancel();
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => tracing::warn!(error = %error, "monitor task stopped"),
                Err(error) => tracing::warn!(error = %error, "monitor task panicked"),
            }
        }
        MetricsStorePort::stop(&store).await;
        Ok(next)
    }
}
