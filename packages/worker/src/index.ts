import { randomUUID } from "node:crypto";
import os from "node:os";
import { disposePiAgentHosts } from "@cyberos/agent";
import { ensureNasRoots, openCyberOsDb, recoverInterruptedAgentSessionCommands } from "@cyberos/db";
import { loadConfig } from "@cyberos/shared";
import { AGENT_JOB_LEASE_MS, processNextAgentCommand, processNextJob } from "./processor.js";

const config = loadConfig();
const db = openCyberOsDb(config.databasePath);
ensureNasRoots(db, config.nasRoots);
recoverInterruptedAgentSessionCommands(db);

let shuttingDown = false;
let activeTicks = 0;
let databaseClosed = false;
let activeJobTicks = 0;
let activeCommandTicks = 0;
let finalizing = false;
const workerId = `${os.hostname()}:${process.pid}:${randomUUID()}`;
const workerConcurrency = config.worker.concurrency ?? 2;

async function tick(): Promise<void> {
  if (shuttingDown || activeJobTicks >= workerConcurrency) {
    return;
  }

  activeJobTicks += 1;
  activeTicks += 1;
  try {
    await processNextJob({ db, config, workerId, leaseMs: AGENT_JOB_LEASE_MS });
  } catch (error) {
    console.error(error);
  } finally {
    activeTicks -= 1;
    activeJobTicks -= 1;
    closeDatabaseWhenIdle();
  }
}

async function commandTick(): Promise<void> {
  if (shuttingDown || activeCommandTicks >= workerConcurrency) return;
  activeCommandTicks += 1;
  activeTicks += 1;
  try {
    await processNextAgentCommand({ db, config, workerId });
  } catch (error) {
    console.error(error);
  } finally {
    activeTicks -= 1;
    activeCommandTicks -= 1;
    closeDatabaseWhenIdle();
  }
}

const timer = setInterval(() => {
  void tick();
}, config.worker.pollMs);
const commandTimer = setInterval(() => {
  void commandTick();
}, Math.min(config.worker.pollMs, 250));

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

void tick();
void commandTick();

function shutdown(): void {
  shuttingDown = true;
  clearInterval(timer);
  clearInterval(commandTimer);
  closeDatabaseWhenIdle();
}

function closeDatabaseWhenIdle(): void {
  if (!shuttingDown || activeTicks !== 0 || databaseClosed || finalizing) return;
  finalizing = true;
  void disposePiAgentHosts().finally(() => {
    databaseClosed = true;
    db.close();
  });
}
