import { PARITY_MANIFEST } from "./parity-manifest.js";
import type { CapabilityApprovalPolicy, CapabilityDescriptor, CapabilityRisk } from "./contracts.js";
import { capabilityInputSchema } from "./request-contracts.js";
import { GENERIC_OBJECT_SCHEMA } from "./schemas.js";

const DEFAULT_OUTPUT_LIMIT = 256 * 1024;

function scopeFor(domain: string, risk: CapabilityRisk, approval: CapabilityApprovalPolicy): string {
  if (domain === "catalog") return "cyberos:catalog:read";
  if (domain === "shell") return "cyberos:admin:shell";
  if (domain === "system" && risk === "critical") return "cyberos:admin:power";
  if (approval === "owner_control") return `cyberos:${domain}:read`;
  return `cyberos:${domain}:${risk === "read" ? "read" : "propose"}`;
}

export function createCatalogDescriptors(): CapabilityDescriptor[] {
  return PARITY_MANIFEST.map((entry) => ({
    id: entry.capabilityId,
    domain: entry.domain,
    title: entry.uiOutcome,
    description: entry.uiOutcome,
    inputSchema: capabilityInputSchema(entry.capabilityId),
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
