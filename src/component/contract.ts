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
/** Event identity UTF-8 byte bound; identities are host-provided opaque strings. */
export const MAX_EVENT_ID_LENGTH = 256;
/** Longest Tinybird datasource name this component accepts. */
export const MAX_DATASOURCE_NAME_LENGTH = 128;

/**
 * Tinybird datasource names: letters, digits and underscores only.
 *
 * Built from {@link MAX_DATASOURCE_NAME_LENGTH} rather than repeating it, so a test that
 * needs the longest legal name derives it from the bound instead of from a literal that
 * happens to agree with the bound today.
 */
export const DATASOURCE_NAME_PATTERN = new RegExp(
  `^[A-Za-z0-9_]{1,${MAX_DATASOURCE_NAME_LENGTH}}$`,
  "u",
);
/**
 * How many dead letters one `replayFailed` call returns to the queue by default.
 *
 * Sized from bytes when the payload still lived on the event row, where a batch of `n` cost
 * `3n + 1` passes over rows of `payload + ~2 KB` and 100 rows came to roughly 19 MiB against
 * Convex's ~8 MiB per-call limit. FTD-2525 moved the payload to its own table, so a row is
 * now independent of the event's size, and the same batch of 30 costs well under a megabyte
 * rather than the 5.9 MiB it did — about 490 KB at the row's documented worst case.
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
 * How many rows per state `health` counts before answering "at least this many".
 *
 * `healthcost.test.ts` measures 2587 bytes for a maximally populated event row:
 * a 256-byte event id, six 200-byte errors, the indexed error category, and all optional fields.
 * The caps count UTF-8 bytes, so multibyte strings cost no more than ASCII at the bound.
 * The payload lives separately and does not contribute to health reads.
 *
 * Three state counts each read cap + 1 rows. Scoped health reads three more documents:
 * global settings, datasource settings and the oldest waiting event. Thus the conservative cost is
 * `(3 * (cap + 1) + 3) * 2587` bytes against an 8 MiB read budget.
 * Target roughly 30% of that budget and round down to 320 rows per state:
 *
 * | cap | worst call | share of budget |
 * |---|---|---|
 * | 150 | 1.13 MiB | 14.0% |
 * | 320 | 2.38 MiB | 29.8% |
 * | 1000 | 7.42 MiB | 92.7% |
 *
 * The test pins the row size and the documented share independently of the unchanged
 * 35% safety ceiling. Its JSON measurement slightly overestimates Convex storage for
 * this fixture; all optional fields are included even when their combination is unreachable.
 *
 * Capped indexed counts avoid writing a shared counter on every ingest transition.
 * `heartbeat` reads just two documents regardless of backlog and remains the polling API.
 */
export const COUNT_CAP = 320;

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

/** Sanitized: message ≤ 200 UTF-8 bytes, never a response body, query string or token. */
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
    v.literal("cleanup"),
    v.literal("requeueStuck"),
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
  v.literal("category_index_not_ready"),
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
  /** When a retention sweep last ran, deleting anything or not. Absent until one has. */
  lastCleanupAt: v.optional(v.number()),
});
export type Heartbeat = Infer<typeof vHeartbeat>;

export const vHealth = v.object({
  /** Signing secret and workspace ID present, independently of append configuration. */
  readTokensConfigured: v.boolean(),
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
  /** When a retention sweep last ran, deleting anything or not. Absent until one has. */
  lastCleanupAt: v.optional(v.number()),
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
