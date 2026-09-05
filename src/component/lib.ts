import { ConvexError, v } from "convex/values";

import { canonicalJson, payloadFingerprint, utf8Length } from "./canonical.js";
import { env, mutation, query } from "./_generated/server.js";
import { signReadToken } from "./jwt.js";
import { resolveDestination } from "./destination.js";
import {
  boundedCount,
  sweepExpired,
  sweepOrphanedPayloads,
  patchSettings,
  readHeartbeat,
  recordActor,
  requeueDeadLetter,
  resolveExistingIdentity,
  scheduleDelivery,
} from "./state.js";
import {
  DEFAULT_REPLAY_LIMIT,
  MAX_REPLAY_LIMIT,
  boundedBatch,
  DEFAULT_RESUME_LIMIT,
  REQUEST_TIMEOUT_RANGE_MS,
  DATASOURCE_NAME_PATTERN,
  DEFAULT_MAX_PAYLOAD_BYTES,
  HARD_MAX_PAYLOAD_BYTES,
  MAX_EVENT_ID_LENGTH,
  retryConfigViolation,
  vEnqueueArgs,
  vEnqueueResult,
  vEventIdentity,
  vPausedReason,
  vFailureCategory,
  vEventStatus,
  vHealth,
  vHeartbeat,
} from "./contract.js";
import {
  DEFAULT_CLEANUP_LIMIT,
  DEFAULT_DELIVERED_RETENTION_MS,
  DEFAULT_FAILED_RETENTION_MS,
  DEFAULT_ORPHAN_SCAN_LIMIT,
  MAX_ORPHAN_SCAN_LIMIT,
  SWEEP_READ_BUDGET_BYTES,
} from "./budget.js";

/** The cheap operator signals. See {@link readHeartbeat}. */
export const heartbeat = query({
  args: {},
  returns: vHeartbeat,
  handler: readHeartbeat,
});

/** Delivery health for operators: configuration, pause state and bounded backlog counts. */
export const health = query({
  args: {},
  returns: vHealth,
  handler: async (ctx) => {
    // Independent index range scans; there is no ordering between them.
    const [heartbeatFields, pending, delivering, failed] = await Promise.all([
      readHeartbeat(ctx),
      boundedCount(ctx, "pending"),
      boundedCount(ctx, "delivering"),
      boundedCount(ctx, "failed"),
    ]);
    return {
      ...heartbeatFields,
      readTokensConfigured: readTokensConfigured(),
      counts: { pending, delivering, failed },
    };
  },
});

function readTokensConfigured(): boolean {
  return Boolean(env.TINYBIRD_ADMIN_TOKEN?.trim() && env.TINYBIRD_WORKSPACE_ID?.trim());
}

/** Host-only minting entry point. The host must authorize every scope and fixed parameter. */
export const mintReadToken = mutation({
  args: {
    name: v.string(),
    ttlSeconds: v.number(),
    scopes: v.array(v.object({ pipe: v.string(), fixedParams: v.record(v.string(), v.string()) })),
    rps: v.optional(v.number()),
  },
  returns: v.object({ token: v.string(), expiresAt: v.number(), host: v.string() }),
  handler: async (_ctx, args) => {
    if (
      !Number.isInteger(args.ttlSeconds) ||
      args.ttlSeconds < 60 ||
      args.ttlSeconds > 3600 ||
      args.scopes.length < 1 ||
      args.scopes.length > 10 ||
      args.scopes.some((scope) =>
        Object.values(scope.fixedParams).some((value) => typeof value !== "string"),
      ) ||
      (args.rps !== undefined && (!Number.isSafeInteger(args.rps) || args.rps < 1))
    )
      throw new ConvexError({ code: "invalid_read_token" });
    const secret = env.TINYBIRD_ADMIN_TOKEN;
    const workspaceId = env.TINYBIRD_WORKSPACE_ID;
    if (!secret?.trim() || !workspaceId?.trim()) {
      throw new ConvexError({ code: "read_tokens_not_configured" });
    }
    const destination = resolveDestination(env.TINYBIRD_HOST);
    if (!destination.ok) throw new ConvexError({ code: "invalid_destination" });
    const expiresAt = Math.floor(Date.now() / 1000) + args.ttlSeconds;
    const token = await signReadToken({ ...args, secret, workspaceId, expiresAt });
    return { token, expiresAt, host: destination.host };
  },
});

/**
 * Store one event for delivery. Runs inside the HOST's mutation (through `ctx.runMutation`), so
 * the row commits or rolls back with the host's own writes. Every check happens before the
 * write, so a rejected call leaves nothing behind.
 *
 * Identity is `(datasource, eventId)`. Same identity and equal canonical payload → `duplicate`
 * (the stored row is returned as-is); different payload → `identity_conflict`.
 *
 * Delivery scheduling is added by the Workpool layer; this mutation never schedules.
 */
export const enqueue = mutation({
  args: vEnqueueArgs,
  returns: vEnqueueResult,
  handler: async (ctx, args) => {
    if (!DATASOURCE_NAME_PATTERN.test(args.datasource)) {
      throw new ConvexError({ code: "invalid_datasource" as const, datasource: args.datasource });
    }
    const eventId = args.eventId;
    const eventIdBytes = utf8Length(eventId);
    if (eventId.trim() === "" || eventIdBytes > MAX_EVENT_ID_LENGTH) {
      throw new ConvexError({ code: "invalid_event_id" as const, length: eventIdBytes });
    }
    if (args.requestTimeoutMs !== undefined) {
      const { min, max } = REQUEST_TIMEOUT_RANGE_MS;
      if (
        !Number.isFinite(args.requestTimeoutMs) ||
        args.requestTimeoutMs < min ||
        args.requestTimeoutMs > max
      ) {
        throw new ConvexError({
          code: "invalid_request_timeout" as const,
          requestTimeoutMs: args.requestTimeoutMs,
        });
      }
    }
    if (args.retry) {
      const violation = retryConfigViolation(args.retry);
      if (violation) throw new ConvexError({ code: "invalid_retry" as const, reason: violation });
    }
    const payload = canonicalJson(args.payload);
    const payloadBytes = utf8Length(payload);
    const payloadHash = payloadFingerprint(payload);
    const bound = Math.min(
      args.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      HARD_MAX_PAYLOAD_BYTES,
    );
    if (payloadBytes > bound) {
      throw new ConvexError({
        code: "payload_too_large" as const,
        payloadBytes,
        maxPayloadBytes: bound,
      });
    }

    const existing = await ctx.db
      .query("events")
      .withIndex("by_identity", (q) => q.eq("datasource", args.datasource).eq("eventId", eventId))
      .unique();
    if (existing) {
      // The stored payload is one document away, and this is the only read of it outside
      // delivery. Comparing sizes first would not be sound on its own — two different
      // payloads can share a length — so the comparison is the canonical text itself.
      const stored = await ctx.db
        .query("payloads")
        .withIndex("by_event", (q) => q.eq("eventId", existing._id))
        .unique();
      return await resolveExistingIdentity(ctx, existing, {
        payload,
        payloadBytes,
        payloadHash,
        stored,
      });
    }

    const now = Date.now();
    const id = await ctx.db.insert("events", {
      datasource: args.datasource,
      eventId,
      payloadBytes,
      payloadHash,
      state: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      ...(args.retry ? { retry: args.retry } : {}),
      ...(args.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: args.requestTimeoutMs }),
    });
    // Same mutation, so same transaction: either both rows exist or neither does.
    //
    // That is Convex's guarantee, not this ordering's. Moving the validation below these
    // inserts would still roll both back, and independent verification proved it by doing
    // exactly that — the whole suite stayed green. The ordering is tidiness; the atomicity
    // is the runtime. What is NOT free, and is tested, is that one event has exactly one
    // payload row: a conflicting re-enqueue must not leave a second one behind.
    const payloadId = await ctx.db.insert("payloads", { eventId: id, payload });
    // Patched rather than inserted, because the payload row keys itself by the event and so
    // cannot exist first. Same mutation, so no committed row is ever without it.
    await ctx.db.patch(id, { payloadId });
    await scheduleDelivery(ctx, id);
    return { outcome: "enqueued" as const, eventId, state: "pending" as const };
  },
});

/** Delivery state of one event. Never returns the payload. */
export const getStatus = query({
  args: vEventIdentity,
  returns: v.union(vEventStatus, v.null()),
  handler: async (ctx, { datasource, eventId }) => {
    const row = await ctx.db
      .query("events")
      .withIndex("by_identity", (q) => q.eq("datasource", datasource).eq("eventId", eventId))
      .unique();
    if (!row) return null;
    return {
      datasource: row.datasource,
      eventId: row.eventId,
      state: row.state,
      attempts: row.attempts,
      createdAt: row.createdAt,
      deliveredAt: row.deliveredAt,
      lastError: row.lastError,
      previousErrors: row.previousErrors,
    };
  },
});

// ---------------------------------------------------------------------------- delivery

// ---------------------------------------------------------------------------- operators

/**
 * Stop delivering on purpose. `actor` is whatever opaque identifier the host uses for the
 * caller; the component never authenticates, so a host must authorize this itself.
 */
export const pause = mutation({
  args: { reason: v.optional(vPausedReason), actor: v.optional(v.string()) },
  returns: v.object({ paused: v.boolean() }),
  handler: async (ctx, { reason, actor }) => {
    await patchSettings(ctx, {
      paused: true,
      pausedReason: reason ?? "operator",
      pausedAt: Date.now(),
      lastOperatorAction: { kind: "pause" as const, actor: recordActor(actor), at: Date.now() },
    });
    return { paused: true };
  },
});

/**
 * Clear the pause and put waiting events back to work, a bounded batch at a time.
 *
 * Bounded because a paused destination can accumulate an arbitrary backlog, and one
 * mutation that tried to re-enqueue all of it would exceed Convex's transaction limits.
 * Hosts call this in a loop until `requeued` is zero.
 */
export const resume = mutation({
  args: { actor: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.object({ paused: v.boolean(), requeued: v.number() }),
  handler: async (ctx, { actor, limit }) => {
    const settings = await ctx.db.query("settings").first();
    const batch = boundedBatch(limit, DEFAULT_RESUME_LIMIT, DEFAULT_RESUME_LIMIT);
    if (settings !== undefined && settings !== null && settings.paused) {
      await ctx.db.patch(settings._id, {
        paused: false,
        pausedReason: undefined,
        pausedAt: undefined,
      });
    }
    // Exactly the events the pool is NOT already working on. A row can be `pending` because
    // it is waiting for an operator, or because an attempt failed and the pool is about to
    // try again; queueing a second work item for the latter gives the event two independent
    // retry budgets and lets it be sent more times than its policy allows.
    //
    // This is an index lookup rather than a scan-and-filter on purpose. Filtering a window
    // of `pending` rows means rows that already have work occupy the window and hide the
    // ones behind them, so the loop above reports "nothing left" while events still wait.
    // That is not hypothetical: with a backlog larger than the window it happens on every
    // drain where the host loops faster than the pool empties, which is the normal case.
    const waiting = await ctx.db
      .query("events")
      .withIndex("by_state_workId_createdAt", (q) =>
        q.eq("state", "pending").eq("workId", undefined),
      )
      .take(batch);
    // Counts events actually queued, not rows visited. `scheduleDelivery` declines when the
    // instance is unconfigured, paused, or the row is no longer pending, and reporting those
    // as requeued would put a number in the audit trail that describes nothing that happened.
    let requeued = 0;
    for (const event of waiting) {
      if (await scheduleDelivery(ctx, event._id)) requeued += 1;
    }
    // Written after the loop, not before it: `count` is the number of events this call
    // actually put back to work, and that number does not exist until the loop has run.
    await patchSettings(ctx, {
      lastOperatorAction: {
        kind: "resume" as const,
        actor: recordActor(actor),
        at: Date.now(),
        count: requeued,
      },
    });
    return { paused: false, requeued };
  },
});

/**
 * Replay dead letters, a bounded batch at a time.
 *
 * Bounded for the same reason `resume` is: a destination that has been failing can have
 * accumulated an arbitrary number of them, and one mutation cannot rewrite all of it. Hosts
 * loop while `remaining` is true. The component authenticates nobody, so a host must
 * authorize the caller and pass whatever identifier it wants recorded.
 */
/**
 * Deletes finished events past their retention, a bounded batch at a time.
 *
 * Only `delivered` and `failed` are ever considered. A `pending` or `delivering` row is work
 * nobody has finished, and age is not a reason to throw it away — so those states are not
 * queried at all rather than queried and filtered, which is the difference between a rule
 * and a comment.
 *
 * The host schedules this; the component owns no cron. Loop while `remaining` is true.
 */
export const cleanup = mutation({
  args: {
    deliveredRetentionMs: v.optional(v.number()),
    failedRetentionMs: v.optional(v.number()),
    limit: v.optional(v.number()),
    actor: v.optional(v.string()),
  },
  returns: v.object({
    deletedDelivered: v.number(),
    deletedFailed: v.number(),
    remaining: v.boolean(),
  }),
  handler: async (ctx, args) => {
    // Validated, not clamped. A retention is a caller's statement about what is safe to
    // destroy, so a nonsensical one is a mistake to refuse rather than a value to guess at.
    //
    // Zero is ACCEPTED, and deliberately: it means "delete everything finished", which is a
    // coherent request. It is worth knowing that it arrives from the same place the refused
    // values do — `Number(process.env.RETENTION_DAYS) * DAY` yields `NaN` when the variable
    // is unset and `0` when it is set to "0" — so the first is refused and the second is
    // obeyed. That asymmetry is intended: `NaN` cannot express an intent and `0` can.
    // `NaN` is the dangerous one: Convex orders it above every finite number, so
    // `lt("updatedAt", NaN)` matches every row of that state and the sweep would delete rows
    // one second old. A negative retention puts the cutoff in the future and does the same.
    const retention = (value: number | undefined, fallback: number): number => {
      if (value === undefined) return fallback;
      if (!Number.isFinite(value) || value < 0) {
        throw new ConvexError({ code: "invalid_retention" as const, retentionMs: value });
      }
      return value;
    };
    const deliveredRetentionMs = retention(
      args.deliveredRetentionMs,
      DEFAULT_DELIVERED_RETENTION_MS,
    );
    const failedRetentionMs = retention(args.failedRetentionMs, DEFAULT_FAILED_RETENTION_MS);

    const budget = boundedBatch(args.limit, DEFAULT_CLEANUP_LIMIT, DEFAULT_CLEANUP_LIMIT);
    const now = Date.now();

    // ONE budget across both states, spent in order. A limit that applied per state would
    // let `limit: 3` delete six rows, which is not what a caller bounding a transaction
    // asked for.
    // ONE byte budget too, and for the same reason. Splitting it would let a call read twice
    // what a caller bounding a transaction asked for, and the bytes are the bound that
    // actually binds once payloads are large.
    const delivered = await sweepExpired(ctx, {
      state: "delivered",
      cutoff: now - deliveredRetentionMs,
      batch: budget,
      byteBudget: SWEEP_READ_BUDGET_BYTES,
      mayExemptFirstRow: true,
    });
    const failed = await sweepExpired(ctx, {
      state: "failed",
      cutoff: now - failedRetentionMs,
      batch: budget - delivered.deleted,
      byteBudget: SWEEP_READ_BUDGET_BYTES - delivered.bytesSpent,
      // Only if the delivered sweep took nothing. Otherwise this call has already had its
      // one over-budget row and the guarantee would be `budget + worstRow`, not `budget`.
      // Nothing strands: once the delivered rows are gone, a later call arrives here with
      // the exemption available again.
      mayExemptFirstRow: delivered.deleted === 0,
    });

    // Two fields, because they answer two questions and one slot cannot hold both.
    //
    // `lastCleanupAt` is written on EVERY call, including one that deleted nothing. That is
    // the "is the sweep still running" signal, and a sweep that found nothing to do is
    // exactly as healthy as one that found plenty — a wedged sweep is silent, and silence
    // is what this makes visible.
    //
    // `lastOperatorAction` is written only when the sweep actually removed something. It is
    // a single slot shared with `pause`, `resume`, `replayFailed` and `replayEvent`, and an
    // earlier version of this wrote it unconditionally. The README tells hosts to run
    // cleanup nightly, so within a day of any human action a no-op cron would overwrite the
    // only record that the human acted — buying observability for the sweep by destroying it
    // for everyone else.
    const deleted = delivered.deleted + failed.deleted;
    await patchSettings(ctx, {
      lastCleanupAt: now,
      ...(deleted > 0
        ? {
            lastOperatorAction: {
              kind: "cleanup" as const,
              actor: recordActor(args.actor),
              at: now,
              count: deleted,
            },
          }
        : {}),
    });

    return {
      deletedDelivered: delivered.deleted,
      deletedFailed: failed.deleted,
      remaining: delivered.more || failed.more,
    };
  },
});

/**
 * Removes payload rows whose event is gone.
 *
 * Separate from `cleanup`, and deliberately so. Finding an orphan means reading payload
 * rows, and a payload row is the one thing in this component whose size a host controls —
 * so folding this into the retention sweep would put that sweep's cost back on payload size,
 * which is the coupling `payloadId` exists to remove. Keeping it apart lets retention run
 * often and cheaply while this runs rarely and is allowed to be expensive.
 *
 * Nothing here produces an orphan: an event and its payload are deleted in one mutation, so
 * they cannot part company. This exists because the uncounted table is uncounted precisely
 * so nothing has to look at it, which is also what would let a leak accumulate unseen if a
 * future path ever did write a pair and lose half of it.
 *
 * The default limit is small for the reason the retention limit is large: this scan reads
 * whole payload rows and cannot know their size in advance, so unlike `cleanup` it cannot
 * budget by bytes, and reclaiming an orphan pays for its payload twice — once to page it in,
 * once when the delete re-reads it. At the 512 KiB hard bound that is about 1 MiB per row —
 * see {@link DEFAULT_ORPHAN_SCAN_LIMIT} for the arithmetic. A host whose payloads are small
 * should pass a larger limit; the ceiling is {@link MAX_ORPHAN_SCAN_LIMIT}.
 */
export const reclaimOrphanedPayloads = mutation({
  args: { limit: v.optional(v.number()), cursor: v.optional(v.union(v.number(), v.null())) },
  returns: v.object({
    reclaimed: v.number(),
    scanned: v.number(),
    // A `_creationTime`, not an opaque pagination token: `.paginate()` is forbidden inside
    // a component, so the scan carries its own cursor. Callers pass it back unchanged.
    cursor: v.union(v.number(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, { limit, cursor }) => {
    // A ceiling well above the default: a host that knows its payloads are small should be
    // able to ask for a much larger page, but not an unbounded one. This scan reads whole
    // payload rows and cannot weigh them first, so the row count is its only bound.
    const batch = boundedBatch(limit, DEFAULT_ORPHAN_SCAN_LIMIT, MAX_ORPHAN_SCAN_LIMIT);
    return sweepOrphanedPayloads(ctx, batch, cursor ?? null);
  },
});

export const replayFailed = mutation({
  args: {
    limit: v.optional(v.number()),
    category: v.optional(vFailureCategory),
    actor: v.optional(v.string()),
  },
  returns: v.object({ replayed: v.number(), remaining: v.boolean() }),
  handler: async (ctx, { limit, actor, category }) => {
    if (category !== undefined) {
      // Convex indexes missing optional fields as undefined (the same mechanism resume
      // uses for missing workId). Verified on a live anonymous deployment: an old failed
      // row without this field blocks replay, then becomes selectable after backfill.
      const legacy = await ctx.db
        .query("events")
        .withIndex("by_state_lastErrorCategory_updatedAt", (q) =>
          q.eq("state", "failed").eq("lastErrorCategory", undefined),
        )
        .first();
      if (legacy !== null) {
        throw new ConvexError({ code: "category_index_not_ready" as const });
      }
    }
    const batch = boundedBatch(limit, DEFAULT_REPLAY_LIMIT, MAX_REPLAY_LIMIT);
    // One row past the batch, so `remaining` is answered by the same read rather than by a
    // second query that could disagree with it.
    //
    // The category predicate belongs in the index: filtering a page would leave
    // unrelated dead letters at the front and hide matching rows behind them.
    //
    // Ordered by `updatedAt`, NOT `createdAt`. An event that is replayed, sent, and fails
    // again comes straight back to `failed`; ordered by creation it would return to the
    // same position at the front of the range and be picked again on the very next call,
    // so a destination that is still broken means the oldest few events are replayed over
    // and over while everything behind them is never reached. Measured before this was
    // changed: five dead letters, three call-and-drain cycles at `limit: 2`, and two events
    // had been replayed three times each while the other three had not been replayed at
    // all. `updatedAt` sends a re-failed row to the back, so every dead letter is tried
    // once before any is tried twice.
    const failed =
      category === undefined
        ? ctx.db.query("events").withIndex("by_state_updatedAt", (q) => q.eq("state", "failed"))
        : ctx.db
            .query("events")
            .withIndex("by_state_lastErrorCategory_updatedAt", (q) =>
              q.eq("state", "failed").eq("lastErrorCategory", category),
            );
    const found = await failed.take(batch + 1);
    const selected = found.slice(0, batch);

    for (const event of selected) await requeueDeadLetter(ctx, event);
    await patchSettings(ctx, {
      lastOperatorAction: {
        kind: "replayFailed" as const,
        actor: recordActor(actor),
        at: Date.now(),
        count: selected.length,
      },
    });
    return { replayed: selected.length, remaining: found.length > selected.length };
  },
});

/** Replay one dead letter by its identity. Reports honestly when there is nothing to do. */
export const replayEvent = mutation({
  args: { ...vEventIdentity.fields, actor: v.optional(v.string()) },
  returns: v.object({ replayed: v.boolean() }),
  handler: async (ctx, { datasource, eventId, actor }) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_identity", (q) => q.eq("datasource", datasource).eq("eventId", eventId))
      .unique();
    // Only a dead letter can be replayed: an event that is waiting or in flight already has
    // a worker, and one that was delivered must not be sent again on an operator's say-so.
    const replayed = event !== null && event.state === "failed";
    if (replayed) await requeueDeadLetter(ctx, event);
    await patchSettings(ctx, {
      lastOperatorAction: {
        kind: "replayEvent" as const,
        actor: recordActor(actor),
        at: Date.now(),
        count: replayed ? 1 : 0,
      },
    });
    return { replayed };
  },
});
