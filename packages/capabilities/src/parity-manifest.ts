import type { CapabilityApprovalPolicy, CapabilityRisk } from "./contracts.js";

export interface ParityManifestEntry {
  capabilityId: `cyberos.${string}.${string}`;
  domain: string;
  owner: string;
  rest: readonly string[];
  uiOutcome: string;
  risk: CapabilityRisk;
  approval: CapabilityApprovalPolicy;
}

type ManifestSeed = Omit<ParityManifestEntry, "owner">;

const entries: ManifestSeed[] = [
  { capabilityId: "cyberos.catalog.get", domain: "catalog", rest: [], uiOutcome: "Discover agent capabilities", risk: "read", approval: "none" },
  { capabilityId: "cyberos.system.status", domain: "system", rest: ["GET /health", "GET /api/system/build-info", "GET /api/system/health"], uiOutcome: "View system and build status", risk: "read", approval: "none" },
  { capabilityId: "cyberos.system.power-propose", domain: "system", rest: ["POST /api/system/power"], uiOutcome: "Restart or power off the host", risk: "critical", approval: "first_party_confirm" },
  { capabilityId: "cyberos.operations.list", domain: "operations", rest: ["GET /api/system/operations"], uiOutcome: "View health and maintenance runs", risk: "read", approval: "none" },
  { capabilityId: "cyberos.operations.run-propose", domain: "operations", rest: ["POST /api/system/operations/:task/run"], uiOutcome: "Run health or maintenance", risk: "high", approval: "first_party_confirm" },
  { capabilityId: "cyberos.storage-pools.list", domain: "storage", rest: ["GET /api/system/storage"], uiOutcome: "View storage pools", risk: "read", approval: "none" },
  { capabilityId: "cyberos.files.list", domain: "files", rest: ["GET /api/files"], uiOutcome: "Browse files", risk: "read", approval: "none" },
  { capabilityId: "cyberos.files.stat", domain: "files", rest: ["GET /api/files/meta"], uiOutcome: "Inspect file metadata", risk: "read", approval: "none" },
  { capabilityId: "cyberos.files.read", domain: "files", rest: ["GET /api/files/text", "GET /api/files/edit-text"], uiOutcome: "Read bounded text", risk: "read", approval: "none" },
  { capabilityId: "cyberos.files.resource-link", domain: "files", rest: [], uiOutcome: "Create a short-lived one-time file resource link", risk: "read", approval: "none" },
  { capabilityId: "cyberos.files.search", domain: "files", rest: ["GET /api/search", "POST /api/search"], uiOutcome: "Search indexed files", risk: "read", approval: "none" },
  { capabilityId: "cyberos.files.grep", domain: "files", rest: [], uiOutcome: "Search file contents", risk: "read", approval: "none" },
  { capabilityId: "cyberos.files.find", domain: "files", rest: [], uiOutcome: "Find files and directories", risk: "read", approval: "none" },
  { capabilityId: "cyberos.files.git", domain: "files", rest: [], uiOutcome: "Inspect repository state embedded in file listings and search results", risk: "read", approval: "none" },
  { capabilityId: "cyberos.files.archive-inspect", domain: "files", rest: [], uiOutcome: "Inspect archive contents", risk: "read", approval: "none" },
  { capabilityId: "cyberos.files.export-propose", domain: "files", rest: ["POST /api/files/exports"], uiOutcome: "Export files", risk: "medium", approval: "first_party" },
  { capabilityId: "cyberos.files.mutate", domain: "files", rest: ["PUT /api/files/upload", "POST /api/files/mutations", "POST /api/files/batches", "POST /api/files/extract", "POST /api/trash/:id/restore"], uiOutcome: "Create, move, copy, rename, trash, restore, or extract files", risk: "high", approval: "first_party" },
  { capabilityId: "cyberos.files.edit", domain: "files", rest: ["PUT /api/files/edit-text"], uiOutcome: "Edit an existing text file", risk: "high", approval: "first_party" },
  { capabilityId: "cyberos.files.write", domain: "files", rest: [], uiOutcome: "Write or replace a file", risk: "high", approval: "first_party" },
  { capabilityId: "cyberos.files.rollback-propose", domain: "files", rest: ["POST /api/operations/:id/rollback"], uiOutcome: "Roll back a reversible file operation", risk: "high", approval: "first_party" },
  { capabilityId: "cyberos.index.status", domain: "index", rest: ["GET /api/indexer/status"], uiOutcome: "View index status", risk: "read", approval: "none" },
  { capabilityId: "cyberos.index.reindex-propose", domain: "index", rest: ["POST /api/indexer/reindex"], uiOutcome: "Reindex a storage pool", risk: "medium", approval: "first_party" },
  { capabilityId: "cyberos.photos.query", domain: "photos", rest: ["POST /api/photos/query", "POST /api/photos/map/query", "GET /api/photos/:id/record"], uiOutcome: "Browse photo library and map", risk: "read", approval: "none" },
  { capabilityId: "cyberos.photos.status", domain: "photos", rest: ["GET /api/photos/status", "GET /api/photos/settings"], uiOutcome: "View photo service status and configured settings", risk: "read", approval: "none" },
  { capabilityId: "cyberos.photos.media", domain: "photos", rest: ["GET /api/photos/:id/thumbnail", "GET /api/photos/:id/preview", "GET /api/photos/:id/video"], uiOutcome: "Request photo or video resource links", risk: "read", approval: "none" },
  { capabilityId: "cyberos.photos.manage-propose", domain: "photos", rest: ["POST /api/photos/scans", "PUT /api/photos/upload", "POST /api/photos/exports", "POST /api/photos/actions", "PATCH /api/settings/photos"], uiOutcome: "Scan, upload, export, move, trash, or configure photos", risk: "high", approval: "first_party" },
  { capabilityId: "cyberos.downloads.list", domain: "downloads", rest: ["GET /api/downloads", "GET /api/settings/downloads"], uiOutcome: "View downloads and settings", risk: "read", approval: "none" },
  { capabilityId: "cyberos.downloads.manage-propose", domain: "downloads", rest: ["POST /api/downloads", "POST /api/downloads/:id/pause", "POST /api/downloads/:id/resume", "POST /api/downloads/:id/cancel", "POST /api/downloads/:id/retry", "DELETE /api/downloads/:id", "PATCH /api/settings/downloads"], uiOutcome: "Create or manage downloads", risk: "high", approval: "first_party" },
  { capabilityId: "cyberos.backup.status", domain: "backup", rest: ["GET /api/backup/status"], uiOutcome: "View backup status and history", risk: "read", approval: "none" },
  { capabilityId: "cyberos.backup.run-propose", domain: "backup", rest: [], uiOutcome: "Validate, initialize, run, check, or stage a restore", risk: "critical", approval: "first_party_confirm" },
  { capabilityId: "cyberos.monitoring.overview", domain: "monitoring", rest: ["GET /api/monitoring/overview", "GET /api/monitoring/catalog"], uiOutcome: "View monitoring overview and metric catalog", risk: "read", approval: "none" },
  { capabilityId: "cyberos.monitoring.query", domain: "monitoring", rest: ["POST /api/monitoring/query"], uiOutcome: "Query bounded metrics", risk: "read", approval: "none" },
  { capabilityId: "cyberos.alerts.read", domain: "alerts", rest: ["GET /api/monitoring/alerts/summary", "GET /api/monitoring/alerts/rules", "GET /api/monitoring/alerts/incidents", "GET /api/monitoring/alerts/deliveries/:id"], uiOutcome: "View alerts, incidents, deliveries, and routing", risk: "read", approval: "none" },
  { capabilityId: "cyberos.alerts.manage-propose", domain: "alerts", rest: ["POST /api/monitoring/alerts/rules", "PATCH /api/monitoring/alerts/rules/:id", "DELETE /api/monitoring/alerts/rules/:id", "POST /api/monitoring/alerts/silences", "POST /api/monitoring/alerts/test-email"], uiOutcome: "Manage rules, incidents, silences, contacts, SMTP, groups, schedules, policies, and routing", risk: "high", approval: "first_party" },
  { capabilityId: "cyberos.notifications.list", domain: "notifications", rest: ["GET /api/notifications", "GET /api/notifications/summary"], uiOutcome: "View operation notifications", risk: "read", approval: "none" },
  { capabilityId: "cyberos.notifications.read-state-propose", domain: "notifications", rest: ["PATCH /api/notifications/:id/read", "POST /api/notifications/read-all"], uiOutcome: "Update notification read state", risk: "low", approval: "first_party" },
  { capabilityId: "cyberos.docker.status", domain: "docker", rest: ["GET /api/docker/summary", "GET /api/docker/apps", "GET /api/docker/registries", "GET /api/docker/host-access", "GET /api/docker/operations", "GET /api/docker/containers/:id/logs"], uiOutcome: "View Docker engine, apps, images, registries, logs, and Host Access catalog", risk: "read", approval: "none" },
  { capabilityId: "cyberos.docker.manage-propose", domain: "docker", rest: ["POST /api/docker/actions", "POST /api/docker/containers/:id/actions", "POST /api/docker/apps", "PUT /api/docker/apps/:id", "DELETE /api/docker/apps/:id", "POST /api/docker/images/pull", "POST /api/docker/images/remove", "PUT /api/docker/daemon/config"], uiOutcome: "Manage Docker lifecycle, Compose, images, registries, and daemon", risk: "critical", approval: "first_party_confirm" },
  { capabilityId: "cyberos.docker.console-propose", domain: "docker", rest: ["POST /api/docker/console-sessions"], uiOutcome: "Authorize a Docker console", risk: "critical", approval: "first_party_confirm" },
  { capabilityId: "cyberos.vm.status", domain: "vm", rest: ["GET /api/vms/summary", "GET /api/vms/operations"], uiOutcome: "View VM host, instances, and operations", risk: "read", approval: "none" },
  { capabilityId: "cyberos.vm.manage-propose", domain: "vm", rest: ["POST /api/vms/actions"], uiOutcome: "Create or manage virtual machines", risk: "critical", approval: "first_party_confirm" },
  { capabilityId: "cyberos.vm.console-propose", domain: "vm", rest: [], uiOutcome: "Authorize a VM console", risk: "critical", approval: "first_party_confirm" },
  { capabilityId: "cyberos.network.status", domain: "network", rest: ["GET /api/system/network", "GET /api/system/network/traffic", "GET /api/system/network/ethernet"], uiOutcome: "View Ethernet, Wi-Fi, profiles, hotspot, and traffic", risk: "read", approval: "none" },
  { capabilityId: "cyberos.network.manage-propose", domain: "network", rest: ["PUT /api/system/network/ethernet/:id", "POST /api/system/network/ethernet/apply", "POST /api/system/network/wifi/connect", "POST /api/system/network/wifi/disconnect", "PUT /api/system/network/wifi/radio", "PATCH /api/system/network/wifi/profiles/:id", "PUT /api/system/network/wifi/hotspot"], uiOutcome: "Stage, apply, confirm, or roll back network changes", risk: "critical", approval: "first_party_confirm" },
  { capabilityId: "cyberos.storage.status", domain: "storage", rest: ["GET /api/shares/summary"], uiOutcome: "View pools, disks, shares, and services", risk: "read", approval: "none" },
  { capabilityId: "cyberos.storage.manage-propose", domain: "storage", rest: ["POST /api/storage/actions", "PUT /api/shares/account", "POST /api/shares/settings"], uiOutcome: "Create or delete pools and manage shares/accounts", risk: "critical", approval: "first_party_confirm" },
  { capabilityId: "cyberos.settings.public", domain: "settings", rest: ["GET /api/settings/indexer", "GET /api/settings/system-info", "GET /api/settings/model-provider", "GET /api/settings/agent-capability-policy", "GET /api/settings/docker", "GET /api/settings/shares"], uiOutcome: "View non-secret settings and configured flags", risk: "read", approval: "none" },
  { capabilityId: "cyberos.settings.update-propose", domain: "settings", rest: ["PATCH /api/settings/indexer", "PATCH /api/settings/model-provider", "PATCH /api/settings/agent-capability-policy"], uiOutcome: "Change non-secret settings or request credential configuration", risk: "high", approval: "first_party" },
  { capabilityId: "cyberos.terminal.tabs", domain: "terminal", rest: ["GET /api/terminal/tabs"], uiOutcome: "View terminal tabs", risk: "read", approval: "none" },
  { capabilityId: "cyberos.terminal.manage-propose", domain: "terminal", rest: ["POST /api/terminal/tabs", "PATCH /api/terminal/tabs/:id", "POST /api/terminal/tabs/:id/activate", "POST /api/terminal/tabs/:id/restart", "DELETE /api/terminal/tabs/:id"], uiOutcome: "Manage terminal tab lifecycle", risk: "high", approval: "first_party_confirm" },
  { capabilityId: "cyberos.shell.run", domain: "shell", rest: [], uiOutcome: "Run a bounded non-interactive command as cyberos", risk: "critical", approval: "first_party_confirm" },
  { capabilityId: "cyberos.vod.status", domain: "vod", rest: ["GET /api/vod-player/status"], uiOutcome: "View local playback status", risk: "read", approval: "none" },
  { capabilityId: "cyberos.vod.control-propose", domain: "vod", rest: ["POST /api/vod-player/command"], uiOutcome: "Control local playback", risk: "high", approval: "first_party" },
  { capabilityId: "cyberos.runs.get", domain: "runs", rest: [], uiOutcome: "Inspect an owned capability run", risk: "read", approval: "none" },
  { capabilityId: "cyberos.runs.list", domain: "runs", rest: [], uiOutcome: "List owned capability runs", risk: "read", approval: "none" },
  { capabilityId: "cyberos.runs.wait", domain: "runs", rest: [], uiOutcome: "Wait briefly for an owned capability run", risk: "read", approval: "none" },
  { capabilityId: "cyberos.runs.cancel", domain: "runs", rest: [], uiOutcome: "Cancel an owned interruptible run", risk: "low", approval: "owner_control" }
];

export const PARITY_MANIFEST: readonly ParityManifestEntry[] = Object.freeze(
  entries.map((entry) => ({ ...entry, owner: `packages/capabilities:${entry.domain}` }))
);

export function validateParityManifest(entriesToValidate: readonly ParityManifestEntry[] = PARITY_MANIFEST): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const routes = new Map<string, string>();
  for (const entry of entriesToValidate) {
    if (ids.has(entry.capabilityId)) errors.push(`duplicate capability id: ${entry.capabilityId}`);
    ids.add(entry.capabilityId);
    if (entry.uiOutcome.trim().length === 0) errors.push(`missing UI outcome: ${entry.capabilityId}`);
    if (entry.risk !== "read" && entry.approval === "none") errors.push(`mutation without approval: ${entry.capabilityId}`);
    if (entry.approval === "owner_control" && (entry.capabilityId !== "cyberos.runs.cancel" || entry.risk !== "low")) {
      errors.push(`invalid owner control: ${entry.capabilityId}`);
    }
    if (entry.capabilityId.includes("approve")) errors.push(`MCP approval capability is forbidden: ${entry.capabilityId}`);
    for (const route of entry.rest) {
      const existing = routes.get(route);
      if (existing && existing !== entry.capabilityId) errors.push(`route mapped twice: ${route}`);
      routes.set(route, entry.capabilityId);
    }
  }
  return errors;
}
