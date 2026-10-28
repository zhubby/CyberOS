import { ensureNasRoots, openCyberOsDb } from "@cyberos/db";
import { loadConfig } from "@cyberos/shared";
import { runHealthTask, runMaintenanceTask } from "./runner.js";

const [command, ...rest] = process.argv.slice(2);
if ((command !== "health" && command !== "maintenance") || rest.length > 0) {
  console.error("Usage: ops health|maintenance");
  process.exitCode = 2;
} else {
  const config = loadConfig();
  const db = openCyberOsDb(config.databasePath);
  ensureNasRoots(db, config.nasRoots);
  try {
    const summary = command === "health"
      ? await runHealthTask({ db, config })
      : await runMaintenanceTask({ db, config });
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(JSON.stringify({
      event: `ops.${command}.failed`,
      error: error instanceof Error ? error.message : "operation failed"
    }));
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
