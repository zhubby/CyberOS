export type MonitoringState = "disabled" | "starting" | "ready" | "degraded" | "unavailable";
export type MonitoringMetricKind = "gauge" | "counter";
export type MonitoringTransform = "value" | "rate";
export type MonitoringResolution = "raw" | "1m" | "1h";
export type MonitoringCollectorState = "ready" | "error" | "unsupported" | "disabled";

export interface MonitoringMetricDefinition {
  name: string;
  description: string;
  kind: MonitoringMetricKind;
  unit: string;
  labelKeys: readonly string[];
  cadence?: "fast" | "standard" | "temperature";
}

export interface MonitoringSeriesDescriptor {
  id: number;
  metric: string;
  labels: Record<string, string>;
}

export interface MonitoringCatalogResponse {
  metrics: MonitoringMetricDefinition[];
  series: MonitoringSeriesDescriptor[];
}

export interface MonitoringCollectorStatus {
  collector: string;
  state: MonitoringCollectorState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  durationMs: number | null;
  consecutiveFailures: number;
  error: string | null;
}

export interface MonitoringLatestValue {
  metric: string;
  labels: Record<string, string>;
  value: number;
  sampledAt: string;
}

export interface MonitoringOverviewResponse {
  status: MonitoringState;
  enabled: boolean;
  sampledAt: string;
  latest: MonitoringLatestValue[];
  collectors: MonitoringCollectorStatus[];
  retention: {
    rawMs: number;
    minuteMs: number;
    hourMs: number;
    maxDatabaseBytes: number;
    databaseBytes: number;
    writesPaused: boolean;
  };
  alerts?: MonitoringAlertSummary;
}

export interface MonitoringQuerySelector {
  metric: string;
  labels?: Record<string, string>;
  transform?: MonitoringTransform;
}

export interface MonitoringQueryRequest {
  start: string;
  end: string;
  maxPoints?: number;
  selectors: MonitoringQuerySelector[];
}

export interface MonitoringQueryPoint {
  timestamp: string;
  value: number | null;
}

export interface MonitoringQuerySeries {
  metric: string;
  labels: Record<string, string>;
  transform: MonitoringTransform;
  resolution: MonitoringResolution;
  stepMs: number;
  points: MonitoringQueryPoint[];
}

export interface MonitoringQueryResponse {
  start: string;
  end: string;
  series: MonitoringQuerySeries[];
}

export interface MonitoringHealthStatus {
  status: MonitoringState;
  lastSampleAt: string | null;
}
import type { MonitoringAlertSummary } from "./monitoring-alerts.js";
