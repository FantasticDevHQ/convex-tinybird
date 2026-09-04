import { ConvexError } from "convex/values";
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
      onComplete: internal.lifecycle.onDeliveryComplete,
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

/**
 * What to do about an enqueue whose identity already exists.
 *
 * Three answers, and the order of the checks is load bearing. Content is compared FIRST, so
 * every path below refuses a mismatch — the repair branch must never be more permissive than
 * the ordinary duplicate path it sits beside, which it was when `delivered` returned early.
 */
export async function resolveExistingIdentity(
  ctx: MutationCtx,
  existing: Doc<"events">,
  incoming: {
    payload: string;
    payloadBytes: number;
    payloadHash: string;
    stored: Doc<"payloads"> | null;
  },
): Promise<{ outcome: "duplicate" | "repaired"; eventId: string; state: EventState }> {
  const conflict = () =>
    new ConvexError({
      code: "identity_conflict" as const,
      datasource: existing.datasource,
      eventId: existing.eventId,
    });

  if (incoming.stored !== null) {
    if (incoming.stored.payload !== incoming.payload) throw conflict();
    return { outcome: "duplicate", eventId: existing.eventId, state: existing.state };
  }

  // The payload row is gone, so the text cannot be compared. `payloadBytes` and
  // `payloadHash` survive on the event row and are the only evidence left of what was
  // committed.
  if (
    existing.payloadBytes !== incoming.payloadBytes ||
    existing.payloadHash !== incoming.payloadHash
  ) {
    throw conflict();
  }

  // Already sent: nothing to restore and nothing to resend.
  if (existing.state === "delivered") {
    return { outcome: "duplicate", eventId: existing.eventId, state: existing.state };
  }

  // This is a `payload_missing` dead letter and THIS CALL IS THE ONLY THING THAT CAN FIX IT.
  // `enqueue` is the sole surface that writes `payloads`, and a component's tables are
  // unreachable from the host, so rejecting it would leave the row stuck permanently:
  // selected by replay, never deliverable, never countable down.
  const payloadId = await ctx.db.insert("payloads", {
    eventId: existing._id,
    payload: incoming.payload,
  });
  // A repaired event gets its pointer back too, or the sweep would lose track of the row it
  // just restored and leak it.
  await ctx.db.patch(existing._id, { payloadId });

  // Requeued ONLY when nothing is already working on it. `requeueDeadLetter` schedules
  // unconditionally, and giving a row a second work item while the first is queued makes its
  // `workId` point at the new one — so when the original finishes, `onDeliveryComplete` sees
  // a mismatch, discards its own verdict as stale, and the row is left `pending` with its
  // budget spent and no dead letter. That is this ticket's own defect arriving through a
  // different door, and `resume` then hands it a second budget on top.
  //
  // A `delivering` row is never requeued whatever its `workId` says: it is mid-attempt by
  // definition. Recovering one that is genuinely stuck is FTD-2500's job. The `pending`
  // clause covers a row nothing ever scheduled, which is what a paused or unconfigured
  // instance leaves behind.
  if (
    existing.state === "failed" ||
    (existing.state === "pending" && existing.workId === undefined)
  ) {
    await requeueDeadLetter(ctx, existing);
  }

  // Read back rather than predicted: the branch above does not always run, so asserting
  // `pending` here would be a guess that happens to be true today.
  const repaired = await ctx.db.get(existing._id);
  return {
    outcome: "repaired",
    eventId: existing.eventId,
    state: repaired?.state ?? existing.state,
  };
}

/**
 * Deletes one event and the payload row it points at.
 *
 * The pointer is the whole reason this is cheap: `ctx.db.delete(id)` reads nothing, where
 * finding the row through `by_event` would return the payload text and put the sweep's cost
 * back on event size. The index lookup survives only as a fallback for a row whose pointer
 * was never recorded — a half-written path, or data predating the field — because leaking
 * the payload would be worse than paying for one read.
 */
export async function deleteEventWithPayload(
  ctx: MutationCtx,
  event: Doc<"events">,
): Promise<void> {
  if (event.payloadId !== undefined) {
    // Tolerates a STALE pointer, and this is not defensive padding. FTD-2531 dead-letters an
    // event whose payload row has gone, and nothing clears the pointer when that happens
    // because the row vanished by some means outside this component. Deleting a missing
    // document throws `Delete on non-existent doc`, and the throw would take down the whole
    // sweep — every later call hitting the same row and failing again, so retention never
    // runs for anything until someone intervenes by hand.
    try {
      await ctx.db.delete(event.payloadId);
    } catch (error) {
      // ONLY "already gone" is tolerated; anything else re-throws. A bare catch would
      // swallow a wrong-table id, a write-limit error, or whatever a future Convex version
      // raises — and the very next line deletes the event regardless, manufacturing exactly
      // the orphan `reclaimOrphanedPayloads` exists to find. Losing a payload silently is
      // worse than failing the sweep loudly.
      //
      // Matched on the message because Convex offers no code for it. Brittle in the safe
      // direction: if the wording changes this re-throws, so the wedge returns visibly
      // rather than a real error being hidden.
      //
      // NOT pinned by a test, and it cannot be here — constructing a delete failure that is
      // not "already gone" needs the harness to reject something, and convex-test accepts
      // even an id from the wrong table. Said plainly because the tolerated case IS tested
      // and it would be easy to read that as covering both branches.
      if (!(error instanceof Error) || !/non-existent doc/iu.test(error.message)) {
        throw error;
      }
    }
  } else {
    const stored = await ctx.db
      .query("payloads")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .unique();
    if (stored !== null) await ctx.db.delete(stored._id);
  }
  await ctx.db.delete(event._id);
}

/**
 * Deletes one bounded page of finished events past a cutoff, with their payloads.
 *
 * Only ever called for `delivered` and `failed`. `pending` and `delivering` are not filtered
 * out here — they are never queried at all, which is the difference between a rule and a
 * comment, and it is why this takes the state rather than deciding it.
 *
 * The cutoff is strict: a row exactly at it is kept. Deleting on equality would quietly
 * shorten every retention by one tick.
 */
export async function sweepExpired(
  ctx: MutationCtx,
  state: "delivered" | "failed",
  cutoff: number,
  batch: number,
): Promise<{ deleted: number; more: boolean }> {
  // `updatedAt`, not `createdAt`: retention runs from when the event FINISHED. Both
  // `markDelivered` and `markFailed` set it as they move the row into its terminal state,
  // so for a swept row it is the moment it stopped being work.
  //
  // Creation time would be wrong in the case that matters most. An event that sat `pending`
  // through a long pause and was delivered a moment ago already has a `createdAt` older
  // than any retention, so it would be swept on the very next pass — giving a dedupe window
  // of zero to exactly the events a producer is most likely to re-emit after noticing the
  // outage.
  if (batch <= 0) return { deleted: 0, more: true };
  const found = await ctx.db
    .query("events")
    .withIndex("by_state_updatedAt", (q) => q.eq("state", state).lt("updatedAt", cutoff))
    .take(batch + 1);
  const selected = found.slice(0, batch);
  for (const event of selected) await deleteEventWithPayload(ctx, event);
  return { deleted: selected.length, more: found.length > selected.length };
}

/**
 * Deletes payload rows whose event is gone.
 *
 * Nothing in the component produces one, and retention is the only thing that could — so a
 * half-delete would accumulate silently, because the uncounted table is uncounted precisely
 * so nothing has to look at it. This looks, cheaply and boundedly, and reports what it found
 * rather than only removing it: an orphan appearing at all means something wrote a pair and
 * lost half of it, which an operator should hear about.
 */
export async function sweepOrphanedPayloads(
  ctx: MutationCtx,
  batch: number,
  cursor: string | null,
): Promise<{ reclaimed: number; scanned: number; cursor: string | null; isDone: boolean }> {
  // Paginated, because a plain `take(n)` cannot work here. Healthy rows are never deleted,
  // so they occupy the front of the table permanently and an unordered `take` rescans the
  // same page on every call — an orphan behind that page is invisible for good. Not slow
  // progress: no progress. The caller carries the cursor forward.
  const page = await ctx.db.query("payloads").paginate({ cursor, numItems: batch });
  let reclaimed = 0;
  for (const stored of page.page) {
    if ((await ctx.db.get(stored.eventId)) === null) {
      await ctx.db.delete(stored._id);
      reclaimed += 1;
    }
  }
  return {
    reclaimed,
    // `scanned` alone cannot answer "are there orphans anywhere" — that is what `isDone`
    // is for. It is reported so a caller can tell a clean page from an empty one.
    scanned: page.page.length,
    cursor: page.isDone ? null : page.continueCursor,
    isDone: page.isDone,
  };
}
