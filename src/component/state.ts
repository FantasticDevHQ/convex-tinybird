import { ConvexError } from "convex/values";
import type { Infer } from "convex/values";

import { hasAppendToken, readAppendToken } from "./credentials.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import {
  type BoundedCount,
  COUNT_CAP,
  type EventState,
  MAX_ERROR_HISTORY,
  type vDeliveryError,
  type vHeartbeat,
  type vOperatorAction,
  type vPausedReason,
} from "./contract.js";
import { EVENT_ROW_BYTES, PAYLOAD_ROW_OVERHEAD_BYTES } from "./budget.js";
import { pool } from "./pool.js";
import { sanitizeMessage } from "./sanitize.js";

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
    lastCleanupAt?: number;
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
    lastCleanupAt: settings?.lastCleanupAt,
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
    lastErrorCategory: undefined,
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
 * The pointer saves the index LOOKUP, not the payload bytes. `ctx.db.delete(id)` reads the
 * document it deletes and charges its size, so both paths pay for the payload; what the
 * pointer avoids is scanning `by_event` to find it. The sweep's byte budget in
 * `sweepExpired` is what keeps that cost bounded, and it is sized from each row's stored
 * `payloadBytes` rather than from an assumption.
 *
 * The index lookup survives only as a fallback for a row whose pointer was never recorded —
 * a half-written path, or data predating the field — because leaking the payload would be
 * worse than paying for one read. Note that every row written before this component gained
 * `payloadId` takes that fallback, so it is the FIRST sweep that pays it, not a rare one.
 */
export async function deleteEventWithPayload(
  ctx: MutationCtx,
  event: Doc<"events">,
): Promise<void> {
  if (event.payloadId !== undefined) {
    // Tolerates a STALE pointer, and this is not defensive padding. FTD-2531 dead-letters an
    // event whose payload row has gone, and nothing clears the pointer when that happens
    // because the row vanished by some means outside this component. Deleting a missing
    // document throws, and the throw would take down the whole sweep — every later call
    // hitting the same row and failing again, so retention never runs for anything until
    // someone intervenes by hand.
    try {
      await ctx.db.delete(event.payloadId);
    } catch (error) {
      // Asks the DATABASE whether the row is gone, rather than reading the error message.
      // Gone is the outcome we wanted; a row that is still there means the delete failed
      // for a real reason and the error is rethrown, because the next line deletes the
      // event regardless and would otherwise manufacture exactly the orphan
      // `reclaimOrphanedPayloads` exists to find.
      //
      // An earlier version of this matched `/non-existent doc/iu`, and that was a live
      // production bug rather than a style point. The two spellings are NOT the same:
      //
      //   convex-test 0.0.55  `Delete on non-existent doc`
      //   convex backend      `Delete on nonexistent document ID {id}`
      //
      // The hyphenated form appears nowhere in the backend, so in production that guard
      // rethrew on the one case it existed to tolerate and restored the permanent wedge —
      // while both tests covering the wedge stayed green, because the only string that
      // satisfies the regex is one the harness invents. A test suite cannot catch that
      // class of mistake at all: the harness IS the thing being matched against.
      //
      // The extra read costs nothing on the success path, and this branch turns on a
      // database fact rather than a message, so it holds for any Convex version.
      if ((await ctx.db.get(event.payloadId)) !== null) throw error;
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
  args: {
    state: "delivered" | "failed";
    /** Rows are swept when `updatedAt` is strictly below this. */
    cutoff: number;
    /** The row cap. The weaker of the two bounds; see `DEFAULT_CLEANUP_LIMIT`. */
    batch: number;
    /** The real bound, spent against each row's recorded `payloadBytes`. */
    byteBudget: number;
    /**
     * Whether this sweep may take its first row over budget. True for at most ONE sweep per
     * call: `cleanup` runs two, and letting each have a free row makes the guarantee
     * `budget + worstRow` rather than `budget`.
     */
    mayExemptFirstRow: boolean;
  },
): Promise<{ deleted: number; more: boolean; bytesSpent: number }> {
  const { state, cutoff, batch, byteBudget, mayExemptFirstRow } = args;
  // `updatedAt`, not `createdAt`: retention runs from when the event FINISHED. Both
  // `markDelivered` and `markFailed` set it as they move the row into its terminal state,
  // so for a swept row it is the moment it stopped being work.
  //
  // Creation time would be wrong in the case that matters most. An event that sat `pending`
  // through a long pause and was delivered a moment ago already has a `createdAt` older
  // than any retention, so it would be swept on the very next pass — giving a dedupe window
  // of zero to exactly the events a producer is most likely to re-emit after noticing the
  // outage.
  if (batch <= 0) return { deleted: 0, more: true, bytesSpent: 0 };
  const found = await ctx.db
    .query("events")
    .withIndex("by_state_updatedAt", (q) => q.eq("state", state).lt("updatedAt", cutoff))
    .take(batch + 1);

  // Bounded by BYTES as well as by rows, because the row cap alone cannot be safe. Deleting
  // a document reads it (see `PAYLOAD_ROW_OVERHEAD_BYTES`), the payload bound is a per-call
  // host option this mutation cannot see, and 200 rows at the default 64 KiB bound is about
  // 13 MiB against an 8 MiB limit. What the sweep CAN see is `payloadBytes`, recorded on
  // each event when it was enqueued — so the budget is spent against the real sizes rather
  // than against an assumption about them.
  // Seeded with the INDEX SCAN, which happens above and for every row found — not only for
  // the rows this sweep goes on to delete. Charging the scan per deleted row assumed those
  // two populations were the same, which is true when the row cap binds and false exactly
  // when the byte budget binds. A full page at the payload cap is about 1.1 MiB read before
  // the first budget check.
  let bytesSpent = found.length * EVENT_ROW_BYTES;
  let deleted = 0;
  for (const event of found.slice(0, batch)) {
    // The payload is read ONCE when the pointer is set and TWICE when it is not: the
    // fallback finds the row through `by_event` — which returns the document — and then
    // deletes it, and a delete re-reads what it deletes. The distinction matters more than
    // it looks: every row written before this component gained `payloadId` takes the
    // fallback, so the FIRST sweep after deploying it pays double on every row. Charging
    // one there would put the sweep over budget on precisely the run nobody has rehearsed.
    const payloadReads = event.payloadId === undefined ? 2 : 1;
    // `EVENT_ROW_BYTES` once more, for the delete's own read of the event. The scan's copy is
    // already in `bytesSpent` above.
    const cost = EVENT_ROW_BYTES + payloadReads * (event.payloadBytes + PAYLOAD_ROW_OVERHEAD_BYTES);
    // The first row goes regardless of what it costs: one row cannot come near the limit,
    // and a sweep that declines to make progress is the wedge this component keeps
    // rediscovering — refusing the largest row would strand it, and it sorts first in every
    // later batch.
    //
    // `mayExemptFirstRow` makes that exemption once per CALL rather than once per sweep. It
    // was per sweep, so `cleanup` — which sweeps delivered and then failed — could exempt a
    // row in each and overshoot by a full worst row: measured at 104% of the budget, 118% in
    // the worst case. Safe against the real limit, but not the bound the comment claimed,
    // and an unbounded overshoot is exactly what a byte budget exists to prevent.
    const exempt = mayExemptFirstRow && deleted === 0;
    if (!exempt && bytesSpent + cost > byteBudget) {
      return { deleted, more: true, bytesSpent };
    }
    await deleteEventWithPayload(ctx, event);
    bytesSpent += cost;
    deleted += 1;
  }
  return { deleted, more: found.length > deleted, bytesSpent };
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
  after: number | null,
): Promise<{ reclaimed: number; scanned: number; cursor: number | null; isDone: boolean }> {
  // A MANUAL cursor over `_creationTime`, and not `.paginate()`, because paginate is
  // forbidden inside a Convex component. The backend bails with
  // `PaginationUnsupportedInComponents` — `crates/isolate/src/environment/udf/
  // async_syscall.rs:1773` — for any non-root component, which this package is by
  // construction. An earlier revision used `.paginate()` here and was 100% dead on every
  // call in production while all 228 tests passed, because convex-test implements paginate
  // in plain JavaScript with no component check. The harness cannot see component-scoped
  // restrictions AT ALL; only a real push can.
  //
  // A plain `.take(batch)` cannot substitute. Healthy rows are never deleted, so they hold
  // the front of the table permanently and an unordered take rescans the same page forever —
  // an orphan behind it is invisible for good. Not slow progress: no progress.
  //
  // Progress is per PASS, not per call. `isDone` returns a null cursor, so the next pass
  // restarts at the beginning and picks up anything inserted behind a scan that had already
  // gone past — reachable, because `_creationTime` is fixed at transaction BEGIN, so a
  // transaction that starts earlier and commits later lands below the cursor. That makes such
  // a row transiently invisible and bounded by one pass. "One pass" is not necessarily
  // short: at the default limit of 2, a pass over 100 000 payload rows is 50 000 calls.
  //
  // `by_creation_time` is built in on every table (`system_fields.d.ts:40`), so this costs no
  // schema change.
  //
  // `gt` rather than `gte`, and the safety of that is PROVEN within a transaction and ASSUMED
  // across them. Stated as two things because they are two things:
  //
  //   proven   — a transaction advances `next_creation_time` past every document it observes
  //              (`transaction.rs:527`) and increments with `next_up()` on the float
  //              (`common/src/document.rs:218`), so rows written together cannot collide.
  //   assumed  — the per-transaction base is `max(snapshot_ts, wall_clock)` fixed at BEGIN
  //              (`database.rs:959`). Two transactions sharing a snapshot whose wall clock
  //              has not passed it would take the same base, and nothing makes them conflict:
  //              neither reads `by_creation_time`, so OCC sees no overlap. No enforcement
  //              point was found.
  //
  // Convex clearly INTENDS uniqueness — `_creationTime` is its own index tiebreaker
  // (`system_fields.ts:56`), which only works if unique — but intent is not enforcement. A
  // collision would be permanent rather than transient: `gt` lands on the same value on every
  // pass, so the row behind it is invisible for good, which is this function's recurring
  // failure. It is left as is because two inserts colliding on a float at that resolution is
  // vanishingly unlikely, and the fix is not free: carrying `(creationTime, id)`, querying
  // `gte`, and skipping the carried id costs a re-read of a whole payload row on every call.
  //
  // If that trade ever looks wrong, this comment is the argument to revisit, not to trust.
  const rows = await ctx.db
    .query("payloads")
    .withIndex("by_creation_time", (q) => (after === null ? q : q.gt("_creationTime", after)))
    .take(batch);

  let reclaimed = 0;
  for (const stored of rows) {
    if ((await ctx.db.get(stored.eventId)) === null) {
      await ctx.db.delete(stored._id);
      reclaimed += 1;
    }
  }

  // A short page means the end of the table. Deliberately NOT `take(batch + 1)`: the extra
  // row would be a whole payload document read, and payloads are the expensive thing here.
  // The cost of this is one extra empty call when the table size is an exact multiple.
  const isDone = rows.length < batch;
  return {
    reclaimed,
    // `scanned` alone cannot answer "are there orphans anywhere" — that is what `isDone`
    // is for. It is reported so a caller can tell a clean page from an empty one.
    scanned: rows.length,
    cursor: isDone ? null : (rows.at(-1)?._creationTime ?? null),
    isDone,
  };
}
