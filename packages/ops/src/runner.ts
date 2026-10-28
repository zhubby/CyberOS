import {
  finishOpsRun,
  heartbeatOpsRun,
  startOpsRun,
  type CyberOsDatabase
} from "@cyberos/db";
import { type OpsMaintenanceSummary, type CyberOsConfig, type SystemHealthSummary } from "@cyberos/shared";
import { runScheduledHealthEvaluation } from "@cyberos/system-health";
import { runMaintenance } from "./maintenance.js";

export async function runHealthTask(input: {
  db: CyberOsDatabase;
  config: CyberOsConfig;
  now?: Date;
}): Promise<SystemHealthSummary> {
  return runTrackedTask(input, "health", async () => {
    const summary = await runScheduledHealthEvaluation(input);
    return { result: summary, persisted: { ...summary } };
  });
}

export async function runMaintenanceTask(input: {
  db: CyberOsDatabase;
  config: CyberOsConfig;
  now?: Date;
}): Promise<OpsMaintenanceSummary> {
  return runTrackedTask(input, "maintenance", async () => {
    const summary = await runMaintenance(input);
    return { result: summary, persisted: { ...summary } };
  });
}

async function runTrackedTask<T>(
  input: { db: CyberOsDatabase; config: CyberOsConfig; now?: Date },
  task: "health" | "maintenance",
  execute: () => Promise<{ result: T; persisted: Record<string, unknown> }>
): Promise<T> {
  const run = startOpsRun(input.db, { task, ...(input.now ? { now: input.now } : {}) });
  const heartbeat = setInterval(() => {
    heartbeatOpsRun(input.db, { runId: run.id });
  }, 5_000);
  heartbeat.unref?.();
  try {
    const { result, persisted } = await execute();
    const finished = finishOpsRun(input.db, {
      runId: run.id,
      status: "completed",
      summary: persisted,
      ...(input.now ? { finishedAt: input.now } : {})
    });
    if (!finished) throw new Error(`${task} operation lifecycle was interrupted`);
    return result;
  } catch (error) {
    finishOpsRun(input.db, {
      runId: run.id,
      status: "failed",
      error: sanitizeOpsError(error, input.config),
      ...(input.now ? { finishedAt: input.now } : {})
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

function sanitizeOpsError(error: unknown, config: CyberOsConfig): string {
  let message = error instanceof Error ? error.message : "operation failed";
  const privatePaths = [config.paths.dataRoot, config.paths.stateDir, config.paths.databasePath]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const privatePath of privatePaths) message = message.split(privatePath).join("<path>");
  return message.replace(/\s+/gu, " ").slice(0, 512) || "operation failed";
}
