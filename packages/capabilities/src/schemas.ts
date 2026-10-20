import type { JsonSchema } from "./contracts.js";

export const EMPTY_OBJECT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  properties: {},
  additionalProperties: false
});

export const GENERIC_OBJECT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: true
});

export const ROOT_PATH_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  properties: {
    rootId: { type: "string", minLength: 1, maxLength: 128 },
    path: { type: "string", maxLength: 4096, default: "." }
  },
  required: ["rootId"],
  additionalProperties: false
});

export const PAGINATION_PROPERTIES: Record<string, JsonSchema> = Object.freeze({
  cursor: { type: ["string", "null"], maxLength: 2048 },
  limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }
});

export function strictObject(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false
  };
}
