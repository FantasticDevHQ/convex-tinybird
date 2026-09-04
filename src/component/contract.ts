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
/**
 * How many dead letters one `replayFailed` call returns to the queue by default.
 *
 * Sized from bytes when the payload still lived on the event row, where a batch of `n` cost
 * `3n + 1` passes over rows of `payload + ~2 KB` and 100 rows came to roughly 19 MiB against
 * Convex's ~8 MiB per-call limit. FTD-2525 moved the payload to its own table, so a row is
 * now about 2 KB whatever the event carries, and the same batch of 30 costs under 200 KB.
 *
 * These values are therefore CONSERVATIVE rather than binding, and deliberately unchanged
 * by that move: raising them is a behaviour change that deserves its own tests rather than
 * a side effect of a storage change. What now binds first is Convex's document-scan limit,
 * not bytes. See FTD-2529.
 */
export const DEFAULT_REPLAY_LIMIT = 20;

/**
 * The largest batch `replayFailed` will accept, however it is called.
 *
 * Separate from the default on purpose: a single clamp to the default would mean a host
 * could never ask for more than the conservative number chosen for everyone else, so the
 * safe default would silently become a ceiling.
 */
export const MAX_REPLAY_LIMIT = 30;

/**
 * Turns a caller-supplied batch size into one `.take()` will accept.
 *
 * Shared by every bounded operator loop so they cannot drift apart. `.take()` rejects
 * anything that is not a non-negative integer with a bare `TypeError` rather than one of
 * this component's coded errors, and a host that computed its limit from a division, a
 * config value or a subtraction has no reason to expect that shape. `NaN` is the case worth
 * naming: it survives `Math.trunc`, `Math.min` and `Math.max` unchanged, so clamping alone
 * does not stop it — every comparison against it is false.
 */
export function boundedBatch(limit: number | undefined, fallback: number, max: number): number {
  const requested = limit !== undefined && Number.isFinite(limit) ? Math.trunc(limit) : fallback;
  return Math.max(1, Math.min(requested, max));
}

/** How many waiting events one `resume` call puts back to work. */
export const DEFAULT_RESUME_LIMIT = 100;

/** How many earlier failures an event keeps alongside its newest one. */
export const MAX_ERROR_HISTORY = 5;

/**
 * How many rows per state `health` will count before answering "at least this many".
 *
 * Sized from a MEASURED row, not an estimated one. `healthcost.test.ts` builds the largest
 * event the contract permits — every string at its documented maximum, every optional field
 * present — and it comes to about 2.4 KB. `health` counts three states and reads one row
 * past the cap in each, so the worst call is `3 x (cap + 1) x 2.4 KB` against Convex's
 * roughly 8 MiB per-call budget:
 *
 * | cap | worst call | share of budget |
 * |---|---|---|
 * | 1000 | 7.0 MiB | 88% |
 * | 500 | 3.5 MiB | 44% |
 * | 250 | 1.8 MiB | 22% |
 *
 * A thousand rows was 88% of the budget, and that shape is not pathological: a sustained
 * outage produces exactly a thousand failed events each carrying a full failure history, so
 * the worst case and the case an operator reaches for `health` in are the same case.
 *
 * This was unreachable before FTD-2525. The payload used to sit on the event row, so a call
 * died on bytes at roughly 130 events and the cap never came into play. Removing the payload
 * fixed that and made the cap the thing that binds.
 *
 * **Why lower the cap rather than change the mechanism.** Two alternatives were considered.
 * Counting one state per call would make the host ask three times, moving the cost rather
 * than removing it and changing the API for every caller. Maintained counters on the
 * settings row would make a count one document, but every transition would then write to
 * that single row, trading a read bound for write contention on the hot path — a worse
 * trade for a component whose whole job is ingest. Lowering the cap costs only precision in
 * an answer that is already deliberately imprecise: `capped: true` means "more than this",
 * and an operator acts the same on 250 as on 1000. `oldestPendingAgeMs` from `heartbeat`
 * tells them the severity, and it reads two documents whatever the backlog.
 */
export const COUNT_CAP = 250;

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
  /**
   * The event exists but its payload row does not, so there is nothing to send.
   *
   * Distinct from `not_found`, which means Tinybird answered 404. This one never involves a
   * request: it is a storage fault, and the only thing that can cause it is something having
   * deleted one of the two rows without the other. Nothing in the component does that today.
   */
  v.literal("payload_missing"),
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
  v.literal("invalid_request_timeout"),
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
  /** Per-request deadline. Stored with the event so delivery honours the caller's setting. */
  requestTimeoutMs: v.optional(v.number()),
});
export type EnqueueArgs = Infer<typeof vEnqueueArgs>;

export const vEnqueueResult = v.object({
  /**
   * `repaired` means the event already existed but its payload row did not, and this call
   * restored it and put the event back to work.
   *
   * It is a distinct outcome rather than `enqueued` because nothing new was created, and
   * rather than `duplicate` because something did happen. A host that sees it has just
   * healed a `payload_missing` dead letter, which is worth surfacing: it means something had
   * previously deleted one of the two rows without the other.
   */
  outcome: v.union(v.literal("enqueued"), v.literal("duplicate"), v.literal("repaired")),
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
/**
 * The signals that cost one row each, whatever an event weighs.
 *
 * Separate from {@link vHealth} on purpose: the counted scans in `health` read whole event
 * rows, so on a backlog of large events that query can exceed Convex's read limit and fail.
 * These are the two things an operator alerts on, and they have to stay reachable on exactly
 * the day the counts do not.
 */
export const vHeartbeat = v.object({
  configured: v.boolean(),
  paused: v.boolean(),
  pausedReason: v.optional(vPausedReason),
  oldestPendingAgeMs: v.union(v.number(), v.null()),
  lastDeliveredAt: v.optional(v.number()),
  lastError: v.optional(vDeliveryError),
  lastOperatorAction: v.optional(vOperatorAction),
});
export type Heartbeat = Infer<typeof vHeartbeat>;

export const vHealth = v.object({
  /** Append token present and non-blank. */
  configured: v.boolean(),
  paused: v.boolean(),
  pausedReason: v.optional(vPausedReason),
  /**
   * Counts of work that is not finished. `delivered` is deliberately absent: it is bounded
   * by retention rather than by this query, so counting it would make health cost grow with
   * throughput, and it answers no operational question that `lastDeliveredAt` does not.
   */
  counts: v.object({
    pending: vBoundedCount,
    delivering: vBoundedCount,
    failed: vBoundedCount,
  }),
  /** How long the oldest waiting event has waited, or null when nothing is waiting. */
  oldestPendingAgeMs: v.union(v.number(), v.null()),
  lastDeliveredAt: v.optional(v.number()),
  /** Newest failure, sanitized. Never a response body, a host or a token. */
  lastError: v.optional(vDeliveryError),
  lastOperatorAction: v.optional(vOperatorAction),
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
