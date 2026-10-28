import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWebApp } from "./web-static.js";

let server: FastifyInstance;
let webDist: string;
let docsDist: string;

beforeEach(async () => {
  webDist = await mkdtemp(path.join(os.tmpdir(), "cyberos-web-static-"));
  docsDist = await mkdtemp(path.join(os.tmpdir(), "cyberos-docs-static-"));
  await mkdir(path.join(webDist, "assets"));
  await mkdir(path.join(docsDist, "_astro"));
  await writeFile(path.join(webDist, "index.html"), "<!doctype html><title>CyberOS current</title>");
  await writeFile(path.join(webDist, "assets", "index-current.js"), "console.log('current');");
  await writeFile(path.join(docsDist, "index.html"), "<!doctype html><title>CyberOS docs</title>");
  await mkdir(path.join(docsDist, "architecture", "system-overview"), { recursive: true });
  await writeFile(path.join(docsDist, "architecture", "system-overview", "index.html"), "<title>System overview</title>");
  await writeFile(path.join(docsDist, "_astro", "docs-current.js"), "console.log('docs');");
  server = Fastify();
  await registerWebApp(server, webDist, docsDist);
});

afterEach(async () => {
  await server.close();
  await rm(webDist, { recursive: true, force: true });
  await rm(docsDist, { recursive: true, force: true });
});

describe("web static delivery", () => {
  it("always returns the current HTML shell instead of validating a stale deployment ETag", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/",
      headers: { accept: "text/html", "if-none-match": "W/\"stale-deployment\"" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("CyberOS current");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.etag).toBeUndefined();
    expect(response.headers["last-modified"]).toBeUndefined();
  });

  it("caches content-hashed assets and returns 404 for assets removed by a deployment", async () => {
    const current = await server.inject({ method: "GET", url: "/assets/index-current.js" });
    const stale = await server.inject({ method: "GET", url: "/assets/index-stale.js" });

    expect(current.statusCode).toBe(200);
    expect(current.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(stale.statusCode).toBe(404);
    expect(stale.headers["content-type"]).toContain("application/json");
    expect(stale.body).not.toContain("CyberOS current");
  });

  it("serves the HTML shell only for browser navigation requests", async () => {
    const navigation = await server.inject({
      method: "GET",
      url: "/workspace/files",
      headers: { accept: "text/html,application/xhtml+xml" }
    });
    const missingApi = await server.inject({
      method: "GET",
      url: "/api/missing",
      headers: { accept: "text/html" }
    });

    expect(navigation.statusCode).toBe(200);
    expect(navigation.body).toContain("CyberOS current");
    expect(navigation.headers["cache-control"]).toBe("no-store");
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.headers["content-type"]).toContain("application/json");
  });

  it("serves docs under a reserved prefix without falling back to the React shell", async () => {
    const redirect = await server.inject({ method: "GET", url: "/docs" });
    const home = await server.inject({ method: "GET", url: "/docs/" });
    const page = await server.inject({ method: "GET", url: "/docs/architecture/system-overview/" });
    const asset = await server.inject({ method: "GET", url: "/docs/_astro/docs-current.js" });
    const missing = await server.inject({ method: "GET", url: "/docs/missing/" });

    expect(redirect.statusCode).toBe(308);
    expect(redirect.headers.location).toBe("/docs/");
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain("CyberOS docs");
    expect(home.headers["cache-control"]).toBe("no-store");
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("System overview");
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain("CyberOS current");
  });
});
