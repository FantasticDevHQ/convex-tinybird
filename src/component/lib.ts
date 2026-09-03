import { vOnCompleteArgs } from "@convex-dev/workpool";
import { ConvexError, v } from "convex/values";

import { canonicalJson, utf8Length } from "./canonical";
import { readAppendToken } from "./credentials";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import {
  boundedCount,
  patchSettings,
  pushHistory,
  readHeartbeat,
  recordActor,
  requeueDeadLetter,
  scheduleDelivery,
} from "./state";
import { sanitizeMessage } from "./sanitize";
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
  vDeliveryError,
  vEnqueueArgs,
  vEnqueueResult,
  vEventIdentity,
  vEventState,
  vPausedReason,
  vEventStatus,
  vHealth,
  vHeartbeat,
} from "./contract";

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
    return { ...heartbeatFields, counts: { pending, delivering, failed } };
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
    if (eventId.trim() === "" || eventId.length > MAX_EVENT_ID_LENGTH) {
      throw new ConvexError({ code: "invalid_event_id" as const, length: eventId.length });
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
      if (stored?.payload === payload) {
        return { outcome: "duplicate" as const, eventId, state: existing.state };
      }
      throw new ConvexError({
        code: "identity_conflict" as const,
        datasource: args.datasource,
        eventId,
      });
    }

    const now = Date.now();
    const id = await ctx.db.insert("events", {
      datasource: args.datasource,
      eventId,
      payloadBytes,
      state: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      ...(args.retry ? { retry: args.retry } : {}),
      ...(args.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: args.requestTimeoutMs }),
    });
    // Same mutation, so same transaction: either both rows exist or neither does. Every
    // rejection above happens before this point precisely so a half-written pair is not
    // reachable.
    await ctx.db.insert("payloads", { eventId: id, payload });
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

/** What the delivery action needs to build a request. Never includes a credential. */
export const loadForDelivery = internalQuery({
  args: { eventId: v.id("events") },
  returns: v.union(
    v.null(),
    v.object({
      datasource: v.string(),
      payload: v.string(),
      state: vEventState,
      paused: v.boolean(),
      requestTimeoutMs: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (event === null) return null;
    // The one place the payload is read for its own sake, and the reason it is a separate
    // table: this runs once per delivery attempt, not once per paged operator read.
    const stored = await ctx.db
      .query("payloads")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique();
    if (stored === null) return null;
    const settings = await ctx.db.query("settings").first();
    return {
      datasource: event.datasource,
      payload: stored.payload,
      state: event.state,
      paused: settings?.paused ?? false,
      requestTimeoutMs: event.requestTimeoutMs,
    };
  },
});

/**
 * Claim a pending event for one attempt. Returns false when someone else already moved it,
 * which is what stops two workers from sending the same row twice in the same instant.
 */
export const markDelivering = internalMutation({
  args: { eventId: v.id("events") },
  returns: v.boolean(),
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (event === null || event.state !== "pending") return false;
    await ctx.db.patch(eventId, {
      state: "delivering",
      attempts: event.attempts + 1,
      updatedAt: Date.now(),
    });
    return true;
  },
});

/**
 * Record a failed attempt and return the event to the queue.
 *
 * Recording and releasing are one mutation on purpose: an attempt that released without
 * recording would retry with no trace of why, and one that recorded without releasing would
 * strand the event. `health` reads the mirrored copy on `settings`, so an operator sees the
 * newest failure without reading event rows.
 */
export const markAttemptFailed = internalMutation({
  args: { eventId: v.id("events"), error: vDeliveryError },
  returns: v.null(),
  handler: async (ctx, { eventId, error }) => {
    const event = await ctx.db.get(eventId);
    if (event === null || event.state !== "delivering") return null;
    await ctx.db.patch(eventId, {
      state: "pending",
      lastError: error,
      previousErrors: pushHistory(event.previousErrors, event.lastError),
      updatedAt: Date.now(),
    });
    await patchSettings(ctx, { lastError: error });
    return null;
  },
});

/**
 * Return a claimed event to the queue after a failed attempt.
 *
 * Without this a retried attempt is dead on arrival: the pool re-runs the action, the row is
 * still `delivering`, `markDelivering` refuses to claim it, the action reports "skipped", the
 * pool records SUCCESS, and the event sits in `delivering` forever with no dead letter. The
 * attempt count is kept, because it is a count of attempts and not of claims.
 */
export const releaseForRetry = internalMutation({
  args: { eventId: v.id("events") },
  returns: v.null(),
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (event === null || event.state !== "delivering") return null;
    await ctx.db.patch(eventId, { state: "pending", updatedAt: Date.now() });
    return null;
  },
});

/**
 * Record a confirmed write. Only an in-flight event can be delivered: a late acknowledgement
 * for an event that already failed must not resurrect it.
 */
export const markDelivered = internalMutation({
  args: { eventId: v.id("events") },
  returns: v.null(),
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (event === null || event.state !== "delivering") return null;
    const now = Date.now();
    await ctx.db.patch(eventId, { state: "delivered", deliveredAt: now, updatedAt: now });
    await patchSettings(ctx, { lastDeliveredAt: now });
    return null;
  },
});

/** Move an event to its dead letter. A delivered event is never un-delivered. */
export const markFailed = internalMutation({
  args: { eventId: v.id("events"), error: vDeliveryError },
  returns: v.null(),
  handler: async (ctx, { eventId, error }) => {
    const event = await ctx.db.get(eventId);
    if (event === null || event.state === "delivered" || event.state === "failed") return null;
    await ctx.db.patch(eventId, { state: "failed", lastError: error, updatedAt: Date.now() });
    await patchSettings(ctx, { lastError: error });
    return null;
  },
});

/**
 * The pool's verdict on one delivery. A thrown attempt arrives here as `failed`; the retry
 * layer configures how many attempts precede that, so by the time this runs the budget is
 * spent and the event is a dead letter.
 */
export const onDeliveryComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ eventId: v.id("events") })),
  returns: v.null(),
  handler: async (ctx, { context, result, workId }) => {
    const eventId = context.eventId;
    // A completion speaks for the row only while the row still holds the item it is
    // reporting on. `onComplete` runs in its own transaction after the action returned, so
    // an operator who replays in that window gives the event a NEW work item, and this
    // completion is then stale in two ways at once.
    //
    // The marker is the obvious one: clearing whatever is there erases the new item and
    // leaves the row `pending` with no marker, which is precisely what `resume`'s index
    // selects, so the event gets a second concurrent worker and two independent retry
    // budgets. The verdict is the other, and it is worse — applying a `failed` result to a
    // row that has since been replayed marks an in-flight event as dead on the strength of
    // the attempt before it.
    //
    // Both are refused by the same check. Today the verdict half is unreachable, because a
    // row the pool reports `failed` for is `pending` rather than `failed` and so cannot be
    // replayed; that is an argument about the current state machine rather than an
    // invariant, and this is what makes it one.
    const finished = await ctx.db.get(eventId);
    if (finished === null || finished.workId !== workId) return null;
    await ctx.db.patch(eventId, { workId: undefined });
    if (result.kind === "failed") {
      const event = await ctx.db.get(eventId);
      if (event === null || event.state === "delivered" || event.state === "failed") return null;
      const error = {
        category: "exhausted" as const,
        message: sanitizeMessage(result.error, readAppendToken()),
        at: Date.now(),
      };
      await ctx.db.patch(eventId, {
        state: "failed",
        lastError: error,
        // The attempt that actually failed is what an operator needs; `exhausted` only
        // says the budget ran out.
        previousErrors: pushHistory(event.previousErrors, event.lastError),
        updatedAt: Date.now(),
      });
      await patchSettings(ctx, { lastError: error });
      return null;
    }
    if (result.kind === "canceled") {
      const event = await ctx.db.get(eventId);
      if (event !== null && event.state === "delivering") {
        await ctx.db.patch(eventId, { state: "pending", updatedAt: Date.now() });
      }
    }
    return null;
  },
});

// ---------------------------------------------------------------------------- operators

/**
 * Stop delivering and keep the event.
 *
 * Called by the delivery action when the destination refuses the credential. The event goes
 * back to `pending` rather than to a dead letter, because nothing is wrong with the row.
 */
export const markPaused = internalMutation({
  args: { eventId: v.id("events"), reason: vPausedReason, error: vDeliveryError },
  returns: v.null(),
  handler: async (ctx, { eventId, reason, error }) => {
    const event = await ctx.db.get(eventId);
    if (event !== null && event.state === "delivering") {
      await ctx.db.patch(eventId, {
        state: "pending",
        lastError: error,
        previousErrors: pushHistory(event.previousErrors, event.lastError),
        updatedAt: Date.now(),
      });
    }
    await patchSettings(ctx, {
      paused: true,
      pausedReason: reason,
      pausedAt: Date.now(),
      lastError: error,
    });
    return null;
  },
});

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
export const replayFailed = mutation({
  args: {
    limit: v.optional(v.number()),
    actor: v.optional(v.string()),
  },
  returns: v.object({ replayed: v.number(), remaining: v.boolean() }),
  handler: async (ctx, { limit, actor }) => {
    const batch = boundedBatch(limit, DEFAULT_REPLAY_LIMIT, MAX_REPLAY_LIMIT);
    // One row past the batch, so `remaining` is answered by the same read rather than by a
    // second query that could disagree with it.
    //
    // There is deliberately no category filter here. Requeuing is what moves this window
    // forward: a replayed row leaves the `failed` range, so the next call reads the rows
    // behind it. A filter applied to the page after the read breaks that — rows that do
    // not match stay `failed`, the window never advances, and any category whose rows sit
    // past the first page is unreachable while the call reports `remaining: false`. Doing
    // it correctly means indexing the category rather than filtering a page, which is
    // FTD-2527. Replaying one event at a time is `replayEvent`.
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
    const found = await ctx.db
      .query("events")
      .withIndex("by_state_updatedAt", (q) => q.eq("state", "failed"))
      .take(batch + 1);
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
