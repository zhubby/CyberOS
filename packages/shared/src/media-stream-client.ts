import { request } from "node:http";
import path from "node:path";
import type { CyberOsRuntime } from "./types.js";
import type { StreamSession } from "./media-stream.js";
export const mediaStreamerSocketPath = (
  config: Pick<CyberOsRuntime, "environment" | "paths">,
) =>
  config.environment === "production"
    ? "/run/cyberos/media-streamer.sock"
    : path.join(config.paths.stateDir, "media-streamer.sock");
export class MediaStreamError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}
export interface MediaStreamRuntime {
  command(
    method: "GET" | "POST" | "DELETE",
    route: string,
    body?: unknown,
  ): Promise<{ session?: StreamSession }>;
}
export function createMediaStreamRuntime(
  config: CyberOsRuntime,
): MediaStreamRuntime {
  return {
    command: (method, route, body) =>
      new Promise((resolve, reject) => {
        const serialized =
          body === undefined ? undefined : JSON.stringify(body);
        const req = request(
          {
            socketPath: mediaStreamerSocketPath(config),
            path: route,
            method,
            headers: serialized
              ? {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(serialized),
                }
              : {},
          },
          (res) => {
            let buffer = "";
            res.on("data", (data: Buffer) => {
              buffer += data.toString();
              if (buffer.length > 1024 * 1024)
                req.destroy(new Error("Stream response too large"));
            });
            res.once("error", reject);
            res.once("end", () => {
              try {
                const value = JSON.parse(buffer) as {
                  session?: StreamSession;
                  error?: string;
                };
                if ((res.statusCode ?? 500) >= 400)
                  reject(
                    new MediaStreamError(
                      value.error ?? "Media stream unavailable",
                      res.statusCode ?? 503,
                    ),
                  );
                else resolve(value);
              } catch (e) {
                reject(e);
              }
            });
          },
        );
        req.setTimeout(10000, () =>
          req.destroy(new Error("Media streamer timed out")),
        );
        req.once("error", () =>
          reject(
            new MediaStreamError("Media streaming service unavailable", 503),
          ),
        );
        req.end(serialized);
      }),
  };
}
