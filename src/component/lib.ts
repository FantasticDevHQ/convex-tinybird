import { vOnCompleteArgs } from "@convex-dev/workpool";
import { ConvexError, type Infer, v } from "convex/values";

import type { vOperatorAction } from "./contract";

import { canonicalJson, utf8Length } from "./canonical";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  env,
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  query,
  type QueryCtx,
} from "./_generated/server";
import { pool } from "./pool";
import { sanitizeMessage } from "./sanitize";
import {
  type BoundedCount,
  COUNT_CAP,
  DEFAULT_RESUME_LIMIT,
  REQUEST_TIMEOUT_RANGE_MS,
  MAX_ERROR_HISTORY,
  DATASOURCE_NAME_PATTERN,
  DEFAULT_MAX_PAYLOAD_BYTES,
  type EventState,
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
} from "./contract";

/** Present and non-blank. `convex env set X ""` leaves a variable present-but-empty. */
function hasToken(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** Reads at most `COUNT_CAP + 1` rows so health stays cheap on a large outbox. */
async function boundedCount(ctx: QueryCtx, state: EventState): Promise<BoundedCount> {
  const rows = await ctx.db
    .query("events")
    .withIndex("by_state_createdAt", (q) => q.eq("state", state))
    .take(COUNT_CAP + 1);
  const capped = rows.length > COUNT_CAP;
  return { count: capped ? COUNT_CAP : rows.length, capped };
}

/** Delivery health for operators: configuration, pause state and bounded backlog counts. */
export const health = query({
  args: {},
  returns: vHealth,
  handler: async (ctx) => {
    const settings = await ctx.db.query("settings").first();
    // Three independent index range scans; there is no ordering between them.
    const [pending, delivering, failed] = await Promise.all([
      boundedCount(ctx, "pending"),
      boundedCount(ctx, "delivering"),
      boundedCount(ctx, "failed"),
    ]);
    return {
      configured: hasToken(env.TINYBIRD_TOKEN),
      paused: settings?.paused ?? false,
      pausedReason: settings?.pausedReason,
      counts: { pending, delivering, failed },
    };
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
      if (existing.payload === payload) {
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
      payload,
      payloadBytes,
      state: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      ...(args.retry ? { retry: args.retry } : {}),
      ...(args.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: args.requestTimeoutMs }),
    });
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

/**
 * Hand one event to the delivery pool, if there is anywhere to send it.
 *
 * Scheduling is skipped rather than deferred when the component is unconfigured or the
 * destination is paused: an event with no live work is exactly what `resume` looks for, so
 * queueing work that would immediately no-op only burns pool capacity.
 */
async function scheduleDelivery(ctx: MutationCtx, id: Id<"events">): Promise<void> {
  if (!hasToken(env.TINYBIRD_TOKEN)) return;
  const settings = await ctx.db.query("settings").first();
  if (settings?.paused === true) return;
  const event = await ctx.db.get(id);
  if (event === null || event.state !== "pending") return;

  const workId = await pool.enqueueAction(
    ctx,
    internal.deliver.deliverEvent,
    { eventId: id },
    {
      retry: event.retry ?? false,
      onComplete: internal.lib.onDeliveryComplete,
      context: { eventId: id },
    },
  );
  await ctx.db.patch(id, { workId });
}

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
    const settings = await ctx.db.query("settings").first();
    return {
      datasource: event.datasource,
      payload: event.payload,
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
 * Keep a bounded history of earlier failures.
 *
 * `lastError` alone cannot answer "why did this die": once the budget runs out it reads
 * `exhausted`, which says the attempts finished but not whether the destination was rate
 * limiting, timing out, or refusing the token. The cap keeps a permanently failing event
 * from growing its own row without bound.
 */
function pushHistory(
  history: Infer<typeof vDeliveryError>[] | undefined,
  previous: Infer<typeof vDeliveryError> | undefined,
): Infer<typeof vDeliveryError>[] | undefined {
  if (previous === undefined) return history;
  return [...(history ?? []), previous].slice(-MAX_ERROR_HISTORY);
}

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
  handler: async (ctx, { context, result }) => {
    const eventId = context.eventId;
    // The pool is done with this event either way, so the live-work marker goes now.
    // `resume` reads it to tell "waiting for a worker" from "waiting for an operator".
    const finished = await ctx.db.get(eventId);
    if (finished !== null && finished.workId !== undefined) {
      await ctx.db.patch(eventId, { workId: undefined });
    }
    if (result.kind === "failed") {
      const event = await ctx.db.get(eventId);
      if (event === null || event.state === "delivered" || event.state === "failed") return null;
      const error = {
        category: "exhausted" as const,
        message: sanitizeMessage(result.error, env.TINYBIRD_TOKEN),
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

/** Creates the single settings row on first write. */
async function patchSettings(
  ctx: MutationCtx,
  patch: {
    lastDeliveredAt?: number;
    lastError?: Infer<typeof vDeliveryError>;
    paused?: boolean;
    pausedReason?: Infer<typeof vPausedReason>;
    pausedAt?: number;
    lastOperatorAction?: Infer<typeof vOperatorAction>;
  },
): Promise<void> {
  const settings = await ctx.db.query("settings").first();
  if (settings === null) {
    await ctx.db.insert("settings", { paused: false, ...patch });
    return;
  }
  await ctx.db.patch(settings._id, patch);
}

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
      lastOperatorAction: { kind: "pause" as const, actor, at: Date.now() },
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
    const batch = Math.max(1, Math.min(limit ?? DEFAULT_RESUME_LIMIT, DEFAULT_RESUME_LIMIT));
    if (settings !== undefined && settings !== null && settings.paused) {
      await ctx.db.patch(settings._id, {
        paused: false,
        pausedReason: undefined,
        pausedAt: undefined,
      });
    }
    await patchSettings(ctx, {
      lastOperatorAction: { kind: "resume" as const, actor, at: Date.now() },
    });

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
    let requeued = 0;
    for (const event of waiting) {
      await scheduleDelivery(ctx, event._id);
      requeued += 1;
    }
    return { paused: false, requeued };
  },
});
