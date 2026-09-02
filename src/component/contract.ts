/**
 * Public contract of the Tinybird delivery component.
 *
 * Everything a host can send, receive or configure is declared here, once, and re-exported
 * by the client so hosts never import from `src/component`. Validators are the runtime
 * truth; the `Infer` types are derived from them so the two cannot drift.
 */
import { type Infer, v } from "convex/values";

/** Version of the envelope the component accepts. Bump only with a migration ticket. */
export const ENVELOPE_VERSION = 1 as const;

// ---------------------------------------------------------------------------- size bounds

/** Default per-event payload bound, in UTF-8 bytes of the canonical JSON. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 65_536;
/**
 * Absolute ceiling a host may raise the bound to. Keeps one event far below Convex's 1 MiB
 * document limit and Tinybird's per-request limits even after canonicalisation.
 */
export const HARD_MAX_PAYLOAD_BYTES = 524_288;
/** Event identity length bound; identities are host-provided opaque strings. */
export const MAX_EVENT_ID_LENGTH = 256;
/** Tinybird datasource names: letters, digits and underscores only. */
export const DATASOURCE_NAME_PATTERN = /^[A-Za-z0-9_]{1,128}$/;
/** How many earlier failures an event keeps alongside its newest one. */
export const MAX_ERROR_HISTORY = 5;

/** `health` never reads more than this many rows per state. */
export const COUNT_CAP = 1000;

// ---------------------------------------------------------------------------- request policy

/** Per-request deadline for one delivery attempt (`AbortSignal.timeout`). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** Hosts may tune the deadline only inside this range. */
export const REQUEST_TIMEOUT_RANGE_MS = { min: 1_000, max: 60_000 } as const;

/** Retry policy handed to the nested Workpool: attempts and exponential backoff. */
export const vRetryConfig = v.object({
  /** Total attempts including the first. */
  maxAttempts: v.number(),
  /** Backoff before the second attempt, in milliseconds. */
  initialBackoffMs: v.number(),
  /** Multiplier applied per attempt. */
  base: v.number(),
});
export type RetryConfig = Infer<typeof vRetryConfig>;

/** About four minutes of exponential backoff before an event dead-letters. */
export const DEFAULT_RETRY: RetryConfig = { maxAttempts: 8, initialBackoffMs: 1_000, base: 2 };
/** Bounds enforced on every retry policy, whether set per instance or per enqueue. */
export const RETRY_LIMITS = {
  maxAttempts: { min: 1, max: 20 },
  initialBackoffMs: { min: 100, max: 60_000 },
  base: { min: 1, max: 4 },
} as const;

// ---------------------------------------------------------------------------- states and errors

/**
 * Delivery state machine:
 * `pending → delivering → delivered | failed`, `failed → pending` by replay,
 * `delivering → pending` by stuck-requeue. A paused destination leaves events pending.
 */
export const vEventState = v.union(
  v.literal("pending"),
  v.literal("delivering"),
  v.literal("delivered"),
  v.literal("failed"),
);
export type EventState = Infer<typeof vEventState>;

/** Why a delivery attempt did not succeed. Terminal categories never retry. */
export const vFailureCategory = v.union(
  v.literal("invalid_request"),
  v.literal("quarantined"),
  v.literal("not_found"),
  v.literal("payload_too_large"),
  v.literal("unauthorized"),
  v.literal("rate_limited"),
  v.literal("server_error"),
  v.literal("timeout"),
  v.literal("network"),
  v.literal("exhausted"),
  v.literal("stuck"),
);
export type FailureCategory = Infer<typeof vFailureCategory>;

/** Sanitized: message ≤ 200 chars, never a response body, query string or token. */
export const vDeliveryError = v.object({
  category: vFailureCategory,
  httpStatus: v.optional(v.number()),
  message: v.string(),
  at: v.number(),
});
export type DeliveryError = Infer<typeof vDeliveryError>;

export const vPausedReason = v.union(
  v.literal("unauthorized"),
  v.literal("invalid_host"),
  v.literal("operator"),
);
export type PausedReason = Infer<typeof vPausedReason>;

export const vOperatorAction = v.object({
  kind: v.union(
    v.literal("pause"),
    v.literal("resume"),
    v.literal("replayFailed"),
    v.literal("replayEvent"),
  ),
  actor: v.optional(v.string()),
  at: v.number(),
  count: v.optional(v.number()),
});
export type OperatorAction = Infer<typeof vOperatorAction>;

/** `ConvexError` codes thrown by component functions. */
export const vErrorCode = v.union(
  v.literal("invalid_datasource"),
  v.literal("invalid_event_id"),
  v.literal("invalid_payload"),
  v.literal("payload_too_large"),
  v.literal("identity_conflict"),
  v.literal("invalid_retry"),
  v.literal("read_tokens_not_configured"),
);
export type ErrorCode = Infer<typeof vErrorCode>;

// ---------------------------------------------------------------------------- enqueue / status

/** Immutable identity of an event: unique per mounted instance. */
export const vEventIdentity = v.object({
  datasource: v.string(),
  eventId: v.string(),
});
export type EventIdentity = Infer<typeof vEventIdentity>;

export const vEnqueueArgs = v.object({
  datasource: v.string(),
  eventId: v.string(),
  /** A JSON object; canonicalised (sorted keys, no whitespace) before storage. */
  payload: v.any(),
  maxPayloadBytes: v.optional(v.number()),
  retry: v.optional(vRetryConfig),
});
export type EnqueueArgs = Infer<typeof vEnqueueArgs>;

export const vEnqueueResult = v.object({
  outcome: v.union(v.literal("enqueued"), v.literal("duplicate")),
  eventId: v.string(),
  state: vEventState,
});
export type EnqueueResult = Infer<typeof vEnqueueResult>;

export const vEventStatus = v.object({
  datasource: v.string(),
  eventId: v.string(),
  state: vEventState,
  attempts: v.number(),
  createdAt: v.number(),
  deliveredAt: v.optional(v.number()),
  lastError: v.optional(vDeliveryError),
  /**
   * Earlier failures, oldest first, capped at {@link MAX_ERROR_HISTORY}. Once a budget is
   * spent `lastError` reads `exhausted`, which says the attempts ran out but not why; the
   * history is where the actual reason lives.
   */
  previousErrors: v.optional(v.array(vDeliveryError)),
});
export type EventStatus = Infer<typeof vEventStatus>;

// ---------------------------------------------------------------------------- health

export const vBoundedCount = v.object({
  count: v.number(),
  /** True when `count` hit `COUNT_CAP` and the real number is at least that. */
  capped: v.boolean(),
});
export type BoundedCount = Infer<typeof vBoundedCount>;

/**
 * Delivery health for operators: configuration and pause state plus bounded backlog
 * counts. Never carries a payload, host or token.
 */
export const vHealth = v.object({
  /** Append token present and non-blank. */
  configured: v.boolean(),
  paused: v.boolean(),
  pausedReason: v.optional(vPausedReason),
  counts: v.object({
    pending: vBoundedCount,
    delivering: vBoundedCount,
    failed: vBoundedCount,
  }),
});
export type Health = Infer<typeof vHealth>;

// ---------------------------------------------------------------------------- client options

/** Host-side configuration of one `TinybirdDelivery` instance. */
export interface TinybirdDeliveryOptions {
  maxPayloadBytes?: number;
  requestTimeoutMs?: number;
  retry?: Partial<RetryConfig>;
}

export interface ResolvedTinybirdDeliveryOptions {
  maxPayloadBytes: number;
  requestTimeoutMs: number;
  retry: RetryConfig;
}

function assertRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`TinybirdDelivery: ${name} must be between ${min} and ${max}, got ${value}`);
  }
}

/** Returns the first out-of-range retry field, or null when the policy is acceptable. */
export function retryConfigViolation(retry: RetryConfig): string | null {
  for (const key of ["maxAttempts", "initialBackoffMs", "base"] as const) {
    const { min, max } = RETRY_LIMITS[key];
    const value = retry[key];
    if (!Number.isFinite(value) || value < min || value > max) {
      return `retry.${key} must be between ${min} and ${max}, got ${value}`;
    }
  }
  return null;
}

const SUPPORTED_OPTIONS = new Set(["maxPayloadBytes", "requestTimeoutMs", "retry"]);
const SUPPORTED_RETRY_OPTIONS = new Set(["maxAttempts", "initialBackoffMs", "base"]);

function assertOnlySupportedKeys(value: object, supported: Set<string>, prefix: string): void {
  for (const key of Object.keys(value)) {
    if (!supported.has(key)) {
      throw new Error(`TinybirdDelivery: unsupported option "${prefix}${key}"`);
    }
  }
}

/**
 * Validates eagerly so a misconfigured instance fails at construction, not at first enqueue.
 * Unknown keys are rejected too: configuration is explicit, never silently ignored.
 */
export function resolveTinybirdDeliveryOptions(
  options: TinybirdDeliveryOptions = {},
): ResolvedTinybirdDeliveryOptions {
  assertOnlySupportedKeys(options, SUPPORTED_OPTIONS, "");
  if (options.retry) assertOnlySupportedKeys(options.retry, SUPPORTED_RETRY_OPTIONS, "retry.");
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  assertRange("maxPayloadBytes", maxPayloadBytes, 1, HARD_MAX_PAYLOAD_BYTES);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  assertRange(
    "requestTimeoutMs",
    requestTimeoutMs,
    REQUEST_TIMEOUT_RANGE_MS.min,
    REQUEST_TIMEOUT_RANGE_MS.max,
  );
  const retry: RetryConfig = { ...DEFAULT_RETRY, ...options.retry };
  const violation = retryConfigViolation(retry);
  if (violation) throw new Error(`TinybirdDelivery: ${violation}`);
  return { maxPayloadBytes, requestTimeoutMs, retry };
}
