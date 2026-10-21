import type { FastifyInstance, FastifyReply } from "fastify";
import {
  MonitoringAlertDeliveryCapacityError,
  MonitoringAlertReferenceConflictError,
  MonitoringAlertRevisionConflictError,
  acknowledgeMonitoringAlertIncident,
  createMonitoringAlertContact,
  createMonitoringAlertRule,
  createMonitoringAlertSilence,
  createMonitoringOncallOverride,
  deleteMonitoringAlertContact,
  deleteMonitoringAlertGroup,
  deleteMonitoringAlertRule,
  deleteMonitoringAlertSilence,
  deleteMonitoringEscalationPolicy,
  deleteMonitoringOncallOverride,
  deleteMonitoringOncallSchedule,
  enqueueMonitoringTestEmail,
  getMonitoringAlertDelivery,
  getMonitoringAlertIncident,
  getMonitoringAlertSummary,
  getMonitoringHealthRouting,
  getMonitoringSmtpSettings,
  listMonitoringAlertContacts,
  listMonitoringAlertGroups,
  listMonitoringAlertIncidentEvents,
  listMonitoringAlertIncidents,
  listMonitoringAlertRules,
  listMonitoringAlertSilences,
  listMonitoringEscalationPolicies,
  listMonitoringOncallSchedules,
  markAllMonitoringAlertIncidentsRead,
  markMonitoringAlertIncidentRead,
  saveMonitoringAlertGroup,
  saveMonitoringEscalationPolicy,
  saveMonitoringHealthRouting,
  saveMonitoringOncallSchedule,
  saveMonitoringSmtpSettings,
  updateMonitoringAlertContact,
  updateMonitoringAlertRule
} from "@zos/db";
import { getMetricDefinition } from "@zos/monitoring";
import type {
  MonitoringAlertContactInput,
  MonitoringAlertContactGroupInput,
  MonitoringAlertRuleInput,
  MonitoringAlertSilenceInput,
  MonitoringEscalationPolicyInput,
  MonitoringHealthRouting,
  MonitoringOncallOverride,
  MonitoringOncallScheduleInput,
  MonitoringSmtpSettingsInput
} from "@zos/shared";
import type { ApiRouteContext } from "../context.js";

export function registerMonitoringAlertRoutes(server: FastifyInstance, { db }: ApiRouteContext): void {
  server.get("/api/monitoring/alerts/summary", async () => getMonitoringAlertSummary(db));
  server.get("/api/monitoring/alerts/rules", async () => ({ rules: listMonitoringAlertRules(db) }));
  server.post<{ Body: unknown }>("/api/monitoring/alerts/rules", async (request, reply) => {
    const input = parseRule(request.body);
    if (!input) return badRequest(reply, "Invalid alert rule");
    if (!optionalReferenceExists(db, "monitoring_escalation_policies", input.escalationPolicyId)) {
      return badRequest(reply, "Escalation policy not found");
    }
    reply.status(201).send({ rule: createMonitoringAlertRule(db, input) });
  });
  server.patch<{ Params: { id: string }; Body: unknown }>(
    "/api/monitoring/alerts/rules/:id",
    async (request, reply) => withRevisionConflict(reply, () => {
      const body = object(request.body);
      const input = body ? parseRule(body.rule) : null;
      const expectedRevision = body ? positiveInteger(body.expectedRevision) : null;
      if (!input || expectedRevision === null) return badRequest(reply, "Invalid alert rule update");
      if (!optionalReferenceExists(db, "monitoring_escalation_policies", input.escalationPolicyId)) {
        return badRequest(reply, "Escalation policy not found");
      }
      const rule = updateMonitoringAlertRule(db, request.params.id, expectedRevision, input);
      return rule ? reply.send({ rule }) : notFound(reply, "Alert rule not found");
    })
  );
  server.delete<{ Params: { id: string }; Querystring: { expectedRevision?: string } }>(
    "/api/monitoring/alerts/rules/:id",
    async (request, reply) => withRevisionConflict(reply, () => {
      const revision = positiveInteger(request.query.expectedRevision);
      if (revision === null) return badRequest(reply, "expectedRevision is required");
      return deleteMonitoringAlertRule(db, request.params.id, revision)
        ? reply.status(204).send()
        : notFound(reply, "Alert rule not found or cannot be deleted");
    })
  );

  server.get<{ Querystring: { status?: string; limit?: string } }>(
    "/api/monitoring/alerts/incidents",
    async (request, reply) => {
      const status = request.query.status;
      if (status !== undefined && status !== "firing" && status !== "resolved") {
        return badRequest(reply, "Invalid incident status");
      }
      const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) return badRequest(reply, "Invalid incident limit");
      reply.send({
        incidents: listMonitoringAlertIncidents(db, status === undefined ? { limit } : { status, limit })
      });
    }
  );
  server.get<{ Params: { id: string } }>("/api/monitoring/alerts/incidents/:id", async (request, reply) => {
    const incident = getMonitoringAlertIncident(db, request.params.id);
    if (!incident) return notFound(reply, "Alert incident not found");
    reply.send({ incident, events: listMonitoringAlertIncidentEvents(db, incident.id) });
  });
  server.post<{ Params: { id: string } }>("/api/monitoring/alerts/incidents/:id/read", async (request, reply) => {
    const incident = markMonitoringAlertIncidentRead(db, request.params.id);
    return incident ? reply.send({ incident }) : notFound(reply, "Alert incident not found");
  });
  server.post("/api/monitoring/alerts/incidents/read-all", async () => ({
    updated: markAllMonitoringAlertIncidentsRead(db)
  }));
  server.post<{ Params: { id: string } }>(
    "/api/monitoring/alerts/incidents/:id/acknowledge",
    async (request, reply) => {
      const incident = acknowledgeMonitoringAlertIncident(db, request.params.id);
      return incident ? reply.send({ incident }) : notFound(reply, "Alert incident not found");
    }
  );

  server.get("/api/monitoring/alerts/silences", async () => ({ silences: listMonitoringAlertSilences(db) }));
  server.post<{ Body: unknown }>("/api/monitoring/alerts/silences", async (request, reply) => {
    const input = parseSilence(request.body);
    if (!input) return badRequest(reply, "Invalid alert silence");
    if (!referencesExist(db, "monitoring_alert_rules", [input.ruleId])) {
      return badRequest(reply, "Alert rule not found");
    }
    reply.status(201).send({ silence: createMonitoringAlertSilence(db, input) });
  });
  server.delete<{ Params: { id: string }; Querystring: { expectedRevision?: string } }>(
    "/api/monitoring/alerts/silences/:id",
    async (request, reply) => withDelete(reply, request.query.expectedRevision,
      (revision) => deleteMonitoringAlertSilence(db, request.params.id, revision), "Alert silence")
  );

  server.get("/api/monitoring/alerts/contacts", async () => ({ contacts: listMonitoringAlertContacts(db) }));
  server.post<{ Body: unknown }>("/api/monitoring/alerts/contacts", async (request, reply) => {
    const input = parseContact(request.body);
    if (!input) return badRequest(reply, "Invalid alert contact");
    reply.status(201).send({ contact: createMonitoringAlertContact(db, input) });
  });
  server.patch<{ Params: { id: string }; Body: unknown }>(
    "/api/monitoring/alerts/contacts/:id",
    async (request, reply) => withRevisionConflict(reply, () => {
      const body = object(request.body);
      const input = body ? parseContact(body.contact) : null;
      const revision = body ? positiveInteger(body.expectedRevision) : null;
      if (!input || revision === null) return badRequest(reply, "Invalid alert contact update");
      const contact = updateMonitoringAlertContact(db, request.params.id, revision, input);
      return contact ? reply.send({ contact }) : notFound(reply, "Alert contact not found");
    })
  );
  server.delete<{ Params: { id: string }; Querystring: { expectedRevision?: string } }>(
    "/api/monitoring/alerts/contacts/:id",
    async (request, reply) => withDelete(reply, request.query.expectedRevision,
      (revision) => deleteMonitoringAlertContact(db, request.params.id, revision), "Alert contact")
  );

  registerAggregateRoutes(server, { db } as ApiRouteContext);

  server.get("/api/monitoring/alerts/smtp", async () => ({ smtp: getMonitoringSmtpSettings(db) }));
  server.patch<{ Body: unknown }>("/api/monitoring/alerts/smtp", async (request, reply) =>
    withRevisionConflict(reply, () => {
      const body = object(request.body);
      const input = body ? parseSmtp(body.smtp) : null;
      const revision = body ? positiveInteger(body.expectedRevision) : null;
      if (!input || revision === null) return badRequest(reply, "Invalid SMTP settings");
      reply.send({ smtp: saveMonitoringSmtpSettings(db, revision, input) });
    }));
  server.post<{ Body: unknown }>("/api/monitoring/alerts/test-email", async (request, reply) => {
    const body = object(request.body);
    const recipient = body && email(body.recipient);
    if (!recipient) return badRequest(reply, "A valid recipient is required");
    try {
      const delivery = enqueueMonitoringTestEmail(db, recipient);
      reply.status(202).send({ deliveryId: delivery.id });
    } catch (error) {
      if (error instanceof MonitoringAlertDeliveryCapacityError) {
        return reply.status(503).send({ error: error.message });
      }
      throw error;
    }
  });
  server.get<{ Params: { id: string } }>("/api/monitoring/alerts/deliveries/:id", async (request, reply) => {
    const delivery = getMonitoringAlertDelivery(db, request.params.id);
    return delivery ? reply.send({ delivery }) : notFound(reply, "Alert delivery not found");
  });
  server.get("/api/monitoring/alerts/health-routing", async () => ({ routing: getMonitoringHealthRouting(db) }));
  server.patch<{ Body: unknown }>("/api/monitoring/alerts/health-routing", async (request, reply) =>
    withRevisionConflict(reply, () => {
      const body = object(request.body);
      const revision = body ? positiveInteger(body.expectedRevision) : null;
      const routing = body ? parseHealthRouting(body.routing) : null;
      if (revision === null || !routing) return badRequest(reply, "Invalid health alert routing");
      if (!optionalReferenceExists(db, "monitoring_escalation_policies", routing.warningPolicyId)
        || !optionalReferenceExists(db, "monitoring_escalation_policies", routing.criticalPolicyId)) {
        return badRequest(reply, "Escalation policy not found");
      }
      reply.send({ routing: saveMonitoringHealthRouting(db, revision, routing) });
    }));
}

function registerAggregateRoutes(server: FastifyInstance, { db }: ApiRouteContext): void {
  server.get("/api/monitoring/alerts/groups", async () => ({ groups: listMonitoringAlertGroups(db) }));
  server.post<{ Body: unknown }>("/api/monitoring/alerts/groups", async (request, reply) => {
    const input = parseGroup(request.body);
    if (!input) return badRequest(reply, "Invalid contact group");
    if (!referencesExist(db, "monitoring_alert_contacts", input.contactIds)) {
      return badRequest(reply, "Contact not found");
    }
    reply.status(201).send({ group: saveMonitoringAlertGroup(db, null, null, input) });
  });
  server.patch<{ Params: { id: string }; Body: unknown }>("/api/monitoring/alerts/groups/:id", async (request, reply) =>
    withRevisionConflict(reply, () => {
      const body = object(request.body);
      const input = body ? parseGroup(body.group) : null;
      const revision = body ? positiveInteger(body.expectedRevision) : null;
      if (!input || revision === null) return badRequest(reply, "Invalid contact group update");
      if (!referencesExist(db, "monitoring_alert_contacts", input.contactIds)) {
        return badRequest(reply, "Contact not found");
      }
      reply.send({ group: saveMonitoringAlertGroup(db, request.params.id, revision, input) });
    }));
  server.delete<{ Params: { id: string }; Querystring: { expectedRevision?: string } }>(
    "/api/monitoring/alerts/groups/:id",
    async (request, reply) => withDelete(reply, request.query.expectedRevision,
      (revision) => deleteMonitoringAlertGroup(db, request.params.id, revision), "Contact group")
  );

  server.get("/api/monitoring/alerts/schedules", async () => ({ schedules: listMonitoringOncallSchedules(db) }));
  server.post<{ Body: unknown }>("/api/monitoring/alerts/schedules", async (request, reply) => {
    const input = parseSchedule(request.body);
    if (!input) return badRequest(reply, "Invalid on-call schedule");
    if (!referencesExist(db, "monitoring_alert_contacts", input.contactIds)) {
      return badRequest(reply, "Contact not found");
    }
    reply.status(201).send({ schedule: saveMonitoringOncallSchedule(db, null, null, input) });
  });
  server.patch<{ Params: { id: string }; Body: unknown }>("/api/monitoring/alerts/schedules/:id", async (request, reply) =>
    withRevisionConflict(reply, () => {
      const body = object(request.body);
      const input = body ? parseSchedule(body.schedule) : null;
      const revision = body ? positiveInteger(body.expectedRevision) : null;
      if (!input || revision === null) return badRequest(reply, "Invalid on-call schedule update");
      if (!referencesExist(db, "monitoring_alert_contacts", input.contactIds)) {
        return badRequest(reply, "Contact not found");
      }
      reply.send({ schedule: saveMonitoringOncallSchedule(db, request.params.id, revision, input) });
    }));
  server.delete<{ Params: { id: string }; Querystring: { expectedRevision?: string } }>(
    "/api/monitoring/alerts/schedules/:id",
    async (request, reply) => withDelete(reply, request.query.expectedRevision,
      (revision) => deleteMonitoringOncallSchedule(db, request.params.id, revision), "On-call schedule")
  );
  server.post<{ Params: { id: string }; Body: unknown }>(
    "/api/monitoring/alerts/schedules/:id/overrides",
    async (request, reply) => {
      const override = parseOverride(request.body, request.params.id);
      if (!override) return badRequest(reply, "Invalid on-call override");
      if (!referencesExist(db, "monitoring_oncall_schedules", [override.scheduleId])
        || !referencesExist(db, "monitoring_alert_contacts", [override.contactId])) {
        return badRequest(reply, "On-call schedule or contact not found");
      }
      reply.status(201).send({ override: createMonitoringOncallOverride(db, override) });
    }
  );
  server.delete<{ Params: { id: string }; Querystring: { expectedRevision?: string } }>(
    "/api/monitoring/alerts/overrides/:id",
    async (request, reply) => withDelete(reply, request.query.expectedRevision,
      (revision) => deleteMonitoringOncallOverride(db, request.params.id, revision), "On-call override")
  );

  server.get("/api/monitoring/alerts/policies", async () => ({ policies: listMonitoringEscalationPolicies(db) }));
  server.post<{ Body: unknown }>("/api/monitoring/alerts/policies", async (request, reply) => {
    const input = parsePolicy(request.body);
    if (!input) return badRequest(reply, "Invalid escalation policy");
    if (!policyTargetsExist(db, input)) return badRequest(reply, "Escalation target not found");
    reply.status(201).send({ policy: saveMonitoringEscalationPolicy(db, null, null, input) });
  });
  server.patch<{ Params: { id: string }; Body: unknown }>("/api/monitoring/alerts/policies/:id", async (request, reply) =>
    withRevisionConflict(reply, () => {
      const body = object(request.body);
      const input = body ? parsePolicy(body.policy) : null;
      const revision = body ? positiveInteger(body.expectedRevision) : null;
      if (!input || revision === null) return badRequest(reply, "Invalid escalation policy update");
      if (!policyTargetsExist(db, input)) return badRequest(reply, "Escalation target not found");
      reply.send({ policy: saveMonitoringEscalationPolicy(db, request.params.id, revision, input) });
    }));
  server.delete<{ Params: { id: string }; Querystring: { expectedRevision?: string } }>(
    "/api/monitoring/alerts/policies/:id",
    async (request, reply) => withDelete(reply, request.query.expectedRevision,
      (revision) => deleteMonitoringEscalationPolicy(db, request.params.id, revision), "Escalation policy")
  );
}

function parseRule(value: unknown): MonitoringAlertRuleInput | null {
  const body = object(value);
  if (!body) return null;
  const metric = text(body.metric, 120);
  const definition = metric ? getMetricDefinition(metric) : undefined;
  const selector = stringRecord(body.selector);
  const transform = oneOf(body.transform, ["value", "rate"] as const);
  const aggregation = oneOf(body.aggregation, ["last", "avg", "min", "max"] as const);
  const windowSeconds = oneOf(body.windowSeconds, [60, 300, 900, 1800, 3600] as const);
  const comparator = oneOf(body.comparator, [">", ">=", "<", "<="] as const);
  const triggerThreshold = finite(body.triggerThreshold);
  const recoveryThreshold = finite(body.recoveryThreshold);
  const triggerDurationSeconds = boundedInteger(body.triggerDurationSeconds, 0, 86_400);
  const recoveryDurationSeconds = boundedInteger(body.recoveryDurationSeconds, 0, 86_400);
  const severity = oneOf(body.severity, ["warning", "critical"] as const);
  const noDataPolicy = oneOf(body.noDataPolicy, ["ignore", "firing"] as const);
  const name = text(body.name, 120);
  if (!metric || !definition || !selector || !transform || !aggregation || !windowSeconds || !comparator
    || triggerThreshold === null || recoveryThreshold === null || triggerDurationSeconds === null
    || recoveryDurationSeconds === null || !severity || !noDataPolicy || !name
    || typeof body.enabled !== "boolean") return null;
  if (definition.kind === "counter" && transform !== "rate") return null;
  if (Object.keys(selector).some((key) => !definition.labelKeys.includes(key))) return null;
  if (noDataPolicy === "firing" && definition.labelKeys.some((key) => selector[key] === undefined)) return null;
  if ((comparator === ">" || comparator === ">=") ? recoveryThreshold >= triggerThreshold : recoveryThreshold <= triggerThreshold) {
    return null;
  }
  return {
    name,
    enabled: body.enabled,
    metric,
    selector,
    transform,
    aggregation,
    windowSeconds,
    comparator,
    triggerThreshold,
    recoveryThreshold,
    triggerDurationSeconds,
    recoveryDurationSeconds,
    severity,
    noDataPolicy,
    escalationPolicyId: nullableId(body.escalationPolicyId)
  };
}

function parseSilence(value: unknown): MonitoringAlertSilenceInput | null {
  const body = object(value);
  const ruleId = body && text(body.ruleId, 128);
  const startsAt = body && timestamp(body.startsAt);
  const endsAt = body && timestamp(body.endsAt);
  const reason = body && text(body.reason, 240);
  if (!body || !ruleId || !startsAt || !endsAt || !reason || endsAt <= startsAt) return null;
  return { ruleId, seriesKey: nullableId(body.seriesKey), startsAt, endsAt, reason };
}

function parseContact(value: unknown): MonitoringAlertContactInput | null {
  const body = object(value);
  const name = body && text(body.name, 80);
  const address = body && email(body.email);
  if (!body || !name || !address || typeof body.enabled !== "boolean") return null;
  return { name, email: address, enabled: body.enabled };
}

function parseGroup(value: unknown): MonitoringAlertContactGroupInput | null {
  const body = object(value);
  const name = body && text(body.name, 80);
  const contactIds = body && stringArray(body.contactIds, 128);
  return name && contactIds ? { name, contactIds } : null;
}

function parseSchedule(value: unknown): MonitoringOncallScheduleInput | null {
  const body = object(value);
  const name = body && text(body.name, 80);
  const timezone = body && text(body.timezone, 80);
  const handoffWeekday = body && boundedInteger(body.handoffWeekday, 1, 7);
  const handoffTime = body && typeof body.handoffTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/u.test(body.handoffTime)
    ? body.handoffTime : null;
  const anchorDate = body && typeof body.anchorDate === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(body.anchorDate)
    ? body.anchorDate : null;
  const contactIds = body && stringArray(body.contactIds, 128);
  if (!body || !name || !timezone || !validTimeZone(timezone) || handoffWeekday === null
    || !handoffTime || !anchorDate || civilWeekday(anchorDate) !== handoffWeekday || !contactIds?.length) return null;
  return { name, timezone, handoffWeekday, handoffTime, anchorDate, contactIds };
}

function parseOverride(
  value: unknown,
  scheduleId: string
): Omit<MonitoringOncallOverride, "id" | "revision" | "createdAt" | "updatedAt"> | null {
  const body = object(value);
  const contactId = body && text(body.contactId, 128);
  const startsAt = body && timestamp(body.startsAt);
  const endsAt = body && timestamp(body.endsAt);
  const reason = body && text(body.reason, 240);
  if (!body || !contactId || !startsAt || !endsAt || endsAt <= startsAt || !reason) return null;
  return { scheduleId, contactId, startsAt, endsAt, reason };
}

function parsePolicy(value: unknown): MonitoringEscalationPolicyInput | null {
  const body = object(value);
  const name = body && text(body.name, 80);
  if (!body || !name || typeof body.enabled !== "boolean" || !Array.isArray(body.stages)
    || body.stages.length < 1 || body.stages.length > 5) return null;
  const stages = body.stages.map((value) => {
    const stage = object(value);
    const delaySeconds = stage && boundedInteger(stage.delaySeconds, 0, 604_800);
    const repeatCount = stage && boundedInteger(stage.repeatCount, 0, 10);
    const repeatIntervalSeconds = stage?.repeatIntervalSeconds === null ? null
      : stage ? boundedInteger(stage.repeatIntervalSeconds, 300, 604_800) : null;
    if (!stage || delaySeconds === null || repeatCount === null || !Array.isArray(stage.targets)) return null;
    const targets = stage.targets.map((value) => {
      const target = object(value);
      const type = target && oneOf(target.type, ["contact", "group", "oncall"] as const);
      const id = target && text(target.id, 128);
      return type && id ? { type, id } : null;
    });
    if (targets.some((target) => target === null) || targets.length === 0) return null;
    return { delaySeconds, repeatCount, repeatIntervalSeconds, targets: targets.filter((target) => target !== null) };
  });
  if (stages.some((stage) => stage === null)) return null;
  const parsed = stages.filter((stage) => stage !== null);
  if (parsed.some((stage, index) => index > 0 && stage.delaySeconds <= parsed[index - 1]!.delaySeconds)) return null;
  if (parsed.some((stage, index) => index !== parsed.length - 1 && (stage.repeatCount > 0 || stage.repeatIntervalSeconds !== null))) return null;
  if (parsed.at(-1)!.repeatCount > 0 && parsed.at(-1)!.repeatIntervalSeconds === null) return null;
  return { name, enabled: body.enabled, stages: parsed };
}

function parseSmtp(value: unknown): MonitoringSmtpSettingsInput | null {
  const body = object(value);
  const host = body && text(body.host, 253, true);
  const port = body && boundedInteger(body.port, 1, 65_535);
  const security = body && oneOf(body.security, ["none", "starttls", "tls"] as const);
  const username = body && text(body.username, 254, true);
  const from = body && text(body.from, 254, true);
  if (!body || host === null || port === null || !security || username === null || from === null
    || typeof body.enabled !== "boolean" || (body.password !== undefined && typeof body.password !== "string")) return null;
  if (body.enabled && (!host || !email(from))) return null;
  return body.password === undefined
    ? { enabled: body.enabled, host, port, security, username, from }
    : { enabled: body.enabled, host, port, security, username, from, password: body.password };
}

function parseHealthRouting(value: unknown): Pick<MonitoringHealthRouting, "warningPolicyId" | "criticalPolicyId"> | null {
  const body = object(value);
  if (!body || !(body.warningPolicyId === null || typeof body.warningPolicyId === "string")
    || !(body.criticalPolicyId === null || typeof body.criticalPolicyId === "string")) return null;
  return { warningPolicyId: nullableId(body.warningPolicyId), criticalPolicyId: nullableId(body.criticalPolicyId) };
}

type AlertReferenceTable =
  | "monitoring_alert_contacts"
  | "monitoring_alert_rules"
  | "monitoring_alert_contact_groups"
  | "monitoring_oncall_schedules"
  | "monitoring_escalation_policies";

function optionalReferenceExists(
  db: ApiRouteContext["db"],
  table: AlertReferenceTable,
  id: string | null
): boolean {
  return id === null || referencesExist(db, table, [id]);
}

function referencesExist(
  db: ApiRouteContext["db"],
  table: AlertReferenceTable,
  ids: readonly string[]
): boolean {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return true;
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const count = db.prepare(`SELECT COUNT(*) FROM ${table} WHERE id IN (${placeholders})`)
    .pluck().get(...uniqueIds) as number;
  return count === uniqueIds.length;
}

function policyTargetsExist(db: ApiRouteContext["db"], input: MonitoringEscalationPolicyInput): boolean {
  const targets = input.stages.flatMap((stage) => stage.targets);
  return referencesExist(
    db,
    "monitoring_alert_contacts",
    targets.filter((target) => target.type === "contact").map((target) => target.id)
  ) && referencesExist(
    db,
    "monitoring_alert_contact_groups",
    targets.filter((target) => target.type === "group").map((target) => target.id)
  ) && referencesExist(
    db,
    "monitoring_oncall_schedules",
    targets.filter((target) => target.type === "oncall").map((target) => target.id)
  );
}

function withDelete(
  reply: FastifyReply,
  rawRevision: string | undefined,
  remove: (revision: number) => boolean,
  resource: string
): unknown {
  return withRevisionConflict(reply, () => {
    const revision = positiveInteger(rawRevision);
    if (revision === null) return badRequest(reply, "expectedRevision is required");
    return remove(revision) ? reply.status(204).send() : notFound(reply, `${resource} not found`);
  });
}

function withRevisionConflict(reply: FastifyReply, action: () => unknown): unknown {
  try {
    return action();
  } catch (error) {
    if (error instanceof MonitoringAlertRevisionConflictError) {
      return reply.status(409).send({ error: error.message });
    }
    if (error instanceof MonitoringAlertReferenceConflictError) {
      return reply.status(409).send({ error: error.message });
    }
    throw error;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function text(value: unknown, maximum: number, allowEmpty = false): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return (allowEmpty || normalized.length > 0) && normalized.length <= maximum ? normalized : null;
}

function nullableId(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value, 128);
}

function stringRecord(value: unknown): Record<string, string> | null {
  const record = object(value);
  if (!record || Object.keys(record).length > 8) return null;
  const entries = Object.entries(record);
  if (entries.some(([key, item]) => key.length > 64 || typeof item !== "string" || item.length > 128)) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function stringArray(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max || value.some((item) => !text(item, 128))) return null;
  return [...new Set(value as string[])];
}

function email(value: unknown): string | null {
  const address = text(value, 254);
  return address && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address) ? address.toLowerCase() : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function civilWeekday(value: string): number | null {
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  const weekday = date.getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = typeof value === "string" && value.length > 0 ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed : null;
}

function positiveInteger(value: unknown): number | null {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

function oneOf<const T extends readonly (string | number)[]>(value: unknown, options: T): T[number] | null {
  return options.includes(value as never) ? value as T[number] : null;
}

function badRequest(reply: FastifyReply, error: string): undefined {
  reply.status(400).send({ error });
  return undefined;
}

function notFound(reply: FastifyReply, error: string): undefined {
  reply.status(404).send({ error });
  return undefined;
}
