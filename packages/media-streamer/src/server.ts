import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { connect } from "node:net";
import { Readable } from "node:stream";
import { StreamError, type StreamManager } from "./manager.js";

export async function startStreamServer(
  manager: StreamManager,
  socketPath: string,
) {
  await mkdir(path.dirname(socketPath), { recursive: true });
  try {
    if (!(await lstat(socketPath)).isSocket())
      throw new Error("Stream socket path is occupied");
    const active = await new Promise<boolean>((resolve, reject) => {
      const s = connect(socketPath);
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", (e: NodeJS.ErrnoException) =>
        ["ECONNREFUSED", "ENOENT"].includes(e.code ?? "")
          ? resolve(false)
          : reject(e),
      );
    });
    if (active) throw new Error("Another media streamer is running");
    await unlink(socketPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await manager.initialize();
  const server = createServer((request, response) => {
    void handle(manager, request, response);
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o660);
  const original = await lstat(socketPath);
  return async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.shutdown();
    const current = await lstat(socketPath).catch(() => null);
    if (current?.ino === original.ino && current.dev === original.dev)
      await unlink(socketPath);
  };
}
async function handle(
  manager: StreamManager,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const json = (value: unknown, status = 200) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  try {
    const parts = (req.url ?? "").split("/").filter(Boolean);
    if (req.method === "POST" && req.url === "/sessions") {
      let body = "";
      for await (const data of req) {
        body += String(data);
        if (body.length > 16384)
          throw new StreamError("Stream request too large", 413);
      }
      return json({ session: manager.create(JSON.parse(body)) }, 201);
    }
    const id = parts[1];
    if (parts[0] !== "sessions" || !id || !/^[a-f0-9-]{36}$/.test(id))
      throw new StreamError("Not found", 404);
    if (req.method === "DELETE" && parts.length === 2) {
      await manager.remove(id);
      return json({ closed: true });
    }
    if (req.method === "GET" && parts.length === 2)
      return json({ session: await manager.get(id) });
    if (req.method !== "GET" || parts.length !== 4 || parts[2] !== "assets")
      throw new StreamError("Not found", 404);
    const asset = await manager.asset(id, parts[3]!);
    let start = 0;
    let end = asset.size - 1;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        if (asset.close) await asset.file.close();
        return json({ error: "Invalid range" }, 416);
      }
      if (!match[1]) start = Math.max(0, asset.size - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= asset.size
      ) {
        if (asset.close) await asset.file.close();
        res.setHeader("Content-Range", `bytes */${asset.size}`);
        return json({ error: "Range unavailable" }, 416);
      }
    }
    res.writeHead(range ? 206 : 200, {
      "content-type": asset.mime,
      "content-length": end - start + 1,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      ...(range
        ? { "content-range": `bytes ${start}-${end}/${asset.size}` }
        : {}),
    });
    // FileHandle read streams close their handle on destroy even with autoClose
    // disabled. Direct responses share the session handle, so read at explicit
    // offsets without transferring ownership to a request's stream.
    const stream = Readable.from(
      (async function* () {
        for (let position = start; position <= end; ) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, end - position + 1));
          const { bytesRead } = await asset.file.read(
            chunk,
            0,
            chunk.length,
            position,
          );
          if (!bytesRead) break;
          position += bytesRead;
          yield chunk.subarray(0, bytesRead);
        }
      })(),
      { objectMode: false },
    );
    stream.once("error", () => res.destroy());
    res.once("close", () => {
      stream.destroy();
      if (asset.close) void asset.file.close().catch(() => {});
    });
    stream.pipe(res);
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    json(
      {
        error:
          error instanceof StreamError
            ? error.message
            : "Media stream unavailable",
      },
      error instanceof StreamError ? error.statusCode : 503,
    );
  }
}
