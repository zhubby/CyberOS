import { openCyberOsDbReadOnly } from "@cyberos/db";
import { loadCyberOsRuntime, mediaStreamerSocketPath } from "@cyberos/shared";
import { StreamManager } from "./manager.js";
import { startStreamServer } from "./server.js";

const config = loadCyberOsRuntime();
const db = openCyberOsDbReadOnly(config.paths.databasePath);
const manager = new StreamManager(db, config);
const close = await startStreamServer(manager, mediaStreamerSocketPath(config));
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void close().finally(() => {
    db.close();
    process.exitCode = 0;
  });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
