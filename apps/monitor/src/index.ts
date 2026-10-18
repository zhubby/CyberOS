import { loadConfig } from "@zos/shared";
import { createMonitorRuntime } from "./service.js";

const config = loadConfig();
const runtime = createMonitorRuntime(config);
runtime.start();

if (runtime.state === "disabled") {
  console.log("ZOS monitoring is disabled; service is idle");
} else {
  console.log(`ZOS monitoring is collecting into ${config.metricsDatabasePath ?? `${config.dataDir}/metrics.sqlite`}`);
}

let shutdownPromise: Promise<void> | null = null;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shutdownPromise ??= shutdown(signal);
    void shutdownPromise.catch((error) => {
      console.error("Failed to shut down ZOS monitor cleanly", error);
      process.exitCode = 1;
    });
  });
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`Stopping ZOS monitor after ${signal}`);
  await runtime.stop();
}
