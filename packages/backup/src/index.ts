import { openCyberOsDb } from "@cyberos/db";
import { loadCyberOsRuntime } from "@cyberos/shared";
import {
  checkBackup,
  initBackup,
  loadBackupRuntime,
  restoreBackup,
  runBackup,
  shouldSkipScheduledBackup,
  validateBackup
} from "./backup.js";

const [command, ...rest] = process.argv.slice(2);
const bootstrapRuntime = loadCyberOsRuntime();

if (command === "restore") {
  const repositoryPath = requiredOption(rest, "--repository");
  const passwordFile = requiredOption(rest, "--password-file");
  const snapshot = requiredOption(rest, "--snapshot");
  const result = await restoreBackup({
    config: bootstrapRuntime,
    repositoryPath,
    passwordFile,
    snapshot
  });
  console.log(JSON.stringify(result));
} else {
  const db = openCyberOsDb(bootstrapRuntime.paths.databasePath);
  const config = loadBackupRuntime(db, bootstrapRuntime);
  try {
    if (shouldSkipScheduledBackup(config, command)) {
      console.log(JSON.stringify({ event: "backup.run.skipped", reason: "disabled" }));
    } else if (command === "validate") {
      const result = await validateBackup({ db, config });
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    } else if (command === "init") {
      await initBackup({ db, config });
    } else if (command === "check") {
      const result = await checkBackup({ db, config });
      console.log(JSON.stringify(result));
      if (result?.status === "failed" || result?.status === "interrupted") process.exitCode = 1;
    } else if (command === "run") {
      const kind = rest[rest.indexOf("--kind") + 1] ?? "daily";
      if (kind !== "daily" && kind !== "weekly") throw new Error("Backup kind must be daily or weekly");
      const result = await runBackup({ db, config, kind });
      console.log(JSON.stringify(result));
      if (result.status === "failed" || result.status === "interrupted") process.exitCode = 1;
    } else {
      throw new Error("Usage: backup validate|init|run --kind daily|weekly|check|restore --repository <path> --password-file <path> --snapshot <id>");
    }
  } finally {
    db.close();
  }
}

function requiredOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}
