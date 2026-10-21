use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use nix::sys::statvfs::statvfs;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::process::Command;

use crate::domain::config::{MonitorConfig, NasRoot};
use crate::domain::metric::{Collection, CollectorState, MetricSample};
use crate::error::MonitorError;
use crate::ports::Collector;

const SECTOR_BYTES: f64 = 512.0;
const SYSTEMCTL_TIMEOUT: Duration = Duration::from_secs(5);

pub const MONITORED_SYSTEMD_UNITS: &[&str] = &[
    "zos-api.service",
    "zos-monitor.service",
    "zos-alerter.service",
    "zos-worker@1.service",
    "zos-indexer.service",
    "zos-downloader.service",
    "zos-photostaff.service",
    "zos-hostd.service",
    "zos-termux.service",
    "zos-health.service",
    "zos-maintenance.service",
    "zos-backup-daily.service",
];

pub fn default_collectors(config: &MonitorConfig) -> Vec<Box<dyn Collector>> {
    vec![
        Box::new(HostCollector::new(config.monitoring.sampling.fast)),
        Box::new(FilesystemCollector::new(
            config.monitoring.sampling.standard,
            config.state_dir.clone(),
            config.nas_roots.clone(),
        )),
        Box::new(SystemdCollector::new(config.monitoring.sampling.standard)),
        Box::new(ZosCollector::new(
            config.monitoring.sampling.standard,
            config.database_path.clone(),
        )),
        Box::new(TemperatureCollector::new(
            config.monitoring.sampling.temperature,
            PathBuf::from("/sys/class/thermal"),
        )),
    ]
}

pub struct HostCollector {
    interval: Duration,
    previous_cpu: Option<Cpu>,
}

impl HostCollector {
    pub fn new(interval: Duration) -> Self {
        Self {
            interval,
            previous_cpu: None,
        }
    }
}

#[async_trait]
impl Collector for HostCollector {
    fn id(&self) -> &'static str {
        "host"
    }

    fn interval(&self) -> Duration {
        self.interval
    }

    async fn collect(&mut self, timestamp_ms: i64) -> Result<Collection, MonitorError> {
        let (stat, load, memory, disks, network) = tokio::try_join!(
            tokio::fs::read_to_string("/proc/stat"),
            tokio::fs::read_to_string("/proc/loadavg"),
            tokio::fs::read_to_string("/proc/meminfo"),
            tokio::fs::read_to_string("/proc/diskstats"),
            tokio::fs::read_to_string("/proc/net/dev")
        )?;
        let mut samples = parse_load(&load, timestamp_ms)?;
        samples.extend(parse_memory(&memory, timestamp_ms)?);
        samples.extend(parse_disks(&disks, timestamp_ms));
        samples.extend(parse_network(&network, timestamp_ms));
        let current = parse_cpu(&stat)?;
        if let Some(previous) = self.previous_cpu {
            let total_delta = current.total - previous.total;
            let idle_delta = current.idle - previous.idle;
            if total_delta > 0.0 && idle_delta >= 0.0 {
                samples.push(MetricSample::new(
                    "zos_host_cpu_usage_ratio",
                    timestamp_ms,
                    (1.0 - idle_delta / total_delta).clamp(0.0, 1.0),
                ));
            }
        }
        self.previous_cpu = Some(current);
        Ok(Collection::ready(samples))
    }
}

pub struct FilesystemCollector {
    interval: Duration,
    state_dir: PathBuf,
    roots: Vec<NasRoot>,
}

impl FilesystemCollector {
    pub fn new(interval: Duration, state_dir: PathBuf, roots: Vec<NasRoot>) -> Self {
        Self {
            interval,
            state_dir,
            roots,
        }
    }
}

#[async_trait]
impl Collector for FilesystemCollector {
    fn id(&self) -> &'static str {
        "filesystem"
    }

    fn interval(&self) -> Duration {
        self.interval
    }

    async fn collect(&mut self, timestamp_ms: i64) -> Result<Collection, MonitorError> {
        let mut targets = vec![("state".to_owned(), self.state_dir.clone())];
        targets.extend(
            self.roots
                .iter()
                .map(|root| (format!("nas:{}", root.id), root.path.clone())),
        );
        let samples = tokio::task::spawn_blocking(move || {
            let mut samples = Vec::new();
            for (label, path) in &targets {
                let Ok(stats) = statvfs(path) else {
                    continue;
                };
                let block_size = stats.fragment_size() as f64;
                let size = stats.blocks() as f64 * block_size;
                let available = stats.blocks_available() as f64 * block_size;
                samples.push(
                    MetricSample::new("zos_host_filesystem_size_bytes", timestamp_ms, size)
                        .with_label("filesystem", label),
                );
                samples.push(
                    MetricSample::new(
                        "zos_host_filesystem_available_bytes",
                        timestamp_ms,
                        available,
                    )
                    .with_label("filesystem", label),
                );
                if size > 0.0 {
                    samples.push(
                        MetricSample::new(
                            "zos_host_filesystem_used_ratio",
                            timestamp_ms,
                            ((size - available) / size).clamp(0.0, 1.0),
                        )
                        .with_label("filesystem", label),
                    );
                }
            }
            samples
        })
        .await
        .map_err(|error| MonitorError::Collector(error.to_string()))?;
        if samples.is_empty() {
            return Err(MonitorError::Collector(
                "No configured filesystem could be sampled".to_owned(),
            ));
        }
        Ok(Collection::ready(samples))
    }
}

pub struct TemperatureCollector {
    interval: Duration,
    root: PathBuf,
}

impl TemperatureCollector {
    pub fn new(interval: Duration, root: PathBuf) -> Self {
        Self { interval, root }
    }
}

#[async_trait]
impl Collector for TemperatureCollector {
    fn id(&self) -> &'static str {
        "temperature"
    }

    fn interval(&self) -> Duration {
        self.interval
    }

    async fn collect(&mut self, timestamp_ms: i64) -> Result<Collection, MonitorError> {
        let mut directory = match tokio::fs::read_dir(&self.root).await {
            Ok(directory) => directory,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                ) =>
            {
                return Ok(Collection {
                    samples: Vec::new(),
                    state: CollectorState::Unsupported,
                });
            }
            Err(error) => return Err(error.into()),
        };
        let mut samples = Vec::new();
        while let Some(entry) = directory.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(index) = name.strip_prefix("thermal_zone") else {
                continue;
            };
            if index.is_empty() || !index.chars().all(|value| value.is_ascii_digit()) {
                continue;
            }
            let base = entry.path();
            let Ok(sensor_type) = tokio::fs::read_to_string(base.join("type")).await else {
                continue;
            };
            let Ok(raw) = tokio::fs::read_to_string(base.join("temp")).await else {
                continue;
            };
            let Ok(mut value) = raw.trim().parse::<f64>() else {
                continue;
            };
            if value.abs() >= 1000.0 {
                value /= 1000.0;
            }
            let sensor = format!("{}:{index}", sanitize_label(sensor_type.trim()));
            samples.push(
                MetricSample::new("zos_host_temperature_celsius", timestamp_ms, value)
                    .with_label("sensor", sensor),
            );
        }
        let state = if samples.is_empty() {
            CollectorState::Unsupported
        } else {
            CollectorState::Ready
        };
        Ok(Collection { samples, state })
    }
}

pub struct SystemdCollector {
    interval: Duration,
}

impl SystemdCollector {
    pub fn new(interval: Duration) -> Self {
        Self { interval }
    }
}

#[async_trait]
impl Collector for SystemdCollector {
    fn id(&self) -> &'static str {
        "systemd"
    }

    fn interval(&self) -> Duration {
        self.interval
    }

    async fn collect(&mut self, timestamp_ms: i64) -> Result<Collection, MonitorError> {
        let mut samples = Vec::with_capacity(MONITORED_SYSTEMD_UNITS.len());
        for unit in MONITORED_SYSTEMD_UNITS {
            let mut command = Command::new("systemctl");
            command
                .args(["show", "--property=ActiveState", "--value", unit])
                .kill_on_drop(true);
            let output = command_output_with_timeout(
                &mut command,
                SYSTEMCTL_TIMEOUT,
                format!("systemctl timed out for {unit}"),
            )
            .await?;
            if !output.status.success() {
                return Err(MonitorError::Collector(format!(
                    "systemctl failed for {unit}"
                )));
            }
            let active = String::from_utf8_lossy(&output.stdout).trim() == "active";
            samples.push(
                MetricSample::new("zos_systemd_unit_active", timestamp_ms, f64::from(active))
                    .with_label("unit", *unit),
            );
        }
        Ok(Collection::ready(samples))
    }
}

async fn command_output_with_timeout(
    command: &mut Command,
    timeout: Duration,
    timeout_error: String,
) -> Result<std::process::Output, MonitorError> {
    tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| MonitorError::Collector(timeout_error))?
        .map_err(MonitorError::from)
}

pub struct ZosCollector {
    interval: Duration,
    database_path: PathBuf,
}

impl ZosCollector {
    pub fn new(interval: Duration, database_path: PathBuf) -> Self {
        Self {
            interval,
            database_path,
        }
    }
}

#[async_trait]
impl Collector for ZosCollector {
    fn id(&self) -> &'static str {
        "zos"
    }

    fn interval(&self) -> Duration {
        self.interval
    }

    async fn collect(&mut self, timestamp_ms: i64) -> Result<Collection, MonitorError> {
        let path = self.database_path.clone();
        let samples = tokio::task::spawn_blocking(move || collect_zos(&path, timestamp_ms))
            .await
            .map_err(|error| MonitorError::Collector(error.to_string()))??;
        Ok(Collection::ready(samples))
    }
}

fn collect_zos(path: &Path, timestamp_ms: i64) -> Result<Vec<MetricSample>, MonitorError> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "query_only", "ON")?;
    let mut samples = Vec::new();
    for (queue, sql) in [
        (
            "indexer",
            "SELECT COUNT(*) FROM index_queue WHERE status IN ('queued', 'retrying')",
        ),
        (
            "downloads",
            "SELECT COUNT(*) FROM download_tasks WHERE status = 'queued'",
        ),
        (
            "photostaff",
            "SELECT COUNT(*) FROM photostaff_jobs WHERE status IN ('queued', 'retrying')",
        ),
        ("agent", "SELECT COUNT(*) FROM jobs WHERE status = 'queued'"),
    ] {
        let count: i64 = connection.query_row(sql, [], |row| row.get(0))?;
        samples.push(
            MetricSample::new("zos_queue_depth", timestamp_ms, count as f64)
                .with_label("queue", queue),
        );
    }
    for (worker, sql) in [
        ("indexer", "SELECT MAX(heartbeat_at) FROM indexer_workers"),
        (
            "downloader",
            "SELECT MAX(heartbeat_at) FROM download_workers",
        ),
        (
            "photostaff",
            "SELECT MAX(heartbeat_at) FROM photostaff_workers",
        ),
    ] {
        let heartbeat: Option<String> = connection.query_row(sql, [], |row| row.get(0))?;
        if let Some(heartbeat_ms) = heartbeat.as_deref().and_then(parse_iso_ms) {
            samples.push(
                MetricSample::new(
                    "zos_worker_heartbeat_age_seconds",
                    timestamp_ms,
                    (timestamp_ms - heartbeat_ms).max(0) as f64 / 1000.0,
                )
                .with_label("worker", worker),
            );
        }
    }
    let oldest_latest_index: Option<String> = connection.query_row(
        "SELECT MIN(finished_at) FROM (\
           SELECT root_id, MAX(finished_at) AS finished_at FROM (\
             SELECT root_id, finished_at FROM index_runs WHERE kind='full' AND status='completed' \
             UNION ALL SELECT root_id, finished_at FROM index_run_history WHERE kind='full' AND status='completed'\
           ) GROUP BY root_id\
         )",
        [],
        |row| row.get(0),
    )?;
    if let Some(finished_ms) = oldest_latest_index.as_deref().and_then(parse_iso_ms) {
        samples.push(MetricSample::new(
            "zos_index_freshness_seconds",
            timestamp_ms,
            (timestamp_ms - finished_ms).max(0) as f64 / 1000.0,
        ));
    }
    let backup: Option<String> = connection.query_row(
        "SELECT finished_at FROM backup_runs WHERE kind IN ('daily','weekly') AND status='completed' AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1",
        [],
        |row| row.get(0),
    ).optional()?.flatten();
    if let Some(finished_ms) = backup.as_deref().and_then(parse_iso_ms) {
        samples.push(
            MetricSample::new(
                "zos_last_success_timestamp_seconds",
                timestamp_ms,
                finished_ms as f64 / 1000.0,
            )
            .with_label("task", "backup"),
        );
    }
    for task in ["health", "maintenance"] {
        let finished: Option<String> = connection
            .query_row(
                "SELECT finished_at FROM ops_runs WHERE task=? AND status='completed' AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1",
                [task],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        if let Some(finished_ms) = finished.as_deref().and_then(parse_iso_ms) {
            samples.push(
                MetricSample::new(
                    "zos_last_success_timestamp_seconds",
                    timestamp_ms,
                    finished_ms as f64 / 1000.0,
                )
                .with_label("task", task),
            );
        }
    }
    for severity in ["warning", "critical"] {
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM health_alerts WHERE status='active' AND severity=?",
            [severity],
            |row| row.get(0),
        )?;
        samples.push(
            MetricSample::new("zos_health_problem_count", timestamp_ms, count as f64)
                .with_label("severity", severity),
        );
    }
    Ok(samples)
}

#[derive(Clone, Copy)]
struct Cpu {
    idle: f64,
    total: f64,
}

fn parse_cpu(value: &str) -> Result<Cpu, MonitorError> {
    let line = value
        .lines()
        .find(|line| line.starts_with("cpu "))
        .ok_or_else(|| MonitorError::Collector("invalid /proc/stat".to_owned()))?;
    let fields: Vec<f64> = line
        .split_whitespace()
        .skip(1)
        .map(str::parse)
        .collect::<Result<_, _>>()
        .map_err(|_| MonitorError::Collector("invalid /proc/stat".to_owned()))?;
    if fields.len() < 5 {
        return Err(MonitorError::Collector("invalid /proc/stat".to_owned()));
    }
    Ok(Cpu {
        idle: fields[3] + fields[4],
        total: fields.iter().sum(),
    })
}

fn parse_load(value: &str, timestamp_ms: i64) -> Result<Vec<MetricSample>, MonitorError> {
    let values: Vec<f64> = value
        .split_whitespace()
        .take(3)
        .map(str::parse)
        .collect::<Result<_, _>>()
        .map_err(|_| MonitorError::Collector("invalid /proc/loadavg".to_owned()))?;
    if values.len() != 3 {
        return Err(MonitorError::Collector("invalid /proc/loadavg".to_owned()));
    }
    Ok(["zos_host_load1", "zos_host_load5", "zos_host_load15"]
        .into_iter()
        .zip(values)
        .map(|(metric, value)| MetricSample::new(metric, timestamp_ms, value))
        .collect())
}

fn parse_memory(value: &str, timestamp_ms: i64) -> Result<Vec<MetricSample>, MonitorError> {
    let values: HashMap<_, _> = value
        .lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once(':')?;
            let value = rest.split_whitespace().next()?.parse::<f64>().ok()?;
            Some((name, value * 1024.0))
        })
        .collect();
    let total = *values
        .get("MemTotal")
        .ok_or_else(|| MonitorError::Collector("missing MemTotal".to_owned()))?;
    let available = *values
        .get("MemAvailable")
        .ok_or_else(|| MonitorError::Collector("missing MemAvailable".to_owned()))?;
    let used = (total - available).max(0.0);
    let swap_total = *values.get("SwapTotal").unwrap_or(&0.0);
    let swap_free = *values.get("SwapFree").unwrap_or(&0.0);
    Ok(vec![
        MetricSample::new("zos_host_memory_total_bytes", timestamp_ms, total),
        MetricSample::new("zos_host_memory_available_bytes", timestamp_ms, available),
        MetricSample::new("zos_host_memory_used_bytes", timestamp_ms, used),
        MetricSample::new(
            "zos_host_memory_used_ratio",
            timestamp_ms,
            if total > 0.0 { used / total } else { 0.0 },
        ),
        MetricSample::new("zos_host_swap_total_bytes", timestamp_ms, swap_total),
        MetricSample::new(
            "zos_host_swap_used_bytes",
            timestamp_ms,
            (swap_total - swap_free).max(0.0),
        ),
    ])
}

fn parse_disks(value: &str, timestamp_ms: i64) -> Vec<MetricSample> {
    value
        .lines()
        .flat_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            let device = *fields.get(2).unwrap_or(&"");
            if !valid_block_device(device) {
                return Vec::new();
            }
            let Some(read) = fields.get(5).and_then(|value| value.parse::<f64>().ok()) else {
                return Vec::new();
            };
            let Some(written) = fields.get(9).and_then(|value| value.parse::<f64>().ok()) else {
                return Vec::new();
            };
            vec![
                MetricSample::new(
                    "zos_host_disk_read_bytes_total",
                    timestamp_ms,
                    read * SECTOR_BYTES,
                )
                .with_label("device", device),
                MetricSample::new(
                    "zos_host_disk_written_bytes_total",
                    timestamp_ms,
                    written * SECTOR_BYTES,
                )
                .with_label("device", device),
            ]
        })
        .collect()
}

fn parse_network(value: &str, timestamp_ms: i64) -> Vec<MetricSample> {
    value
        .lines()
        .flat_map(|line| {
            let Some((name, values)) = line.split_once(':') else {
                return Vec::new();
            };
            let name = name.trim();
            if name == "lo" || !valid_interface(name) || transient_interface(name) {
                return Vec::new();
            }
            let fields: Vec<_> = values.split_whitespace().collect();
            let Some(received) = fields.first().and_then(|value| value.parse::<f64>().ok()) else {
                return Vec::new();
            };
            let Some(transmitted) = fields.get(8).and_then(|value| value.parse::<f64>().ok())
            else {
                return Vec::new();
            };
            vec![
                MetricSample::new(
                    "zos_host_network_receive_bytes_total",
                    timestamp_ms,
                    received,
                )
                .with_label("interface", name),
                MetricSample::new(
                    "zos_host_network_transmit_bytes_total",
                    timestamp_ms,
                    transmitted,
                )
                .with_label("interface", name),
            ]
        })
        .collect()
}

fn valid_block_device(value: &str) -> bool {
    value.starts_with("nvme")
        || value.starts_with("mmcblk")
        || value.starts_with("dm-")
        || value.starts_with("md")
        || ["sd", "vd", "xvd"].iter().any(|prefix| {
            value.strip_prefix(prefix).is_some_and(|suffix| {
                !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_lowercase())
            })
        })
}

fn valid_interface(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_.-".contains(character))
}

fn transient_interface(value: &str) -> bool {
    [
        "veth", "cali", "flannel", "cni", "docker", "virbr", "vnet", "tap", "tun",
    ]
    .iter()
    .any(|prefix| value.starts_with(prefix))
        || value.strip_prefix("br-").is_some_and(|suffix| {
            suffix.len() == 12 && suffix.chars().all(|value| value.is_ascii_hexdigit())
        })
}

fn sanitize_label(value: &str) -> String {
    let normalized: String = value
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || "_.-".contains(character) {
                character
            } else {
                '_'
            }
        })
        .collect();
    normalized.trim_matches('_').chars().take(96).collect()
}

fn parse_iso_ms(value: &str) -> Option<i64> {
    OffsetDateTime::parse(value, &Rfc3339)
        .ok()
        .and_then(|value| i64::try_from(value.unix_timestamp_nanos() / 1_000_000).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proc_data_and_filters_transient_devices() {
        let memory = parse_memory(
            "MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 200 kB\nSwapFree: 50 kB\n",
            1,
        )
        .unwrap();
        assert!(memory.iter().any(|sample| {
            sample.metric == "zos_host_memory_used_ratio"
                && (sample.value - 0.6).abs() < f64::EPSILON
        }));
        let disks = parse_disks(
            "8 0 sda 1 0 2 0 3 0 4 0 0 0 0\n7 0 loop0 1 0 9 0 1 0 9 0 0 0 0",
            1,
        );
        assert_eq!(disks.len(), 2);
        assert_eq!(disks[0].value, 1024.0);
        let network = parse_network(
            "eth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\nveth1: 1 0 0 0 0 0 0 0 2 0 0 0 0 0 0 0\n",
            1,
        );
        assert_eq!(network.len(), 2);
        assert_eq!(network[1].value, 200.0);
    }

    #[tokio::test]
    async fn cpu_waits_for_a_baseline() {
        let first = parse_cpu("cpu 100 0 100 800 0 0 0 0\n").unwrap();
        let second = parse_cpu("cpu 150 0 150 900 0 0 0 0\n").unwrap();
        assert_eq!(first.total, 1000.0);
        assert_eq!(
            1.0 - (second.idle - first.idle) / (second.total - first.total),
            0.5
        );
    }

    #[tokio::test]
    async fn missing_temperature_root_is_unsupported() {
        let mut collector = TemperatureCollector::new(
            Duration::from_secs(60),
            PathBuf::from("/definitely/missing/thermal"),
        );
        let result = collector.collect(1).await.unwrap();
        assert_eq!(result.state, CollectorState::Unsupported);
    }

    #[tokio::test]
    async fn command_timeout_stops_a_hung_systemd_query() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 1"]).kill_on_drop(true);

        let error = command_output_with_timeout(
            &mut command,
            Duration::from_millis(10),
            "systemctl timed out for test.service".to_owned(),
        )
        .await
        .unwrap_err();

        assert_eq!(
            error.to_string(),
            "collector error: systemctl timed out for test.service"
        );
    }
}
