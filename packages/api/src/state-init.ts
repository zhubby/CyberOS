import { chmodSync, mkdirSync } from "node:fs";
import { openCyberOsDb } from "@cyberos/db";
import { loadBootstrap } from "@cyberos/shared";

const bootstrap = loadBootstrap();
mkdirSync(bootstrap.paths.stateDir, { recursive: true, mode: 0o750 });
mkdirSync(bootstrap.paths.secretsDir, { recursive: true, mode: 0o700 });
mkdirSync(bootstrap.paths.backupSecretsDir, { recursive: true, mode: 0o700 });
mkdirSync(bootstrap.paths.shareSecretsDir, { recursive: true, mode: 0o700 });
mkdirSync(bootstrap.paths.mcpStateDir, { recursive: true, mode: 0o700 });
mkdirSync(bootstrap.paths.tvStateDir, { recursive: true, mode: 0o750 });

const db = openCyberOsDb(bootstrap.paths.databasePath);
db.close();
chmodSync(bootstrap.paths.databasePath, 0o640);

console.log(JSON.stringify({
  event: "cyberos.state.initialized",
  databasePath: bootstrap.paths.databasePath
}));
