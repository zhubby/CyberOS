use sd_notify::NotifyState;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::adapters::clock::SystemClock;
use crate::adapters::collectors::default_collectors;
use crate::adapters::metrics_sqlite::MetricsStoreHandle;
use crate::application::monitor::{run_collector, run_maintenance};
use crate::domain::config::MonitorConfig;
use crate::error::MonitorError;
use crate::ports::{Collector, MetricsStorePort};

pub struct MonitorService {
    config: MonitorConfig,
    collectors: Vec<Box<dyn Collector>>,
    shutdown: CancellationToken,
}

impl MonitorService {
    pub fn new(config: MonitorConfig) -> Self {
        let collectors = default_collectors(&config);
        Self {
            config,
            collectors,
            shutdown: CancellationToken::new(),
        }
    }

    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    pub async fn run(self) -> Result<(), MonitorError> {
        if !self.config.monitoring.enabled {
            let _ = sd_notify::notify(&[
                NotifyState::Status("Monitoring disabled"),
                NotifyState::Ready,
            ]);
            self.shutdown.cancelled().await;
            let _ = sd_notify::notify(&[NotifyState::Stopping]);
            return Ok(());
        }

        let store = MetricsStoreHandle::start(
            self.config.metrics_database_path.clone(),
            self.config.monitoring.clone(),
        )
        .await?;
        let mut tasks = JoinSet::new();
        for collector in self.collectors {
            tasks.spawn(run_collector(
                collector,
                store.clone(),
                SystemClock,
                self.shutdown.child_token(),
            ));
        }
        tasks.spawn(run_maintenance(
            store.clone(),
            SystemClock,
            self.shutdown.child_token(),
        ));

        let _ = sd_notify::notify(&[
            NotifyState::Status("Collecting system metrics"),
            NotifyState::Ready,
        ]);
        self.shutdown.cancelled().await;
        let _ = sd_notify::notify(&[NotifyState::Stopping]);

        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => tracing::warn!(error = %error, "monitor task stopped"),
                Err(error) => tracing::warn!(error = %error, "monitor task panicked"),
            }
        }
        MetricsStorePort::stop(&store).await;
        Ok(())
    }
}
