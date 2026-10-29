import { access, constants as fsConstants } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { defaultBackupSettings, getBackupSettings, listBackupRuns, listHealthAlerts } from "@cyberos/db";
import type { ApiRouteContext } from "../context.js";

export function registerBackupRoutes(server: FastifyInstance, { db, config }: ApiRouteContext): void {
  server.get("/api/backup/status", async () => {
    const settings = getBackupSettings(db) ?? defaultBackupSettings(
      config.paths.backupRoot,
      config.environment === "production"
    );
    const repositoryAvailable = await access(
      settings.repositoryPath,
      fsConstants.R_OK | fsConstants.W_OK
    ).then(() => true).catch(() => false);
    const passwordConfigured = await access(
      config.paths.backupPasswordPath,
      fsConstants.R_OK
    ).then(() => true).catch(() => false);
    return {
      enabled: settings.enabled,
      repositoryConfigured: Boolean(settings.repositoryPath),
      repositoryAvailable,
      passwordConfigured,
      repositoryPath: settings.repositoryPath,
      stagingPath: config.backup.stagingPath,
      runs: listBackupRuns(db, 30),
      alerts: listHealthAlerts(db, { limit: 100 }).filter((alert) => alert.code.startsWith("backup_") || alert.code === "repo_check_failed")
    };
  });
}
