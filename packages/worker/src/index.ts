import { ensureNasRoots, openZosDb } from "@zos/db";
import { loadConfig } from "@zos/shared";
import { processNextJob } from "./processor.js";

const config = loadConfig();
const db = openZosDb(config.databasePath);
ensureNasRoots(db, config.nasRoots);

let shuttingDown = false;
let activeTicks = 0;
let databaseClosed = false;

async function tick(): Promise<void> {
  if (shuttingDown) {
    return;
  }

  activeTicks += 1;
  try {
    await processNextJob({ db, config });
  } catch (error) {
    console.error(error);
  } finally {
    activeTicks -= 1;
    closeDatabaseWhenIdle();
  }
}

const timer = setInterval(() => {
  void tick();
}, config.worker.pollMs);

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

void tick();

function shutdown(): void {
  shuttingDown = true;
  clearInterval(timer);
  closeDatabaseWhenIdle();
}

function closeDatabaseWhenIdle(): void {
  if (shuttingDown && activeTicks === 0 && !databaseClosed) {
    databaseClosed = true;
    db.close();
  }
}
