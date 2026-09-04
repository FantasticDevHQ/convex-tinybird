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
/**
 * A deterministic fingerprint of a canonical payload.
 *
 * FNV-1a, 32 bits, hex. Not cryptographic and not meant to be: it exists to detect an
 * ACCIDENTAL substitution — a host bug that flips a status or swaps an id — in the one
 * situation where the payload itself is gone and cannot be compared. Byte length alone
 * cannot do that job, because the field shapes that dominate real payloads are fixed width:
 * uuids, ISO-8601 timestamps, enum codes, booleans, zero-padded ids, numerics of the same
 * digit count. A same-length edit to any of those defeats a length check completely.
 *
 * Hashes UTF-16 code units, not UTF-8 bytes, which differs from `utf8Length` beside it. That
 * is self-consistent and therefore harmless — the same input always produces the same
 * fingerprint — but the two are measuring different domains, so they are never compared to
 * one another, only each against its own stored counterpart.
 *
 * Synchronous and dependency-free on purpose. `crypto.subtle` is async and its availability
 * inside a mutation is not something to rely on, and this runs on the enqueue path.
 */
export function payloadFingerprint(canonical: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    // The FNV prime, as shifts, because the direct multiply overflows a double.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

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
