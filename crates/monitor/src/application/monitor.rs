use std::time::Duration;

use tokio::time::{Instant, MissedTickBehavior};
use tokio_util::sync::CancellationToken;

use crate::domain::metric::CollectorState;
use crate::error::MonitorError;
use crate::ports::{Clock, Collector, MetricsStorePort};

const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(60);

pub(crate) async fn run_collector<S, C>(
    mut collector: Box<dyn Collector>,
    store: S,
    clock: C,
    shutdown: CancellationToken,
) -> Result<(), MonitorError>
where
    S: MetricsStorePort,
    C: Clock,
{
    let collector_id = collector.id();
    let mut schedule = tokio::time::interval_at(Instant::now(), collector.interval());
    schedule.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => break,
            _ = schedule.tick() => {
                let timestamp_ms = clock.wall_time_ms();
                let started = Instant::now();
                let result = collector.collect(timestamp_ms).await;
                let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
                let write_result = match result {
                    Ok(collection) => store.record_collection(
                        collector_id,
                        collection.state,
                        collection.samples,
                        timestamp_ms,
                        duration_ms,
                        None,
                    ).await,
                    Err(error) => store.record_collection(
                        collector_id,
                        CollectorState::Error,
                        Vec::new(),
                        timestamp_ms,
                        duration_ms,
                        Some(error.sanitized().to_owned()),
                    ).await,
                };
                if let Err(error) = write_result {
                    tracing::warn!(collector = collector_id, error = %error, "failed to persist collector result");
                }
            }
        }
    }
    Ok(())
}

pub(crate) async fn run_maintenance<S, C>(
    store: S,
    clock: C,
    shutdown: CancellationToken,
) -> Result<(), MonitorError>
where
    S: MetricsStorePort,
    C: Clock,
{
    let mut schedule =
        tokio::time::interval_at(Instant::now() + MAINTENANCE_INTERVAL, MAINTENANCE_INTERVAL);
    schedule.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => break,
            _ = schedule.tick() => {
                if let Err(error) = store.maintain(clock.wall_time_ms()).await {
                    tracing::warn!(error = %error, "monitor maintenance failed");
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;

    use super::*;
    use crate::adapters::clock::SystemClock;
    use crate::adapters::metrics_sqlite::MetricsStoreHandle;
    use crate::domain::config::MonitorConfig;
    use crate::domain::metric::Collection;

    struct SlowCollector {
        active: Arc<AtomicUsize>,
        maximum: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl Collector for SlowCollector {
        fn id(&self) -> &'static str {
            "slow"
        }

        fn interval(&self) -> Duration {
            Duration::from_millis(5)
        }

        async fn collect(&mut self, _timestamp_ms: i64) -> Result<Collection, MonitorError> {
            let current = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.maximum.fetch_max(current, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(25)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok(Collection::ready(Vec::new()))
        }
    }

    #[tokio::test]
    async fn collector_loop_never_overlaps_a_slow_collector() {
        let root = tempfile::tempdir().unwrap();
        let config = MonitorConfig::for_test(root.path());
        let store = MetricsStoreHandle::start(
            config.metrics_database_path.clone(),
            config.monitoring.clone(),
        )
        .await
        .unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let shutdown = CancellationToken::new();
        let task = tokio::spawn(run_collector(
            Box::new(SlowCollector {
                active: active.clone(),
                maximum: maximum.clone(),
            }),
            store.clone(),
            SystemClock,
            shutdown.clone(),
        ));
        tokio::time::sleep(Duration::from_millis(70)).await;
        shutdown.cancel();
        task.await.unwrap().unwrap();
        store.stop().await;
        assert_eq!(maximum.load(Ordering::SeqCst), 1);
    }
}
