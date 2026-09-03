import type { Infer } from "convex/values";

import { hasAppendToken, readAppendToken } from "./credentials";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  type BoundedCount,
  COUNT_CAP,
  type EventState,
  MAX_ERROR_HISTORY,
  type vDeliveryError,
  type vHeartbeat,
  type vOperatorAction,
  type vPausedReason,
} from "./contract";
import { pool } from "./pool";
import { sanitizeMessage } from "./sanitize";

/**
 * State transitions and the reads that summarise them.
 *
 * Split out of `lib.ts` when that file crossed the repository's file-size ratchet. Only
 * helpers moved: every Convex function stays where it was, so no `api.*` or `internal.*`
 * path changed and no host or test had to be repointed.
 */

/** Creates the single settings row on first write. */
export async function patchSettings(
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

/**
 * Keep a bounded history of earlier failures.
 *
 * `lastError` alone cannot answer "why did this die": once the budget runs out it reads
 * `exhausted`, which says the attempts finished but not whether the destination was rate
 * limiting, timing out, or refusing the token. The cap keeps a permanently failing event
 * from growing its own row without bound.
 */
export function pushHistory(
  history: Infer<typeof vDeliveryError>[] | undefined,
  previous: Infer<typeof vDeliveryError> | undefined,
): Infer<typeof vDeliveryError>[] | undefined {
  if (previous === undefined) return history;
  return [...(history ?? []), previous].slice(-MAX_ERROR_HISTORY);
}

/**
 * Bound and redact the one host-supplied string this component stores and echoes back.
 *
 * `actor` is an opaque identifier the host chooses, so the component cannot validate it,
 * but it is persisted on the settings row and returned by `health`. Unbounded it lets a
 * careless caller grow both without limit, and a host that passed a credential as its actor
 * would have it stored and handed back.
 */
export function recordActor(actor: string | undefined): string | undefined {
  return actor === undefined ? undefined : sanitizeMessage(actor, readAppendToken());
}

/** Reads at most `COUNT_CAP + 1` rows so health stays cheap on a large outbox. */
export async function boundedCount(ctx: QueryCtx, state: EventState): Promise<BoundedCount> {
  const rows = await ctx.db
    .query("events")
    .withIndex("by_state_createdAt", (q) => q.eq("state", state))
    .take(COUNT_CAP + 1);
  const capped = rows.length > COUNT_CAP;
  return { count: capped ? COUNT_CAP : rows.length, capped };
}

/**
 * The always-affordable signals: is it configured, is it paused and why, how long the oldest
 * waiting event has waited, when something last got through, and the newest failure.
 *
 * Reads exactly two documents regardless of how much is queued or how large events are, so
 * this is what an operator should alert on. `health` adds counts and costs more.
 */
export async function readHeartbeat(ctx: QueryCtx): Promise<Infer<typeof vHeartbeat>> {
  const [settings, oldestPending] = await Promise.all([
    ctx.db.query("settings").first(),
    ctx.db
      .query("events")
      .withIndex("by_state_createdAt", (q) => q.eq("state", "pending"))
      .first(),
  ]);
  return {
    configured: hasAppendToken(),
    paused: settings?.paused ?? false,
    pausedReason: settings?.pausedReason,
    // The index is ordered by creation, so the first waiting row is the oldest. A backlog
    // that is growing shows up in the counts; a backlog that is STUCK shows up here.
    oldestPendingAgeMs: oldestPending === null ? null : Date.now() - oldestPending.createdAt,
    lastDeliveredAt: settings?.lastDeliveredAt,
    lastError: settings?.lastError,
    lastOperatorAction: settings?.lastOperatorAction,
  };
}

/**
 * Hand one event to the delivery pool, if there is anywhere to send it.
 *
 * Scheduling is skipped rather than deferred when the component is unconfigured or the
 * destination is paused: an event with no live work is exactly what `resume` looks for, so
 * queueing work that would immediately no-op only burns pool capacity.
 */
/**
 * Queues one event for delivery, and reports whether it actually did.
 *
 * The return value is not decoration. Callers count what they put back to work and record
 * that count in the operator audit trail, and every early exit here is a case where the
 * event was NOT queued: unconfigured, paused, or no longer pending because something else
 * claimed it. Counting calls rather than successes made `resume` report that it had
 * requeued four events on an unconfigured instance, which had scheduled nothing.
 */
export async function scheduleDelivery(ctx: MutationCtx, id: Id<"events">): Promise<boolean> {
  if (!hasAppendToken()) return false;
  const settings = await ctx.db.query("settings").first();
  if (settings?.paused === true) return false;
  const event = await ctx.db.get(id);
  if (event === null || event.state !== "pending") return false;

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
  return true;
}

/**
 * Return a dead letter to the queue, keeping everything that identifies it.
 *
 * Replay is not re-enqueue: the identity and the payload are the ones the host committed, so
 * a later matching enqueue is still a duplicate and a mismatched one is still a conflict.
 * The attempt count resets because the budget is being granted again; the failure history
 * does not, because "why did this die" is the question an operator has after a replay.
 */
export async function requeueDeadLetter(ctx: MutationCtx, event: Doc<"events">): Promise<void> {
  await ctx.db.patch(event._id, {
    state: "pending",
    attempts: 0,
    workId: undefined,
    previousErrors: pushHistory(event.previousErrors, event.lastError),
    // Moved into the history, so it must not stay here as well. Leaving it would make the
    // next failure push the same entry a second time, spending one of the five history
    // slots on a duplicate and evicting a real earlier failure a cycle early. It is also
    // untrue on its own terms: a replayed event is in flight, not failed.
    lastError: undefined,
    updatedAt: Date.now(),
  });
  await scheduleDelivery(ctx, event._id);
}
