// Test-only compatibility helpers. Production code must import from the package root.
export {
  MAX_MONITORING_SERIES,
  MAX_MONITORING_SERIES_PER_METRIC,
  MetricsWriter,
  type CollectorStatusUpdate,
  type MetricSample,
  type RetentionResult
} from "./store.js";
export { runMonitoringMigrations } from "./schema.js";
