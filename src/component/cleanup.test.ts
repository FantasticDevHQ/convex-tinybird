import { api } from "./_generated/api";
import {
  DEFAULT_CLEANUP_LIMIT,
  EVENT_ROW_READ_BYTES,
  HARD_MAX_PAYLOAD_BYTES,
  MAX_ORPHAN_SCAN_LIMIT,
  PAYLOAD_ROW_OVERHEAD_BYTES,
  SWEEP_READ_BUDGET_BYTES,
} from "./contract";
import {
  codeOf,
  drain,
  enqueueOne,
  installComponentTestHooks,
  jsonResponse,
  seedEvent,
  settingsOf,
  setup,
  type TestInstance,
} from "../testing/fixtures";

installComponentTestHooks();

const accepted = { successful_rows: 1, quarantined_rows: 0 };
const DAY = 24 * 60 * 60 * 1000;

/** Seeds one event in a given state at a given age, with its payload row. */
async function aged(
  t: TestInstance,
  id: string,
  state: "delivered" | "failed" | "pending" | "delivering",
  ageMs: number,
) {
  await t.run(async (ctx) => {
    await seedEvent(ctx, {
      datasource: "events",
      eventId: id,
      state,
      attempts: 1,
      createdAt: Date.now() - ageMs,
      updatedAt: Date.now() - ageMs,
    });
  });
}

/** Both tables, counted. The pairing is the point; neither number means much alone. */
async function tableCounts(t: TestInstance) {
  return t.run(async (ctx) => {
    // eslint-disable-next-line @convex-dev/no-collect-in-query
    const events = await ctx.db.query("events").collect();
    // eslint-disable-next-line @convex-dev/no-collect-in-query
    const payloads = await ctx.db.query("payloads").collect();
    return { events: events.length, payloads: payloads.length };
  });
}

describe("retention cleanup", () => {
  it("deletes only what is past its retention, and says whether more remain", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await aged(t, "old_delivered", "delivered", 10 * DAY);
    await aged(t, "new_delivered", "delivered", 1 * DAY);
    await aged(t, "old_failed", "failed", 40 * DAY);
    await aged(t, "new_failed", "failed", 10 * DAY);

    expect(await t.mutation(api.lib.cleanup, {})).toEqual({
      deletedDelivered: 1,
      deletedFailed: 1,
      remaining: false,
    });

    const left = await t.run(async (ctx) => {
      // eslint-disable-next-line @convex-dev/no-collect-in-query
      return (await ctx.db.query("events").collect()).map((e) => e.eventId).sort();
    });
    // A `failed` row ten days old survives: its retention is thirty, not seven.
    expect(left).toEqual(["new_delivered", "new_failed"]);
  });

  it("records that it ran, and how much it removed", async () => {
    // A sweep that deletes data and says nothing is the shape in which a wedged sweep
    // reaches production: the only symptom is tables that quietly grow. Every other operator
    // action here records itself, and this one has the strongest claim to.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await aged(t, "a", "delivered", 10 * DAY);
    await aged(t, "b", "failed", 40 * DAY);

    await t.mutation(api.lib.cleanup, { actor: "nightly_cron" });

    expect(await settingsOf(t)).toMatchObject({
      lastOperatorAction: { kind: "cleanup", actor: "nightly_cron", count: 2 },
    });
  });

  it("never touches an event that is still in flight, however old", async () => {
    // The whole safety property. Age is not a reason to delete work nobody has finished.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await aged(t, "ancient_pending", "pending", 400 * DAY);
    await aged(t, "ancient_delivering", "delivering", 400 * DAY);

    expect(await t.mutation(api.lib.cleanup, {})).toMatchObject({
      deletedDelivered: 0,
      deletedFailed: 0,
    });
    expect(await tableCounts(t)).toEqual({ events: 2, payloads: 2 });
  });

  it("deletes the payload row with its event, leaving no orphan", async () => {
    // The precondition FTD-2525 attached to this ticket. An orphaned payload is a silent
    // leak: the whole point of the split was to make the counted table cheap, so bytes
    // stranded in the uncounted one are invisible by construction.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await aged(t, "gone", "delivered", 10 * DAY);
    expect(await tableCounts(t)).toEqual({ events: 1, payloads: 1 });

    await t.mutation(api.lib.cleanup, {});

    expect(await tableCounts(t)).toEqual({ events: 0, payloads: 0 });
  });

  it("reclaims a payload whose pointer was never recorded", async () => {
    // A row predating `payloadId`, or one a half-written path left without it. The sweep
    // must still find and delete its payload rather than leaking it — falling back to the
    // index costs a read, which is why it is a fallback and not the path.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await aged(t, "no_pointer", "delivered", 10 * DAY);
    await t.run(async (ctx) => {
      const event = await ctx.db.query("events").first();
      await ctx.db.patch(event!._id, { payloadId: undefined });
    });

    await t.mutation(api.lib.cleanup, {});

    expect(await tableCounts(t)).toEqual({ events: 0, payloads: 0 });
  });

  it("is not wedged by a dead letter whose payload has already gone", async () => {
    // The reachable one, and it stops retention for EVERY row rather than one. FTD-2531
    // dead-letters an event whose payload row is missing — and nothing clears `payloadId`
    // when that happens, because the row vanished by some means outside this component. So
    // the pointer is stale, `ctx.db.delete` on it throws `Delete on non-existent doc`, and
    // the throw takes down the whole sweep. Every later call hits the same row and throws
    // again: retention never runs anywhere again until someone intervenes by hand.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await aged(t, "stale", "failed", 40 * DAY);
    await aged(t, "ordinary", "failed", 40 * DAY);
    await t.run(async (ctx) => {
      const stale = await ctx.db
        .query("events")
        .withIndex("by_identity", (q) => q.eq("datasource", "events").eq("eventId", "stale"))
        .unique();
      // The payload goes; the pointer stays, exactly as a `payload_missing` row has it.
      await ctx.db.delete(stale!.payloadId!);
    });

    expect(await t.mutation(api.lib.cleanup, {})).toMatchObject({ deletedFailed: 2 });
    expect(await tableCounts(t)).toEqual({ events: 0, payloads: 0 });
  });

  it("still tolerates the stale pointer after narrowing the catch", async () => {
    // The narrowing must not undo the wedge fix. A bare catch would have swallowed anything;
    // this one tolerates only "already gone", so the case that actually happens still has to
    // pass through it.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await aged(t, "stale_again", "delivered", 10 * DAY);
    await t.run(async (ctx) => {
      const event = await ctx.db.query("events").first();
      await ctx.db.delete(event!.payloadId!);
    });

    expect(await t.mutation(api.lib.cleanup, {})).toMatchObject({ deletedDelivered: 1 });
    expect(await tableCounts(t)).toEqual({ events: 0, payloads: 0 });
  });

  it("removes a payload row whose event has already gone", async () => {
    // The other orphan. Nothing in the component produces one today, but retention is the
    // only thing that could, so a half-delete would accumulate silently — the uncounted
    // table is uncounted precisely because nothing looks at it.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await aged(t, "orphaned", "delivered", 10 * DAY);
    await t.run(async (ctx) => {
      const event = await ctx.db.query("events").first();
      await ctx.db.delete(event!._id);
    });
    expect(await tableCounts(t)).toEqual({ events: 0, payloads: 1 });

    // Retention does NOT do this: finding an orphan means reading payload rows, and a
    // payload is the one thing here whose size a host controls, so folding the scan into the
    // sweep would put the sweep's cost back on payload size — the coupling `payloadId`
    // exists to remove. It is its own call, run rarely, and allowed to be expensive.
    expect(await t.mutation(api.lib.cleanup, {})).toMatchObject({ deletedDelivered: 0 });
    expect(await tableCounts(t)).toEqual({ events: 0, payloads: 1 });

    expect(await t.mutation(api.lib.reclaimOrphanedPayloads, {})).toMatchObject({
      reclaimed: 1,
      scanned: 1,
      isDone: true,
    });
    expect(await tableCounts(t)).toEqual({ events: 0, payloads: 0 });
  });

  it("finds an orphan that sits past the first scan window", async () => {
    // The fixture that matters, and the one the first version of this test did not have.
    // That one had exactly ONE payload row, which was also the orphan — so the scan window
    // was never tested against a table larger than the window, and a scan that could only
    // ever see the first page passed it.
    //
    // Healthy rows are never deleted, so without a cursor they occupy the window forever and
    // every orphan behind them is invisible for good. Not slow progress: no progress.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    for (let i = 0; i < 12; i += 1) await aged(t, `keep_${i}`, "pending", 0);
    await aged(t, "orphan", "pending", 0);
    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_identity", (q) => q.eq("datasource", "events").eq("eventId", "orphan"))
        .unique();
      await ctx.db.delete(event!._id);
    });

    // Scan in windows far smaller than the table, carrying the cursor as a host would.
    let cursor: string | null = null;
    let reclaimed = 0;
    for (let pass = 0; pass < 20; pass += 1) {
      const result: { reclaimed: number; cursor: string | null; isDone: boolean } =
        await t.mutation(api.lib.reclaimOrphanedPayloads, { limit: 3, cursor });
      reclaimed += result.reclaimed;
      cursor = result.cursor;
      if (result.isDone) break;
    }

    expect(reclaimed).toBe(1);
    expect(await tableCounts(t)).toEqual({ events: 12, payloads: 12 });
  });

  it("measures retention from when the event finished, not when it was created", async () => {
    // An event that sat `pending` through a long pause and was delivered a moment ago has a
    // `createdAt` older than any retention. Sweeping on creation time deletes it on the very
    // next pass — so its dedupe window is zero rather than seven days, for exactly the
    // events most likely to be re-emitted by a producer that noticed the outage.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await t.run(async (ctx) => {
      await seedEvent(ctx, {
        datasource: "events",
        eventId: "late",
        state: "delivered" as const,
        attempts: 1,
        createdAt: Date.now() - 30 * DAY,
        updatedAt: Date.now(),
        deliveredAt: Date.now(),
      });
    });

    expect(await t.mutation(api.lib.cleanup, {})).toMatchObject({ deletedDelivered: 0 });
    expect(await tableCounts(t)).toEqual({ events: 1, payloads: 1 });
  });

  it("spends one limit across both states, not one each", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    for (let i = 0; i < 3; i += 1) await aged(t, `d_${i}`, "delivered", 10 * DAY);
    for (let i = 0; i < 3; i += 1) await aged(t, `f_${i}`, "failed", 40 * DAY);

    const result = await t.mutation(api.lib.cleanup, { limit: 3 });
    expect(result.deletedDelivered + result.deletedFailed).toBe(3);
    expect(result.remaining).toBe(true);
    expect((await tableCounts(t)).events).toBe(3);
  });

  it("refuses a retention it cannot compare against", async () => {
    // `NaN` is the dangerous one: Convex orders it above every finite number, so
    // `lt("updatedAt", NaN)` matches every row of that state and the sweep deletes rows one
    // second old. A negative retention puts the cutoff in the future and does the same.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await aged(t, "fresh", "delivered", 0);

    // BOTH retentions, because they are two separate call sites and only one of them was
    // covered. Verification dropped the `retention()` wrapper from the failed side alone and
    // the whole suite stayed green at 222/222; a `failed` row seeded milliseconds earlier
    // was then deleted by `cleanup({ failedRetentionMs: NaN })` with no error raised. The
    // guard was real and the test was half a test.
    await aged(t, "dead", "failed", 0);

    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(await codeOf(t.mutation(api.lib.cleanup, { deliveredRetentionMs: bad }))).toBe(
        "invalid_retention",
      );
      expect(await codeOf(t.mutation(api.lib.cleanup, { failedRetentionMs: bad }))).toBe(
        "invalid_retention",
      );
    }
    // Both rows still here. Without this the loop proves only that a throw happened, and a
    // throw AFTER the sweep would satisfy it.
    expect(await tableCounts(t)).toEqual({ events: 2, payloads: 2 });
  });

  it("stops at the limit and reports that more remain", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    for (let i = 0; i < 5; i += 1) await aged(t, `old_${i}`, "delivered", 10 * DAY);

    expect(await t.mutation(api.lib.cleanup, { limit: 2 })).toEqual({
      deletedDelivered: 2,
      deletedFailed: 0,
      remaining: true,
    });
    expect(await tableCounts(t)).toEqual({ events: 3, payloads: 3 });
  });

  it("keeps a row that is exactly at the cutoff", async () => {
    // Strictly older than the retention, not at least as old. A boundary that deletes on
    // equality quietly shortens every retention by one tick.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await aged(t, "exactly", "delivered", 7 * DAY);

    expect(await t.mutation(api.lib.cleanup, {})).toMatchObject({ deletedDelivered: 0 });
    expect(await tableCounts(t)).toEqual({ events: 1, payloads: 1 });
  });

  it("frees the identity, so the same event can be enqueued again", async () => {
    // The consequence a host has to know about: the dedupe window IS the retention window.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await enqueueOne(t);
    await drain(t);
    await t.run(async (ctx) => {
      const event = await ctx.db.query("events").first();
      // `updatedAt`, because retention runs from when the event finished. Ageing
      // `createdAt` would leave this row untouched, which is the point of that change.
      await ctx.db.patch(event!._id, { updatedAt: Date.now() - 10 * DAY });
    });

    await t.mutation(api.lib.cleanup, {});
    expect(await tableCounts(t)).toEqual({ events: 0, payloads: 0 });

    // Not a duplicate: there is nothing left to be a duplicate of.
    expect(await enqueueOne(t)).toMatchObject({ outcome: "enqueued" });
    await drain(t);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("uses the retentions it is given", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await aged(t, "two_days", "delivered", 2 * DAY);

    expect(await t.mutation(api.lib.cleanup, {})).toMatchObject({ deletedDelivered: 0 });
    expect(await t.mutation(api.lib.cleanup, { deliveredRetentionMs: DAY })).toMatchObject({
      deletedDelivered: 1,
    });
  });

  it("clamps the batch the way every other bounded loop here does", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    for (let i = 0; i < DEFAULT_CLEANUP_LIMIT + 3; i += 1) {
      await aged(t, `old_${i}`, "delivered", 10 * DAY);
    }

    expect(await t.mutation(api.lib.cleanup, { limit: 10_000 })).toMatchObject({
      deletedDelivered: DEFAULT_CLEANUP_LIMIT,
      remaining: true,
    });
    for (const limit of [0, -5, Number.NaN]) {
      const before = (await tableCounts(t)).events;
      const result = await t.mutation(api.lib.cleanup, { limit });
      expect(result.deletedDelivered).toBeGreaterThan(0);
      expect((await tableCounts(t)).events).toBeLessThan(before);
    }
  });

  it("stops on BYTES before the row limit when payloads are large", async () => {
    // The bound the row cap cannot provide. Deleting a document READS it — Convex's
    // `delete_inner` calls `get_inner`, which records `doc.size()` against the read limit —
    // so a batch of 200 at the default 64 KiB payload bound would read about 13 MiB against
    // a limit near 8 MiB and throw. The row cap cannot see that, because the payload bound
    // is a per-call host option and `cleanup` never receives it.
    //
    // Eight rows at the hard cap, against a limit of 200: if only the row cap were enforcing
    // anything, all eight would go.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    const big = "x".repeat(HARD_MAX_PAYLOAD_BYTES);
    for (let i = 0; i < 8; i += 1) {
      await t.run(async (ctx) => {
        await seedEvent(ctx, {
          datasource: "events",
          eventId: `big-${i}`,
          state: "delivered",
          attempts: 1,
          createdAt: Date.now() - 10 * DAY,
          updatedAt: Date.now() - 10 * DAY,
          payload: big,
        });
      });
    }

    const result = await t.mutation(api.lib.cleanup, {});

    // Derived from the constants rather than written as 5, so the expectation moves with the
    // arithmetic instead of pinning a number that agrees with nothing.
    const perRow = EVENT_ROW_READ_BYTES + HARD_MAX_PAYLOAD_BYTES + PAYLOAD_ROW_OVERHEAD_BYTES;
    const fits = Math.floor(SWEEP_READ_BUDGET_BYTES / perRow);
    expect(fits).toBeLessThan(DEFAULT_CLEANUP_LIMIT);
    expect(result.deletedDelivered).toBe(fits);
    expect(result.remaining).toBe(true);
    expect(await tableCounts(t)).toEqual({ events: 8 - fits, payloads: 8 - fits });
  });

  it("keeps the operator's last action when a sweep finds nothing to delete", async () => {
    // `lastOperatorAction` is ONE slot, shared with pause, resume and both replays, and the
    // README tells hosts to run cleanup nightly. Writing it on every sweep meant a cron that
    // deleted nothing erased the record of the last human action within a day — buying the
    // sweep observability by destroying everyone else's.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await t.mutation(api.lib.pause, { actor: "alice@example.com" });

    const result = await t.mutation(api.lib.cleanup, { actor: "nightly cron" });
    expect(result).toMatchObject({ deletedDelivered: 0, deletedFailed: 0 });

    const settings = await settingsOf(t);
    expect(settings?.lastOperatorAction).toMatchObject({
      kind: "pause",
      actor: "alice@example.com",
    });
    // And the sweep is still observable, on its own field. Without this the test would pass
    // just as well if cleanup recorded nothing at all, which is the opposite defect.
    expect(settings?.lastCleanupAt).toEqual(expect.any(Number));
  });

  it("records the sweep in the shared slot when it did delete something", async () => {
    // The other direction. A cleanup that removed rows IS an action worth attributing, so
    // suppressing the write entirely would be the over-correction.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await t.mutation(api.lib.pause, { actor: "alice@example.com" });
    await aged(t, "old", "delivered", 10 * DAY);

    await t.mutation(api.lib.cleanup, { actor: "nightly cron" });

    expect((await settingsOf(t))?.lastOperatorAction).toMatchObject({
      kind: "cleanup",
      actor: "nightly cron",
      count: 1,
    });
  });

  it("caps the orphan scan, so following the docs cannot blow the read budget", async () => {
    // The orphan scan has no byte budget available to it — it reads payload rows to find out
    // whether they are orphans, so their cost is paid before it can be weighed. The row
    // count is its only bound, and an earlier revision removed the ceiling entirely while
    // the README told hosts with small payloads to "pass a far larger one". A host following
    // that advice with `limit: 900` would have read about 70% of the call budget at once.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    for (let i = 0; i < MAX_ORPHAN_SCAN_LIMIT + 3; i += 1) {
      await aged(t, `p_${i}`, "delivered", 0);
    }

    const scan = await t.mutation(api.lib.reclaimOrphanedPayloads, { limit: 10_000 });
    expect(scan.scanned).toBe(MAX_ORPHAN_SCAN_LIMIT);
    // Nothing was an orphan, so the ceiling is the only thing this can be measuring.
    expect(scan.reclaimed).toBe(0);
    expect(scan.isDone).toBe(false);
  });
});
