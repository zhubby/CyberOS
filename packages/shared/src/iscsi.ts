/** Public iSCSI management contract. Secrets are accepted only in mutations. */
export interface IscsiChapInput {
  enabled: boolean;
  username: string;
  password?: string;
}

export interface IscsiTargetInput {
  name: string;
  address: string;
  port: number;
  initiators: string[];
  chap: IscsiChapInput;
}

interface IscsiMutationBase {
  confirmed: boolean;
  expectedRevision: string;
}

export type IscsiAction = IscsiMutationBase & (
  | ({ action: "create_target"; enabled: boolean } & IscsiTargetInput)
  | ({ action: "update_target"; targetId: string } & IscsiTargetInput)
  | { action: "set_target_enabled"; targetId: string; enabled: boolean }
  | { action: "delete_target"; targetId: string; destroyImages: boolean; confirmation?: string }
  | { action: "create_lun"; targetId: string; name: string; storagePoolId: string; sizeBytes: number }
  | { action: "attach_lun"; targetId: string; imageId: string }
  | { action: "detach_lun"; targetId: string; imageId: string; destroyImage: boolean; confirmation?: string }
  | { action: "destroy_image"; imageId: string; confirmation: string }
);

export interface IscsiImage {
  id: string;
  name: string;
  storagePoolId: string;
  sizeBytes: number;
  attachedTargetId: string | null;
}

export interface IscsiTarget {
  id: string;
  name: string;
  iqn: string;
  address: string;
  port: number;
  enabled: boolean;
  chapEnabled: boolean;
  chapUsername: string | null;
  credentialConfigured: boolean;
  initiators: string[];
  status: "running" | "disabled" | "degraded";
  error: string | null;
  luns: { imageId: string; lun: number }[];
  sessions: { initiator: string; address: string | null }[];
}

export interface IscsiSummary {
  collectedAt: string;
  revision: string;
  available: boolean;
  error: string | null;
  listenAddresses: string[];
  pools: { id: string; name: string; availableBytes: number | null; ready: boolean }[];
  targets: IscsiTarget[];
  images: IscsiImage[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REVISION = /^[0-9a-f]{64}$/u;
const IQN = /^iqn\.\d{4}-(?:0[1-9]|1[0-2])\.[a-z0-9][a-z0-9.-]*(?::[a-z0-9._:-]+)?$/u;
const GIB = 1024 ** 3;

/** Reject extra fields so credentials cannot accidentally cross the public boundary. */
export function parseIscsiSummary(value: unknown): IscsiSummary | null {
  if (!exact(value, ["collectedAt", "revision", "available", "error", "listenAddresses", "pools", "targets", "images"])) return null;
  if (!text(value.collectedAt) || !Number.isFinite(Date.parse(value.collectedAt)) || !matches(value.revision, REVISION)
    || typeof value.available !== "boolean" || !nullableText(value.error)
    || !arrayOf(value.listenAddresses, text) || !arrayOf(value.pools, isPool)
    || !arrayOf(value.targets, isTarget) || !arrayOf(value.images, isImage)) return null;
  return value as unknown as IscsiSummary;
}

/** Shared shape validation; hostd additionally verifies live addresses, mounts and sessions. */
export function parseIscsiAction(value: unknown): IscsiAction | null {
  if (!record(value) || value.confirmed !== true || !matches(value.expectedRevision, REVISION)) return null;
  const base = ["action", "confirmed", "expectedRevision"];
  const target = ["name", "address", "port", "initiators", "chap"];
  let valid = false;
  switch (value.action) {
    case "create_target":
      valid = exact(value, [...base, ...target, "enabled"]) && typeof value.enabled === "boolean" && targetInput(value)
        && (!record(value.chap) || value.chap.enabled !== true || text(value.chap.password));
      break;
    case "update_target":
      valid = exact(value, [...base, ...target, "targetId"]) && matches(value.targetId, UUID) && targetInput(value);
      break;
    case "set_target_enabled":
      valid = exact(value, [...base, "targetId", "enabled"]) && matches(value.targetId, UUID) && typeof value.enabled === "boolean";
      break;
    case "delete_target":
      valid = exact(value, [...base, "targetId", "destroyImages"], ["confirmation"])
        && matches(value.targetId, UUID) && typeof value.destroyImages === "boolean" && confirmation(value, value.destroyImages);
      break;
    case "create_lun":
      valid = exact(value, [...base, "targetId", "name", "storagePoolId", "sizeBytes"])
        && matches(value.targetId, UUID) && name(value.name) && poolId(value.storagePoolId) && capacity(value.sizeBytes);
      break;
    case "attach_lun":
      valid = exact(value, [...base, "targetId", "imageId"]) && matches(value.targetId, UUID) && matches(value.imageId, UUID);
      break;
    case "detach_lun":
      valid = exact(value, [...base, "targetId", "imageId", "destroyImage"], ["confirmation"])
        && matches(value.targetId, UUID) && matches(value.imageId, UUID)
        && typeof value.destroyImage === "boolean" && confirmation(value, value.destroyImage);
      break;
    case "destroy_image":
      valid = exact(value, [...base, "imageId", "confirmation"]) && matches(value.imageId, UUID) && name(value.confirmation);
      break;
  }
  return valid ? value as unknown as IscsiAction : null;
}

function targetInput(value: Record<string, unknown>): boolean {
  return name(value.name) && text(value.address) && value.address.length <= 45 && integer(value.port, 1, 65535)
    && arrayOf(value.initiators, iqn) && value.initiators.length > 0 && value.initiators.length <= 64
    && new Set(value.initiators).size === value.initiators.length && chapInput(value.chap);
}

function chapInput(value: unknown): boolean {
  if (!exact(value, ["enabled", "username"], ["password"]) || typeof value.enabled !== "boolean" || typeof value.username !== "string") return false;
  if (value.enabled && !/^[\x21-\x7e]{1,128}$/u.test(value.username)) return false;
  return value.password === undefined || (typeof value.password === "string" && /^[\x20-\x7e]{12,16}$/u.test(value.password));
}

function confirmation(value: Record<string, unknown>, required: boolean): boolean {
  return required ? name(value.confirmation) : value.confirmation === undefined || name(value.confirmation);
}

function isPool(value: unknown): boolean {
  return exact(value, ["id", "name", "availableBytes", "ready"]) && poolId(value.id) && text(value.name)
    && (value.availableBytes === null || integer(value.availableBytes, 0)) && typeof value.ready === "boolean";
}

function isImage(value: unknown): boolean {
  return exact(value, ["id", "name", "storagePoolId", "sizeBytes", "attachedTargetId"])
    && matches(value.id, UUID) && name(value.name) && poolId(value.storagePoolId) && capacity(value.sizeBytes)
    && (value.attachedTargetId === null || matches(value.attachedTargetId, UUID));
}

function isTarget(value: unknown): boolean {
  return exact(value, ["id", "name", "iqn", "address", "port", "enabled", "chapEnabled", "chapUsername",
    "credentialConfigured", "initiators", "status", "error", "luns", "sessions"])
    && matches(value.id, UUID) && name(value.name) && iqn(value.iqn) && text(value.address) && integer(value.port, 1, 65535)
    && typeof value.enabled === "boolean" && typeof value.chapEnabled === "boolean" && nullableText(value.chapUsername)
    && typeof value.credentialConfigured === "boolean" && arrayOf(value.initiators, iqn)
    && ["running", "disabled", "degraded"].includes(String(value.status)) && nullableText(value.error)
    && arrayOf(value.luns, (lun) => exact(lun, ["imageId", "lun"]) && matches(lun.imageId, UUID) && integer(lun.lun, 0, 255))
    && arrayOf(value.sessions, (session) => exact(session, ["initiator", "address"]) && iqn(session.initiator) && nullableText(session.address));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: string[], optional: string[] = []): value is Record<string, unknown> {
  return record(value) && keys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => keys.includes(key) || optional.includes(key));
}

function arrayOf<T>(value: unknown, check: (item: unknown) => item is T): value is T[];
function arrayOf(value: unknown, check: (item: unknown) => boolean): value is unknown[];
function arrayOf(value: unknown, check: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(check);
}

function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function nullableText(value: unknown): value is string | null { return value === null || typeof value === "string"; }
function matches(value: unknown, pattern: RegExp): value is string { return typeof value === "string" && pattern.test(value); }
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function name(value: unknown): value is string {
  return text(value) && value === value.trim() && value.length <= 64
    && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}
function poolId(value: unknown): value is string { return matches(value, /^[a-z][a-z0-9_-]{0,31}$/u); }
function iqn(value: unknown): value is string { return text(value) && value.length <= 223 && IQN.test(value); }
function capacity(value: unknown): value is number { return integer(value, GIB) && value % GIB === 0; }
