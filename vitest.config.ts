import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "packaging/**/*.test.ts",
      "packaging/**/*.test.mjs",
      "scripts/**/*.test.mjs"
    ],
    pool: "threads"
  },
  resolve: {
    alias: {
      "@zos/agent": new URL("packages/agent/src/index.ts", `file://${root}`).pathname,
      "@zos/db": new URL("packages/db/src/index.ts", `file://${root}`).pathname,
      "@zos/nas-tools": new URL("packages/nas-tools/src/index.ts", `file://${root}`).pathname,
      "@zos/monitoring": new URL("packages/monitoring/src/index.ts", `file://${root}`).pathname,
      "@zos/shared/docker-images": new URL("packages/shared/src/docker-images.ts", `file://${root}`).pathname,
      "@zos/shared/docker-resources": new URL("packages/shared/src/docker-resources.ts", `file://${root}`).pathname,
      "@zos/shared/photostaff-config": new URL("packages/shared/src/photostaff-config.ts", `file://${root}`).pathname,
      "@zos/shared": new URL("packages/shared/src/index.ts", `file://${root}`).pathname
    }
  }
});
