import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer, connect, type AddressInfo, type Server, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { ProxyHttpClient } from "./proxy-http.js";
import type { SystemProxySettingsRecord } from "@cyberos/shared";

// Public test-only certificate and private key. Never used by runtime services.
const cert = readFileSync(new URL("../../../shared/test-fixtures/proxy/test-cert.pem", import.meta.url), "utf8");
const key = readFileSync(new URL("../../../shared/test-fixtures/proxy/test-key.pem", import.meta.url), "utf8");
const ca = readFileSync(new URL("../../../shared/test-fixtures/proxy/test-ca.pem", import.meta.url), "utf8");
const servers: Server[] = [];
const sockets = new Set<Socket>();
const clients: ProxyHttpClient[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on("connection", (socket: Socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("explicit outbound proxy", () => {
  it.each(["http", "https", "socks5"] as const)("forwards HTTPS through %s with proxy-side DNS", async (protocol) => {
    const origin = await listen(createHttpsServer({ key, cert }, (req, res) => res.end(`received ${req.url}`)));
    const destinations: string[] = [];
    const tunnel = (socket: Socket, initial: Buffer) => {
      const upstream = connect(origin, "127.0.0.1", () => { if (initial.length) upstream.write(initial); socket.pipe(upstream).pipe(socket); });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    };
    let port: number;
    if (protocol === "socks5") {
      port = await listen(createTcpServer((socket) => {
        let buffer = Buffer.alloc(0);
        let greeted = false;
        const receive = (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (!greeted) {
            if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
            buffer = buffer.subarray(2 + buffer[1]!);
            socket.write(Buffer.from([5, 0]));
            greeted = true;
          }
          if (buffer.length < 5) return;
          expect(buffer[3]).toBe(3); // Hostname, rather than locally resolved IP.
          const length = buffer[4]!;
          if (buffer.length < 7 + length) return;
          destinations.push(`${buffer.subarray(5, 5 + length).toString()}:${buffer.readUInt16BE(5 + length)}`);
          socket.off("data", receive);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          tunnel(socket, buffer.subarray(7 + length));
        };
        socket.on("data", receive);
      }));
    } else {
      const proxy = protocol === "https" ? createHttpsServer({ key, cert }) : createHttpServer();
      proxy.on("connect", (req, socket, head) => {
        destinations.push(req.url!);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        tunnel(socket as Socket, head);
      });
      port = await listen(proxy);
    }
    const client = new ProxyHttpClient(() => ({ protocol, host: "127.0.0.1", port, updatedAt: "test" }), { ca });
    clients.push(client);
    const response = await client.fetch("https://api.themoviedb.org/proxy-test", { signal: AbortSignal.timeout(3000) });
    expect(await response.text()).toBe("received /proxy-test");
    expect(destinations).toEqual(["api.themoviedb.org:443"]);
  });

  it("uses new settings on subsequent requests, rejects redirects and never falls back to direct", async () => {
    const port = await listen(createHttpServer((req, res) => {
      if (req.url === "/redirect") res.writeHead(302, { location: "http://example.invalid/" });
      res.end("direct");
    }));
    let proxy: SystemProxySettingsRecord | null = null;
    const client = new ProxyHttpClient(() => proxy);
    clients.push(client);
    expect(await (await client.fetch(`http://127.0.0.1:${port}`)).text()).toBe("direct");
    proxy = { protocol: "http", host: "127.0.0.1", port: 1, updatedAt: "test" };
    await expect(client.fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    proxy = null;
    await expect(client.fetch(`http://127.0.0.1:${port}/redirect`)).rejects.toThrow(/redirect/iu);
    expect(await (await client.fetch(`http://127.0.0.1:${port}`)).text()).toBe("direct");
  });

  it("times out when the proxy does not complete the tunnel", async () => {
    const proxy = createHttpServer();
    proxy.on("connect", () => undefined);
    const port = await listen(proxy);
    const client = new ProxyHttpClient(() => ({ protocol: "http", host: "127.0.0.1", port, updatedAt: "test" }));
    clients.push(client);
    await expect(client.fetch("https://api.themoviedb.org/", { signal: AbortSignal.timeout(50) })).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
