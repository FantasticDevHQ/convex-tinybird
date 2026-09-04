import { ConvexError, v } from "convex/values";

import { mutation } from "./_generated/server";
import { DEFAULT_STUCK_AFTER_MS, DEFAULT_STUCK_LIMIT } from "./budget";
import { boundedBatch } from "./contract";
import { type WorkId, pool } from "./pool";
import { patchSettings, pushHistory, recordActor, scheduleDelivery } from "./state";
import type { MutationCtx } from "./_generated/server";

/**
 * Recovering work that stopped moving.
 *
 * Its own module because the subject is distinct from the state machine in `state.ts` — those
 * are the transitions the delivery path drives, these are the ones nothing drives. It is also
 * the only place in the component that reasons about the Workpool's own state rather than its
 * callbacks.
 */

/**
 * Returns one page of ABANDONED rows to `pending` and puts them back on the pool.
 *
 * The discriminator is the Workpool item, not the clock. A row is abandoned when its work
 * item has FINISHED while the row never advanced — the item completed, was cancelled, or
 * vanished with the process that carried it. Age alone cannot tell that apart from work that
 * is merely waiting, and getting this wrong is not a small error: requeueing a live delivery
 * gives the event a second work item and therefore a second retry budget, which is the
 * FTD-2531 defect, and it sends the event twice.
 *
 * An earlier version of this used age as the criterion and was wrong in both directions:
 *
 *   `markAttemptFailed` sets `pending` and KEEPS `workId` without refreshing `updatedAt`, so
 *   a row in Workpool retry backoff is exactly the shape this hunts. `RETRY_LIMITS` permits
 *   `initialBackoffMs` up to 60 s with `base` up to 4, so a legal policy waits 64 minutes on
 *   its fourth attempt — six times the threshold. Verification measured 4 fetches against a
 *   `maxAttempts: 2` policy: twice the budget, twice the sends.
 *
 *   And the default config reaches it without any backoff at all. `maxParallelism` is 4, so a
 *   backlog of roughly 160 events puts the tail past ten minutes while its items are still
 *   queued and perfectly alive.
 *
 * So the threshold now only BOUNDS the scan — it says which rows are worth asking about — and
 * `statusBatch` decides. One batched call per page rather than one per row.
 *
 * The scan is ordered by `updatedAt`, which matters as much as the discriminator. The first
 * version used `by_state_workId_createdAt` with `gt("workId", undefined)`, and that index is
 * ordered by an OPAQUE Workpool id uncorrelated with age: `take(batch + 1)` therefore took the
 * first hundred by workId and applied age as a filter afterwards, so young rows crowded out
 * old ones — the exact failure the index was chosen to avoid, fixed on one axis and left open
 * on the other. Verification built 101 young rows whose ids sorted before one stranded row and
 * showed it was never found, with `remaining: false` telling the host to stop looking.
 *
 * `workId === undefined` on a `pending` row is also abandoned: that is a row `resume` would
 * rescue, and rescuing it here removes it from the window rather than letting it crowd.
 */
export async function requeueAbandoned(
  ctx: MutationCtx,
  state: "delivering" | "pending",
  cutoff: number,
  batch: number,
  after: number | null,
): Promise<{ requeued: number; visited: number; more: boolean; cursor: number | null }> {
  // A cost guard, not a behaviour, and deliberately NOT pinned by a test. Removing it changes
  // nothing observable — `take(0 + 1)` followed by `slice(0, 0)` selects no rows and still
  // reports `more: true` — so its whole effect is one avoided document read. Verification
  // found this mutant surviving and the honest answer is that it should: a test written to
  // kill it would have to assert something this guard does not actually decide.
  if (batch <= 0) return { requeued: 0, visited: 0, more: true, cursor: after };
  const found = await ctx.db
    .query("events")
    .withIndex("by_state_updatedAt", (q) => {
      const base = q.eq("state", state);
      // The cursor is a LOWER bound on `updatedAt`, and without it this scan cannot make
      // progress past live work. A row skipped for still working is never patched, so its
      // `updatedAt` never moves, so it stays at the head of the index and `take(batch + 1)`
      // reads the same page on every call for ever — `remaining: true` and `requeued: 0`,
      // ten passes a night, indefinitely. Anything behind it is unreachable.
      //
      // That is not a corner case: it is the condition this cron exists to recover from.
      // `maxParallelism` is 4, so a backlog of a few hundred puts the tail past the threshold
      // while every item is queued and healthy, and long retry backoff does the same. Once a
      // page of those sits at the head, they ARE the page.
      //
      // Verification demonstrated it on a real deployment against the previous revision: one
      // abandoned row behind three live rows older than it was never rescued across ten
      // passes, and became rescuable when the only change was making the live rows younger.
      return after === null
        ? base.lt("updatedAt", cutoff)
        : base.gt("updatedAt", after).lt("updatedAt", cutoff);
    })
    .take(batch + 1);
  const selected = found.slice(0, batch);

  // One status call for the whole page. Asking per row would put a component call inside the
  // loop, which is the cost shape this package has repeatedly got wrong.
  const scheduled = selected.filter((event) => event.workId !== undefined);
  const statuses =
    scheduled.length === 0
      ? []
      : await pool.statusBatch(
          ctx,
          scheduled.map((event) => event.workId as WorkId),
        );
  const stillWorking = new Set<string>();
  scheduled.forEach((event, index) => {
    // Anything that is not `finished` is alive — `pending` in the pool's queue or `running`.
    // Leave it alone; it will advance on its own, and a second item would not help.
    if (statuses[index]?.state !== "finished") stillWorking.add(event.workId as string);
  });

  let requeued = 0;
  for (const event of selected) {
    if (event.workId !== undefined && stillWorking.has(event.workId)) continue;

    // A pending row with NO pointer was never delivering, so nothing about it went wrong. It
    // is simply unscheduled — waiting for `resume`, or for an append token — and that is
    // `resume`'s case, reached here only so such rows cannot crowd the window.
    //
    // Rescheduling it is right; calling it STUCK is not. An earlier revision tagged every one
    // of them and overwrote `lastError`, so on a paused instance the whole waiting backlog was
    // relabelled "No progress for 30 minutes" and each row's real 503 was pushed out of view —
    // inventing a fault for rows that are behaving exactly as designed, on the one surface an
    // operator would consult to find out why.
    if (event.workId === undefined) {
      // Nothing to do while paused: `scheduleDelivery` would decline, and patching would churn
      // `updatedAt` on rows that are fine.
      if (await scheduleDelivery(ctx, event._id)) requeued += 1;
      continue;
    }

    await ctx.db.patch(event._id, {
      state: "pending",
      // Cleared so `resume` can see the row as well. Leaving it set is what made the second
      // stranding path invisible in the first place.
      workId: undefined,
      updatedAt: Date.now(),
      lastError: {
        category: "stuck" as const,
        message: `No progress for ${Math.round((Date.now() - event.updatedAt) / 60000)} minutes`,
        at: Date.now(),
      },
      // The failure that was on the row is PRESERVED, like every other transition here.
      // Without this the rescue was the only place in this file that overwrote `lastError`
      // without calling `pushHistory`, so the 503 an operator needs in order to understand
      // why delivery was failing is replaced by "no progress for 30 minutes" — a message that
      // describes the rescue and not the fault.
      previousErrors: pushHistory(event.previousErrors, event.lastError),
    });
    // Counted here, not after `scheduleDelivery`. The row HAS been rescued — its pointer is
    // cleared and `resume` can reach it — even when scheduling is declined because the
    // instance is paused or unconfigured. Reporting 0 for rows this call modified was how the
    // window defect above stayed invisible: `requeued: 0, remaining: false` looks like
    // "nothing to do" and is indistinguishable from "found nothing".
    requeued += 1;
    await scheduleDelivery(ctx, event._id);
  }
  // Computed from the UNFILTERED page, so a page full of live work still reports that more
  // rows are waiting rather than telling the host to stop.
  const more = found.length > selected.length;
  return {
    requeued,
    visited: selected.length,
    more,
    // Carried forward only while the page was full. A short page means the end of the range,
    // and returning null there restarts the next pass at the beginning — which is what makes
    // rows skipped for being alive get looked at again once their work has finished.
    cursor: more ? (selected.at(-1)?.updatedAt ?? after) : null,
  };
}

/**
 * Returns rows that have stopped moving to `pending` and puts them back on the pool.
 *
 * The state machine has no timer of its own. Every transition out of `delivering` is driven
 * by the Workpool item running the delivery, so if the process carrying that item dies, the
 * row stays `delivering` and nothing ever looks at it again. `health` counts it as unfinished
 * for ever and the outbox reports a backlog that nothing drains.
 *
 * Host-scheduled, like `cleanup`, and for the same reason: the component owns no cron. Run it
 * BEFORE `cleanup` in the same job — a rescued row is `pending` and therefore outside
 * retention, so the ordering costs nothing, whereas the reverse leaves a stuck row unexamined
 * for one whole interval.
 *
 * This is where the at-least-once contract is paid for. An event Tinybird accepted whose
 * acknowledgement never reached us is indistinguishable from one that was never sent, so it
 * is sent again; deduplication is Tinybird's, on `event_id`. The alternative — assuming an
 * unacknowledged send succeeded — is at-most-once, and loses events instead of duplicating
 * them.
 */
export const requeueStuck = mutation({
  args: {
    olderThanMs: v.optional(v.number()),
    limit: v.optional(v.number()),
    actor: v.optional(v.string()),
    cursor: v.optional(
      v.object({
        delivering: v.union(v.number(), v.null()),
        pending: v.union(v.number(), v.null()),
      }),
    ),
  },
  returns: v.object({
    requeued: v.number(),
    remaining: v.boolean(),
    cursor: v.object({
      delivering: v.union(v.number(), v.null()),
      pending: v.union(v.number(), v.null()),
    }),
  }),
  handler: async (ctx, args) => {
    // Validated rather than clamped, exactly as the retention thresholds are, and for the
    // identical hazard: Convex orders `NaN` above every finite number, so a cutoff of `NaN`
    // makes `lt("updatedAt", cutoff)` match every row and this call would re-send everything
    // in flight. A negative threshold puts the cutoff in the future and does the same.
    const olderThanMs = args.olderThanMs ?? DEFAULT_STUCK_AFTER_MS;
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
      throw new ConvexError({ code: "invalid_threshold" as const, olderThanMs });
    }

    const budget = boundedBatch(args.limit, DEFAULT_STUCK_LIMIT, DEFAULT_STUCK_LIMIT);
    const cutoff = Date.now() - olderThanMs;

    // One budget across both scans, not one each — the same rule `cleanup` follows, so that a
    // caller passing `limit: 3` bounds the transaction rather than authorising six rescues.
    //
    // But the first scan gets at most HALF, so it cannot starve the second. Rows skipped for
    // being alive still consume the budget — they had to be read to be judged — so a
    // saturated pool produces a full page of old `delivering` rows that are all healthy, on
    // every call, for ever. Spending the whole budget there would mean the `pending` scan
    // never runs and a stranded row behind it is never found: not slow, never. Half is the
    // crudest split that makes that impossible, and whatever the first scan leaves unspent
    // still passes to the second, so the common case where there is little to do is unchanged.
    const share = Math.ceil(budget / 2);
    const crashed = await requeueAbandoned(
      ctx,
      "delivering",
      cutoff,
      share,
      args.cursor?.delivering ?? null,
    );
    const stranded = await requeueAbandoned(
      ctx,
      "pending",
      cutoff,
      budget - crashed.visited,
      args.cursor?.pending ?? null,
    );

    const requeued = crashed.requeued + stranded.requeued;

    // Recorded only when something was actually rescued. `lastOperatorAction` is a single slot
    // shared with pause, resume, both replays and cleanup, and this runs on a cron — writing
    // it on every no-op pass would erase the record of the last human action within a day,
    // which is the defect FTD-2502 fixed for `cleanup`. Accepting `actor` and then never using
    // it was the opposite failure: the README documents passing it and nothing was written.
    if (requeued > 0) {
      await patchSettings(ctx, {
        lastOperatorAction: {
          kind: "requeueStuck" as const,
          actor: recordActor(args.actor),
          at: Date.now(),
          count: requeued,
        },
      });
    }

    return {
      requeued,
      remaining: crashed.more || stranded.more,
      // Two positions, because the scans walk two independent ranges. Carry the whole object
      // back unchanged; a caller that ignores it still makes progress whenever the head of a
      // range is actionable, but cannot get past a page of live work.
      cursor: { delivering: crashed.cursor, pending: stranded.cursor },
    };
  },
});
