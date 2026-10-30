import { parentPort, workerData } from "node:worker_threads";
import { listPhotosMetadataFields, openCyberOsDbReadOnly } from "@cyberos/db";
import type { PhotosMetadataFieldsRequest, PhotosMetadataFieldsResponse } from "./photos-metadata-fields.js";

if (!parentPort) throw new Error("Photo metadata reader requires a worker thread");
const port = parentPort;
const { databasePath } = workerData as { databasePath: string };
const db = openCyberOsDbReadOnly(databasePath);

port.on("message", (request: PhotosMetadataFieldsRequest) => {
  if (request.type === "close") {
    db.close();
    port.close();
    return;
  }
  let response: PhotosMetadataFieldsResponse;
  try {
    response = { type: "result", id: request.id, fields: listPhotosMetadataFields(db, request.input) };
  } catch (error) {
    response = { type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(response);
});
