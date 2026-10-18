import type { MonitoringMetricDefinition } from "@zos/shared";

export const MONITORING_CATALOG = [
  metric("zos_host_cpu_usage_ratio", "Host CPU utilization", "gauge", "ratio"),
  metric("zos_host_load1", "One-minute host load average", "gauge", "load"),
  metric("zos_host_load5", "Five-minute host load average", "gauge", "load"),
  metric("zos_host_load15", "Fifteen-minute host load average", "gauge", "load"),
  metric("zos_host_memory_total_bytes", "Host physical memory", "gauge", "bytes"),
  metric("zos_host_memory_available_bytes", "Host available memory", "gauge", "bytes"),
  metric("zos_host_memory_used_bytes", "Host used memory", "gauge", "bytes"),
  metric("zos_host_swap_total_bytes", "Host swap capacity", "gauge", "bytes"),
  metric("zos_host_swap_used_bytes", "Host used swap", "gauge", "bytes"),
  metric("zos_host_disk_read_bytes_total", "Block device bytes read", "counter", "bytes", ["device"]),
  metric("zos_host_disk_written_bytes_total", "Block device bytes written", "counter", "bytes", ["device"]),
  metric("zos_host_network_receive_bytes_total", "Network bytes received", "counter", "bytes", ["interface"]),
  metric("zos_host_network_transmit_bytes_total", "Network bytes transmitted", "counter", "bytes", ["interface"]),
  metric("zos_host_filesystem_size_bytes", "Filesystem capacity", "gauge", "bytes", ["filesystem"]),
  metric("zos_host_filesystem_available_bytes", "Filesystem available capacity", "gauge", "bytes", ["filesystem"]),
  metric("zos_host_temperature_celsius", "Thermal sensor temperature", "gauge", "celsius", ["sensor"]),
  metric("zos_systemd_unit_active", "Whether a managed systemd unit is active", "gauge", "state", ["unit"]),
  metric("zos_worker_heartbeat_age_seconds", "Age of the latest worker heartbeat", "gauge", "seconds", ["worker"]),
  metric("zos_queue_depth", "Pending work by fixed queue", "gauge", "items", ["queue"]),
  metric("zos_index_freshness_seconds", "Age of the stalest NAS index", "gauge", "seconds"),
  metric("zos_last_success_timestamp_seconds", "Latest successful scheduled task", "gauge", "seconds", ["task"]),
  metric("zos_health_problem_count", "Active health issues by severity", "gauge", "items", ["severity"]),
  metric("zos_monitor_collector_up", "Whether a collector last completed successfully", "gauge", "state", ["collector"]),
  metric("zos_monitor_collector_duration_seconds", "Collector duration", "gauge", "seconds", ["collector"]),
  metric("zos_monitor_collector_consecutive_failures", "Collector consecutive failures", "gauge", "items", ["collector"]),
  metric("zos_monitor_last_sample_timestamp_seconds", "Latest successful monitor sample", "gauge", "seconds"),
  metric("zos_monitor_database_size_bytes", "Metrics database disk use", "gauge", "bytes")
] as const satisfies readonly MonitoringMetricDefinition[];

export type MonitoringMetricName = (typeof MONITORING_CATALOG)[number]["name"];

const catalogByName = new Map<string, MonitoringMetricDefinition>(
  MONITORING_CATALOG.map((definition) => [definition.name, definition])
);

export function getMetricDefinition(name: string): MonitoringMetricDefinition | undefined {
  return catalogByName.get(name);
}

function metric(
  name: string,
  description: string,
  kind: MonitoringMetricDefinition["kind"],
  unit: string,
  labelKeys: string[] = []
): MonitoringMetricDefinition {
  return { name, description, kind, unit, labelKeys };
}
