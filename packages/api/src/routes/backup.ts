import { access, constants as fsConstants } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { listBackupRuns, listHealthAlerts } from "@cyberos/db";
import type { ApiRouteContext } from "../context.js";

export function registerBackupRoutes(server: FastifyInstance, { db, config }: ApiRouteContext): void {
  server.get("/api/backup/status", async () => {
    const repositoryAvailable = config.backup.repositoryPath !== null
      && await access(config.backup.repositoryPath, fsConstants.R_OK | fsConstants.W_OK).then(() => true).catch(() => false);
    const passwordConfigured = config.backup.passwordFile !== null
      && await access(config.backup.passwordFile, fsConstants.R_OK).then(() => true).catch(() => false);
    return {
      enabled: config.backup.enabled,
      repositoryConfigured: config.backup.repositoryPath !== null,
      repositoryAvailable,
      passwordConfigured,
      repositoryPath: config.backup.repositoryPath,
      stagingPath: config.backup.stagingPath,
      runs: listBackupRuns(db, 30),
      alerts: listHealthAlerts(db, { limit: 100 }).filter((alert) => alert.code.startsWith("backup_") || alert.code === "repo_check_failed")
    };
  });
}
