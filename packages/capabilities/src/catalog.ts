import { PARITY_MANIFEST } from "./parity-manifest.js";
import type { CapabilityApprovalPolicy, CapabilityDescriptor, CapabilityRisk, JsonSchema } from "./contracts.js";
import { EMPTY_OBJECT_SCHEMA, GENERIC_OBJECT_SCHEMA, strictObject } from "./schemas.js";

const DEFAULT_OUTPUT_LIMIT = 256 * 1024;

function scopeFor(domain: string, risk: CapabilityRisk, approval: CapabilityApprovalPolicy): string {
  if (domain === "catalog") return "zos:catalog:read";
  if (domain === "shell") return "zos:admin:shell";
  if (domain === "system" && risk === "critical") return "zos:admin:power";
  if (approval === "owner_control") return `zos:${domain}:read`;
  return `zos:${domain}:${risk === "read" ? "read" : "propose"}`;
}

export function createCatalogDescriptors(): CapabilityDescriptor[] {
  return PARITY_MANIFEST.map((entry) => ({
    id: entry.capabilityId,
    domain: entry.domain,
    title: entry.uiOutcome,
    description: entry.uiOutcome,
    inputSchema: inputSchemaFor(entry.capabilityId, entry.risk),
    outputSchema: GENERIC_OBJECT_SCHEMA,
    risk: entry.risk,
    requiredScopes: [scopeFor(entry.domain, entry.risk, entry.approval)],
    approval: entry.approval,
    idempotency: entry.risk === "read" || entry.approval === "owner_control" ? "none" : "optional",
    maxOutputBytes: DEFAULT_OUTPUT_LIMIT,
    annotations: {
      readOnlyHint: entry.risk === "read",
      destructiveHint: entry.approval === "owner_control" || entry.risk === "high" || entry.risk === "critical",
      idempotentHint: entry.risk === "read",
      openWorldHint: false
    }
  }));
}

function inputSchemaFor(capabilityId: string, risk: CapabilityRisk): JsonSchema {
  if (capabilityId === "zos.files.mutate-propose") {
    return strictObject({
      request: strictObject({
        operation: { type: "string", enum: ["mkdir", "move", "copy", "rename", "trash"] },
        rootId: { type: "string", minLength: 1, maxLength: 128 },
        sourcePath: { type: "string", minLength: 1, maxLength: 4096 },
        targetPath: { type: "string", minLength: 1, maxLength: 4096 }
      }, ["operation", "rootId"]),
      idempotencyKey: { type: "string", minLength: 8, maxLength: 200 }
    }, ["request"]);
  }
  if (capabilityId === "zos.files.resource-link") {
    return strictObject({
      rootId: { type: "string", minLength: 1, maxLength: 128 },
      path: { type: "string", minLength: 1, maxLength: 4096 }
    }, ["rootId", "path"]);
  }
  return risk === "read" ? EMPTY_OBJECT_SCHEMA : strictObject({
    request: GENERIC_OBJECT_SCHEMA,
    idempotencyKey: { type: "string", minLength: 8, maxLength: 200 }
  }, ["request"]);
}
