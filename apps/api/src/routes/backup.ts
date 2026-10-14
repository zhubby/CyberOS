import { access, constants as fsConstants } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { listBackupRuns, listHealthAlerts } from "@zos/db";
import type { ApiRouteContext } from "../context.js";

export function registerBackupRoutes(server: FastifyInstance, { db, config }: ApiRouteContext): void {
  server.get("/api/backup/status", async () => {
    const repositoryAvailable = Boolean(config.backup?.repositoryPath) && await access(config.backup!.repositoryPath!, fsConstants.R_OK | fsConstants.W_OK).then(() => true).catch(() => false);
    const passwordConfigured = Boolean(config.backup?.passwordFile) && await access(config.backup!.passwordFile!, fsConstants.R_OK).then(() => true).catch(() => false);
    return {
    enabled: Boolean(config.backup?.enabled),
    repositoryConfigured: Boolean(config.backup?.repositoryPath),
    repositoryAvailable,
    passwordConfigured,
    repositoryPath: config.backup?.repositoryPath ?? null,
    stagingPath: config.backup?.stagingPath ?? null,
    runs: listBackupRuns(db, 30),
    alerts: listHealthAlerts(db, { limit: 100 }).filter((alert) => alert.code.startsWith("backup_") || alert.code === "repo_check_failed")
    };
  });
}
