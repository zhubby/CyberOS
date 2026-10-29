import http from "node:http";
import { describe, expect, it } from "vitest";
import { createSecureMcpFetch, validateMcpEndpoint, type McpAddressResolver } from "./mcp-network.js";

describe("MCP network policy", () => {
  it("blocks metadata, link-local, and public plaintext endpoints", async () => {
    await expect(validateMcpEndpoint("https://metadata.google.internal/mcp", false)).rejects.toThrow(/blocked/u);
    await expect(validateMcpEndpoint("http://169.254.169.254/latest", true)).rejects.toThrow(/blocked/u);
    await expect(validateMcpEndpoint("http://8.8.8.8/mcp", true)).rejects.toThrow(/HTTPS/u);
  });

  it("allows confirmed private HTTP and public HTTPS", async () => {
    await expect(validateMcpEndpoint("http://192.168.1.20/mcp", true)).resolves.toMatchObject({
      addressClasses: ["private"]
    });
    await expect(validateMcpEndpoint("https://203.0.113.20/mcp", false)).rejects.toThrow(/blocked/u);
    await expect(validateMcpEndpoint("https://8.8.8.8/mcp", false)).resolves.toMatchObject({
      addressClasses: ["public"]
    });
  });

  it("rejects DNS address changes between validation and connection", async () => {
    let calls = 0;
    const resolve: McpAddressResolver = async () => {
      calls += 1;
      return calls === 1
        ? [{ address: "127.0.0.1", family: 4 }]
        : [{ address: "10.0.0.9", family: 4 }];
    };
    const network = await createSecureMcpFetch("http://mcp.internal:65534/mcp", true, resolve);
    try {
      const error = await network.fetch("http://mcp.internal:65534/mcp", { method: "POST" })
        .then(() => null, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error & { cause?: Error }).cause?.message ?? error)).toMatch(/DNS resolution changed/u);
    } finally {
      await network.close();
    }
  });

  it("rejects requests that leave the configured origin", async () => {
    const network = await createSecureMcpFetch("http://127.0.0.1:65534/mcp", true);
    try {
      await expect(network.fetch("http://127.0.0.1:65533/mcp")).rejects.toThrow(/configured server origin/u);
    } finally {
      await network.close();
    }
  });

  it("rejects redirects even when they remain on the configured origin", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(302, { location: "/other" });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port");
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const network = await createSecureMcpFetch(url, true);
    try {
      await expect(network.fetch(url)).rejects.toThrow(/redirects are not allowed/u);
    } finally {
      await network.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
