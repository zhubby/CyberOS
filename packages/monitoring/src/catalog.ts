import type { MonitoringMetricDefinition } from "@zos/shared";
import catalog from "../contracts/metrics-catalog.json" with { type: "json" };

export const MONITORING_CATALOG: readonly MonitoringMetricDefinition[] = Object.freeze(
  catalog.map((definition) => Object.freeze({
    ...definition,
    kind: parseKind(definition.kind),
    cadence: parseCadence(definition.cadence),
    labelKeys: Object.freeze([...definition.labelKeys])
  }))
);

export type MonitoringMetricName = string;

const catalogByName = new Map<string, MonitoringMetricDefinition>(
  MONITORING_CATALOG.map((definition) => [definition.name, definition])
);

export function getMetricDefinition(name: string): MonitoringMetricDefinition | undefined {
  return catalogByName.get(name);
}

function parseKind(value: string): MonitoringMetricDefinition["kind"] {
  if (value === "gauge" || value === "counter") return value;
  throw new Error(`Invalid monitoring metric kind: ${value}`);
}

function parseCadence(value: string): NonNullable<MonitoringMetricDefinition["cadence"]> {
  if (value === "fast" || value === "standard" || value === "temperature") return value;
  throw new Error(`Invalid monitoring metric cadence: ${value}`);
}
