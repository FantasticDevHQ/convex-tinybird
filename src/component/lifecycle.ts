import { vOnCompleteArgs } from "@convex-dev/workpool";
import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server.js";
import { vDeliveryError, vEventState, vPausedReason } from "./contract.js";
import { readAppendToken } from "./credentials.js";
import { patchSettings, pushHistory } from "./state.js";
import { patchDeliverySettings, readPause } from "./scope.js";
import { sanitizeMessage } from "./sanitize.js";

/**
 * The delivery state machine, as Convex functions.
 *
 * Split from `lib.ts` when it crossed the file-size ratchet. The division is not arbitrary:
 * everything here is `internal`, called only by this component's own delivery action and by
 * the Workpool's completion callback, and none of it is part of the surface a host sees.
 * `lib.ts` keeps exactly the functions a host may call.
 *
 * These moved verbatim. Their `internal.lib.*` references became `internal.lifecycle.*`,
 * which is safe precisely because no host can name them.
 */

/** What the delivery action needs to build a request. Never includes a credential. */
export const loadForDelivery = internalQuery({
  args: { eventId: v.id("events") },
  returns: v.union(
    v.null(),
    v.object({
      datasource: v.string(),
      /**
       * Absent when the event exists but its payload row does not.
       *
       * Optional rather than a separate result shape because the compiler then forces the
       * caller to handle it: the request body needs a `string`, so a missing payload cannot
       * reach the wire by being forgotten.
       */
      payload: v.optional(v.string()),
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
    // A missing payload is NOT reported as a missing event. Collapsing the two was the
    // defect: the caller reads a null as a benign race and skips, so the row sat `pending`
    // with no attempt and no error, invisible to replay and re-queued by resume forever.
    const pause = await readPause(ctx, event.datasource);
    return {
      datasource: event.datasource,
      payload: stored?.payload,
      state: event.state,
      paused: pause.paused,
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
      lastErrorCategory: error.category,
      previousErrors: pushHistory(event.previousErrors, event.lastError),
      updatedAt: Date.now(),
    });
    await patchDeliverySettings(ctx, event.datasource, { lastError: error });
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
    await patchDeliverySettings(ctx, event.datasource, { lastDeliveredAt: now });
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
    await ctx.db.patch(eventId, {
      state: "failed",
      lastError: error,
      lastErrorCategory: error.category,
      // The error being replaced is a real attempt's reason and must not simply vanish.
      // `onDeliveryComplete` has always moved it into the history; this path did not, so an
      // event that failed an attempt and then hit a terminal fault ended up reporting only
      // the fault. `payload_missing` is written through here, which is what made the loss
      // reachable rather than theoretical.
      previousErrors: pushHistory(event.previousErrors, event.lastError),
      updatedAt: Date.now(),
    });
    await patchDeliverySettings(ctx, event.datasource, { lastError: error });
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
    // Both are refused by the same check, and BOTH halves are load bearing. The argument
    // that the verdict half was unreachable — that a row the pool reports `failed` for is
    // `pending` rather than `failed`, and so cannot have been replayed — stopped holding
    // when FTD-2531 made `enqueue` able to requeue a `pending` row to repair a lost payload.
    // A completion can now arrive for an item the row no longer holds while it is still
    // `pending`, which is precisely how a repaired row lost its dead letter before the
    // requeue itself was guarded.
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
        lastErrorCategory: error.category,
        // The attempt that actually failed is what an operator needs; `exhausted` only
        // says the budget ran out.
        previousErrors: pushHistory(event.previousErrors, event.lastError),
        updatedAt: Date.now(),
      });
      await patchDeliverySettings(ctx, event.datasource, { lastError: error });
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
        lastErrorCategory: error.category,
        previousErrors: pushHistory(event.previousErrors, event.lastError),
        updatedAt: Date.now(),
      });
    }
    if (event !== null) await patchDeliverySettings(ctx, event.datasource, { lastError: error });
    await patchSettings(ctx, {
      paused: true,
      pausedReason: reason,
      pausedAt: Date.now(),
      lastError: error,
    });
    return null;
  },
});
