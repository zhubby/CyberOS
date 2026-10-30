import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "packaging/**/*.test.ts",
      "packaging/**/*.test.mjs",
      "scripts/**/*.test.mjs"
    ],
    // Native SQLite handles must be isolated from worker-thread teardown.
    pool: "forks"
  },
  resolve: {
    alias: {
      "@cyberos/agent": new URL("packages/agent/src/index.ts", `file://${root}`).pathname,
      "@cyberos/db": new URL("packages/db/src/index.ts", `file://${root}`).pathname,
      "@cyberos/storage-tools": new URL("packages/storage-tools/src/index.ts", `file://${root}`).pathname,
      "@cyberos/monitoring/test-utils": new URL("packages/monitoring/src/test-utils.ts", `file://${root}`).pathname,
      "@cyberos/monitoring": new URL("packages/monitoring/src/index.ts", `file://${root}`).pathname,
      "@cyberos/shared/docker-images": new URL("packages/shared/src/docker-images.ts", `file://${root}`).pathname,
      "@cyberos/shared/docker-resources": new URL("packages/shared/src/docker-resources.ts", `file://${root}`).pathname,
      "@cyberos/shared/photos-config": new URL("packages/shared/src/photos-config.ts", `file://${root}`).pathname,
      "@cyberos/shared/mcp-network": new URL("packages/shared/src/mcp-network.ts", `file://${root}`).pathname,
      "@cyberos/shared": new URL("packages/shared/src/index.ts", `file://${root}`).pathname
    }
  }
});
