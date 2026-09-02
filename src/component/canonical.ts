import { ConvexError } from "convex/values";

/** Deepest object/array nesting accepted. Deeper payloads are almost always a bug. */
export const MAX_PAYLOAD_DEPTH = 32;

function invalid(reason: string): ConvexError<{ code: "invalid_payload"; reason: string }> {
  return new ConvexError({ code: "invalid_payload" as const, reason });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encode(value: unknown, path: string, depth: number): string {
  if (depth > MAX_PAYLOAD_DEPTH) {
    throw invalid(`${path}: nesting deeper than ${MAX_PAYLOAD_DEPTH} levels`);
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw invalid(`${path}: non-finite number`);
      return JSON.stringify(value);
    case "undefined":
      throw invalid(`${path}: undefined is not JSON`);
    case "bigint":
      throw invalid(`${path}: bigint is not JSON`);
    case "function":
    case "symbol":
      throw invalid(`${path}: ${typeof value} is not JSON`);
    case "object":
      break;
  }
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => encode(item, `${path}[${index}]`, depth + 1)).join(",")}]`;
  }
  if (!isPlainObject(value)) throw invalid(`${path}: only plain objects are JSON`);
  const keys = Object.keys(value).sort();
  const members = keys.map(
    (key) => `${JSON.stringify(key)}:${encode(value[key], `${path}.${key}`, depth + 1)}`,
  );
  return `{${members.join(",")}}`;
}

/**
 * Serialises a JSON object deterministically: keys sorted recursively, no whitespace, arrays in
 * order. Two payloads with the same canonical form are the same event for dedupe purposes.
 * Throws `ConvexError({ code: "invalid_payload", reason })` for anything JSON cannot carry.
 */
export function canonicalJson(payload: unknown): string {
  if (!isPlainObject(payload)) {
    throw invalid("payload must be a JSON object (a Tinybird row), not an array or primitive");
  }
  return encode(payload, "payload", 0);
}

const encoder = new TextEncoder();

/** UTF-8 byte length, which is what Tinybird and Convex limits are measured in. */
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}
