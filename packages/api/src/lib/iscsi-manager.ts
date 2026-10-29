import { isIP } from "node:net";
import { parseIscsiAction, type IscsiAction, type IscsiSummary } from "@cyberos/shared";
import { HostdClient, HostdRequestError } from "./hostd-client.js";

export interface IscsiRuntime {
  read(): Promise<IscsiSummary>;
  mutate(input: IscsiAction): Promise<IscsiSummary>;
}

export class HostdIscsiRuntime implements IscsiRuntime {
  private readonly client: HostdClient;
  constructor(socketPath: string) { this.client = new HostdClient(socketPath); }
  read(): Promise<IscsiSummary> { return this.client.request("iscsi.manager", { action: "read" }, 15_000); }
  mutate(input: IscsiAction): Promise<IscsiSummary> {
    return this.client.request("iscsi.manager", input, 120_000);
  }
}

export function validateIscsiAction(value: unknown): IscsiAction | null {
  const input = parseIscsiAction(value);
  if (!input) return null;
  if (input.action === "create_target" || input.action === "update_target") {
    if (!isIP(input.address) || ["0.0.0.0", "::", "::0"].includes(input.address)) return null;
  }
  return input;
}

/** Expose only controlled messages: host command errors may contain CHAP credentials. */
export function publicIscsiError(error: unknown): { status: number; code: string; message: string } {
  if (!(error instanceof HostdRequestError)) return { status: 503, code: "unavailable", message: "iSCSI management is unavailable" };
  const messages: Record<string, string> = {
    conflict: "iSCSI configuration changed or the target has active sessions; refresh and disconnect clients before retrying",
    validation: "Invalid iSCSI configuration; check the fields and confirmation",
    validation_error: "Invalid iSCSI configuration; check the fields and confirmation",
    not_found: "The iSCSI target or image is no longer available",
    unavailable: "iSCSI management is unavailable on this host",
    timeout: "iSCSI operation timed out; refresh its status before retrying",
    insufficient_space: "The storage pool has insufficient free space",
    operation_failed: "iSCSI operation failed; refresh its status before retrying"
  };
  const operationalMessages = new Set([
    "Storage pool has insufficient free space", "Disconnect active iSCSI clients first",
    "Storage pool is not mounted with a supported filesystem", "Listen address is no longer available",
    "iSCSI configuration changed; refresh before saving", "Image is already attached to a Target",
    "Target name already exists", "Target has reached its LUN limit", "Detach the image before destroying it",
    "iSCSI requires a root-owned protected .cyberos directory",
    "iSCSI internal directory protection is unavailable",
    "Filesystem cannot protect iSCSI internal directory entries",
    "Reapply ancestor NFS exports with root squashing before using iSCSI images"
  ]);
  return {
    status: error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 502,
    code: error.code,
    message: operationalMessages.has(error.message) ? error.message
      : messages[error.code] ?? "iSCSI operation failed; refresh its status before retrying"
  };
}
