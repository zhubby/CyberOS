import { SHARE_PROTOCOLS, type ShareProtocol } from "./types.js";

export function isShareProtocol(value: unknown): value is ShareProtocol {
  return typeof value === "string" && SHARE_PROTOCOLS.includes(value as ShareProtocol);
}
