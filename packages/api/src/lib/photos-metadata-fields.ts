import { Worker } from "node:worker_threads";
import type { PhotosMetadataField } from "@cyberos/shared";

export interface PhotosMetadataFieldsInput {
  libraryUpdatedAt: string;
  query?: string;
  limit?: number;
}

export type PhotosMetadataFieldsRequest =
  | { type: "query"; id: number; input: PhotosMetadataFieldsInput }
  | { type: "close" };

export type PhotosMetadataFieldsResponse =
  | { type: "result"; id: number; fields: PhotosMetadataField[] }
  | { type: "error"; id: number; message: string };

interface PendingQuery {
  id: number;
  key: string;
  input: PhotosMetadataFieldsInput;
  promise: Promise<PhotosMetadataField[]>;
  resolve: (fields: PhotosMetadataField[]) => void;
  reject: (error: Error) => void;
}

interface ReaderWorker {
  worker: Worker;
  exited: Promise<void>;
}

const MAX_PENDING_QUERIES = 32;

export class PhotosMetadataFieldsBusyError extends Error {
  readonly statusCode = 503;
  readonly expose = true;

  constructor() {
    super("Photo metadata field queries are busy; try again shortly");
  }
}

/** One read-only connection, with no results retained after a query finishes. */
export class PhotosMetadataFieldsReader {
  private readonly pending = new Map<string, PendingQuery>();
  private readonly queue: PendingQuery[] = [];
  private active: PendingQuery | undefined;
  private reader: ReaderWorker | undefined;
  private nextId = 0;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly databasePath: string,
    private readonly createWorker: (databasePath: string) => Worker = createFieldsWorker
  ) {}

  list(input: PhotosMetadataFieldsInput): Promise<PhotosMetadataField[]> {
    if (this.closed) return Promise.reject(new Error("Photo metadata reader is closed"));
    const normalized: PhotosMetadataFieldsInput = {
      libraryUpdatedAt: input.libraryUpdatedAt,
      query: input.query ?? "",
      limit: input.limit ?? 100
    };
    const key = JSON.stringify(normalized);
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    if (this.pending.size >= MAX_PENDING_QUERIES) return Promise.reject(new PhotosMetadataFieldsBusyError());

    let resolve!: PendingQuery["resolve"];
    let reject!: PendingQuery["reject"];
    const promise = new Promise<PhotosMetadataField[]>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const pending = { id: ++this.nextId, key, input: normalized, promise, resolve, reject };
    this.pending.set(key, pending);
    this.queue.push(pending);
    try {
      this.startWorker();
      this.dispatch();
    } catch (error) {
      this.rejectPending(asError(error));
    }
    return promise;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.rejectPending(new Error("Photo metadata reader is closed"));
    const reader = this.reader;
    // A close message runs after any synchronous SQLite query. Close the native
    // handle inside its owning thread before exit; forced termination during
    // native SQLite work can crash the API process.
    if (reader) reader.worker.postMessage({ type: "close" } satisfies PhotosMetadataFieldsRequest);
    this.closing = reader?.exited ?? Promise.resolve();
    return this.closing;
  }

  private startWorker(): void {
    if (this.reader) return;
    const worker = this.createWorker(this.databasePath);
    const reader = { worker, exited: new Promise<void>((resolve) => worker.once("exit", () => resolve())) };
    this.reader = reader;
    worker.on("message", (message: PhotosMetadataFieldsResponse) => {
      if (this.reader !== reader || this.closed || message.id !== this.active?.id) return;
      const pending = this.active;
      this.active = undefined;
      this.pending.delete(pending.key);
      if (message.type === "result") pending.resolve(message.fields);
      else pending.reject(new Error(message.message));
      this.dispatch();
    });
    worker.on("error", (error) => this.workerFailed(reader, error));
    worker.on("exit", (code) => this.workerFailed(reader,
      new Error(`Photo metadata reader exited unexpectedly (${code})`)));
  }

  private dispatch(): void {
    if (this.active || this.closed || !this.reader) return;
    this.active = this.queue.shift();
    if (!this.active) return;
    try {
      this.reader.worker.postMessage({
        type: "query", id: this.active.id, input: this.active.input
      } satisfies PhotosMetadataFieldsRequest);
    } catch (error) {
      this.workerFailed(this.reader, asError(error));
    }
  }

  private workerFailed(reader: ReaderWorker, error: Error): void {
    if (this.reader !== reader) return;
    this.reader = undefined;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.queue.length = 0;
    this.active = undefined;
  }
}

function createFieldsWorker(databasePath: string): Worker {
  if (import.meta.url.endsWith(".ts")) {
    // Node's TS stripping does not resolve this workspace's .js -> .ts imports.
    // Register tsx inside the development worker; packaged workers use plain JS.
    const bootstrap = `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};
      register(); await import(${JSON.stringify(new URL("./photos-metadata-fields-worker.ts", import.meta.url).href)});`;
    return new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), {
      workerData: { databasePath }, execArgv: []
    });
  }
  return new Worker(new URL("./lib/photos-metadata-fields-worker.js", import.meta.url), {
    workerData: { databasePath }, execArgv: []
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
