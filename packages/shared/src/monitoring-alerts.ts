export type MonitoringAlertSeverity = "warning" | "critical";
export type MonitoringAlertTransform = "value" | "rate";
export type MonitoringAlertAggregation = "last" | "avg" | "min" | "max";
export type MonitoringAlertComparator = ">" | ">=" | "<" | "<=";
export type MonitoringAlertNoDataPolicy = "ignore" | "firing";
export type MonitoringAlertInstanceState = "normal" | "pending" | "firing" | "recovering" | "resolved";

export interface MonitoringAlertRuleInput {
  name: string;
  enabled: boolean;
  metric: string;
  selector: Record<string, string>;
  transform: MonitoringAlertTransform;
  aggregation: MonitoringAlertAggregation;
  windowSeconds: 60 | 300 | 900 | 1800 | 3600;
  comparator: MonitoringAlertComparator;
  triggerThreshold: number;
  recoveryThreshold: number;
  triggerDurationSeconds: number;
  recoveryDurationSeconds: number;
  severity: MonitoringAlertSeverity;
  noDataPolicy: MonitoringAlertNoDataPolicy;
  escalationPolicyId: string | null;
}

export interface MonitoringAlertRule extends MonitoringAlertRuleInput {
  id: string;
  builtin: boolean;
  evaluationError: string | null;
  lastEvaluatedAt: string | null;
  revision: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MonitoringAlertIncident {
  id: string;
  source: "metric" | "health" | "system";
  ruleId: string | null;
  healthAlertId: string | null;
  seriesKey: string;
  labels: Record<string, string>;
  status: "firing" | "resolved";
  severity: MonitoringAlertSeverity;
  title: string;
  currentValue: number | null;
  firingAt: string;
  resolvedAt: string | null;
  closeReason: "recovered" | "rule_changed" | "disabled" | "deleted" | "health_resolved" | null;
  acknowledgedAt: string | null;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
  occurrenceCount: number;
}

export type MonitoringAlertIncidentEventType =
  | "fired"
  | "acknowledged"
  | "read"
  | "recovered"
  | "rule_changed"
  | "disabled"
  | "deleted"
  | "silenced"
  | "unsilenced"
  | "delivery_succeeded"
  | "delivery_failed";

export interface MonitoringAlertIncidentEvent {
  id: number;
  incidentId: string;
  type: MonitoringAlertIncidentEventType;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface MonitoringAlertIncidentDetail {
  incident: MonitoringAlertIncident;
  events: MonitoringAlertIncidentEvent[];
  ruleSnapshot: Record<string, unknown>;
  policySnapshot: Record<string, unknown> | null;
  deliveries: MonitoringAlertDelivery[];
}

export interface MonitoringAlertSilenceInput {
  ruleId: string;
  seriesKey: string | null;
  startsAt: string;
  endsAt: string;
  reason: string;
}

export interface MonitoringAlertSilence extends MonitoringAlertSilenceInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface MonitoringAlertContactInput {
  name: string;
  email: string;
  enabled: boolean;
}

export interface MonitoringAlertContact extends MonitoringAlertContactInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface MonitoringAlertContactGroupInput {
  name: string;
  contactIds: string[];
}

export interface MonitoringAlertContactGroup extends MonitoringAlertContactGroupInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface MonitoringOncallOverride {
  id: string;
  scheduleId: string;
  contactId: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface MonitoringOncallScheduleInput {
  name: string;
  timezone: string;
  handoffWeekday: number;
  handoffTime: string;
  anchorDate: string;
  contactIds: string[];
}

export interface MonitoringOncallSchedule extends MonitoringOncallScheduleInput {
  id: string;
  revision: number;
  overrides: MonitoringOncallOverride[];
  createdAt: string;
  updatedAt: string;
}

export type MonitoringEscalationTarget = {
  type: "contact" | "group" | "oncall";
  id: string;
};

export interface MonitoringEscalationStage {
  delaySeconds: number;
  repeatIntervalSeconds: number | null;
  repeatCount: number;
  targets: MonitoringEscalationTarget[];
}

export interface MonitoringEscalationPolicyInput {
  name: string;
  enabled: boolean;
  stages: MonitoringEscalationStage[];
}

export interface MonitoringEscalationPolicy extends MonitoringEscalationPolicyInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type MonitoringSmtpSecurity = "none" | "starttls" | "tls";

export interface MonitoringSmtpSettingsInput {
  enabled: boolean;
  host: string;
  port: number;
  security: MonitoringSmtpSecurity;
  username: string;
  password?: string;
  from: string;
}

export interface MonitoringSmtpSettings extends Omit<MonitoringSmtpSettingsInput, "password"> {
  credentialConfigured: boolean;
  revision: number;
  updatedAt: string;
}

export interface MonitoringHealthRouting {
  warningPolicyId: string | null;
  criticalPolicyId: string | null;
  revision: number;
  updatedAt: string;
}

export interface MonitoringAlertDelivery {
  id: string;
  incidentId: string | null;
  kind: "firing" | "reminder" | "resolved" | "test";
  status: "pending" | "sending" | "retrying" | "succeeded" | "failed" | "cancelled";
  attemptCount: number;
  dueAt: string;
  sentAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MonitoringAlertSummary {
  unreadCount: number;
  firingCount: number;
  alerterStatus: "starting" | "ready" | "degraded" | "unavailable";
  lastEvaluationAt: string | null;
  pendingDeliveries: number;
}
