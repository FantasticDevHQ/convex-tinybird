import { api } from "./_generated/api";
import {
  codeOf,
  drain,
  enqueueOne,
  installComponentTestHooks,
  jsonResponse,
  seedEvent,
  setup,
  type TestInstance,
} from "../testing/fixtures";

installComponentTestHooks();

const accepted = { successful_rows: 1, quarantined_rows: 0 };
const MINUTE = 60 * 1000;

/**
 * A row parked in a given state with an age, and optionally a `workId`.
 *
 * `workId` is the axis that matters most here: a `pending` row that still carries one is
 * invisible to `resume`, which looks up unscheduled work by `workId === undefined` because
 * that is the only shape an index can answer. A fixture that never sets it cannot see the
 * defect this ticket exists to fix.
 */
async function parked(
  t: TestInstance,
  id: string,
  state: "pending" | "delivering",
  ageMs: number,
  workId?: string,
) {
  await t.run(async (ctx) => {
    const eventId = await seedEvent(ctx, {
      datasource: "events",
      eventId: id,
      state,
      attempts: 1,
      createdAt: Date.now() - ageMs,
      updatedAt: Date.now() - ageMs,
    });
    if (workId !== undefined) await ctx.db.patch(eventId, { workId });
  });
}

async function stateOf(t: TestInstance, id: string) {
  return t.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_identity", (q) => q.eq("datasource", "events").eq("eventId", id))
      .unique();
    // `hasWorkId` as a BOOLEAN, not the raw `workId`. `toMatchObject({ workId: undefined })`
    // is ambiguous — an absent key and a key set to undefined are not distinguished, and the
    // assertion can pass for a row this function never touched. A boolean cannot.
    return event === null
      ? null
      : {
          state: event.state,
          workId: event.workId,
          hasWorkId: event.workId !== undefined,
          category: event.lastError?.category,
        };
  });
}

describe("requeueing work that stopped moving", () => {
  it("returns delivering rows past the threshold and leaves younger ones alone", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    const t = setup();
    await parked(t, "stuck", "delivering", 30 * MINUTE, "w-old");
    await parked(t, "recent", "delivering", 1 * MINUTE, "w-new");

    const result = await t.mutation(api.lib.requeueStuck, {});

    expect(result).toMatchObject({ requeued: 1, remaining: false });
    // The stuck one is back at work, tagged so an operator can tell this from a real failure.
    expect(await stateOf(t, "stuck")).toMatchObject({ category: "stuck" });
    // And the young one is untouched. Without this the test passes for an implementation that
    // requeues every delivering row, which would re-send everything in flight on every cron.
    expect(await stateOf(t, "recent")).toMatchObject({ state: "delivering", workId: "w-new" });
  });

  it("clears the workId of a stranded pending row, so resume can finally see it", async () => {
    // The second stranding path, and the assertions have to be chosen carefully because the
    // obvious ones are vacuous. `resume` finds unscheduled work with
    // `by_state_workId_createdAt` filtered to `workId === undefined`, since an index lookup is
    // the only shape that cannot be crowded out. A row returned to `pending` by a retry
    // release whose Workpool item then vanished keeps its `workId`, so resume walks past it
    // for ever while `health` still counts it as unfinished.
    //
    // Asserting "state is pending" afterwards proves NOTHING — it was already pending. And
    // asserting `workId === undefined` proves nothing either on the happy path, because
    // `scheduleDelivery` immediately sets a new one. Both mutants survived exactly that way.
    //
    // So the instance is PAUSED. `scheduleDelivery` declines while paused, which is what makes
    // the cleared pointer observable at all, and it is also the real shape of the bug: an
    // operator pauses, work strands, and the pointer has to be gone before resume can help.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    const t = setup();
    await t.mutation(api.lib.pause, { actor: "alice@example.com" });
    await parked(t, "orphaned-work", "pending", 30 * MINUTE, "w-gone");

    // Before: resume cannot see it. Not merely "requeued 0" — the row still holds the pointer.
    expect(await t.mutation(api.lib.resume, {})).toMatchObject({ requeued: 0 });
    expect(await stateOf(t, "orphaned-work")).toMatchObject({ workId: "w-gone" });
    await t.mutation(api.lib.pause, {});

    await t.mutation(api.lib.requeueStuck, {});

    // The pointer is gone and the row is tagged, which together are the only evidence that
    // this row was rescued rather than merely left alone.
    expect(await stateOf(t, "orphaned-work")).toMatchObject({
      state: "pending",
      hasWorkId: false,
      category: "stuck",
    });

    // And now resume reaches it and it is delivered — "invisible before, delivered after".
    expect(await t.mutation(api.lib.resume, {})).toMatchObject({ requeued: 1 });
    await drain(t);
    expect(await stateOf(t, "orphaned-work")).toMatchObject({ state: "delivered" });
  });

  it("leaves a young pending row with a workId alone", async () => {
    // The control for the case above. A row that was scheduled a moment ago legitimately has
    // a `workId`, and requeueing it would hand the event a second retry budget — the defect
    // FTD-2531 fixed. Only age distinguishes the two.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    const t = setup();
    await parked(t, "fresh-work", "pending", 1 * MINUTE, "w-live");

    expect(await t.mutation(api.lib.requeueStuck, {})).toMatchObject({ requeued: 0 });
    expect(await stateOf(t, "fresh-work")).toMatchObject({ workId: "w-live" });
  });

  it("delivers an event again after a crash between markDelivering and the request", async () => {
    // Fault injection by construction rather than by mocking an internal: a row left
    // `delivering` with an old `updatedAt` is exactly what a process that died after
    // `markDelivering` leaves behind. The point is that it is eventually DELIVERED, not
    // merely that its state changed.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await parked(t, "crashed", "delivering", 30 * MINUTE, "w-dead");

    await t.mutation(api.lib.requeueStuck, {});
    await drain(t);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await stateOf(t, "crashed")).toMatchObject({ state: "delivered" });
  });

  it("re-sends an event Tinybird accepted but never acknowledged to us", async () => {
    // The at-least-once boundary, stated as a test. The request was made and succeeded; the
    // acknowledgement never landed, so the row stays `delivering`. Requeueing sends it a
    // SECOND time, and that is correct behaviour rather than a bug — dedupe is Tinybird's job
    // on `event_id`. If this ever asserts one call, the contract has silently become
    // at-most-once and events will be lost instead of duplicated.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await enqueueOne(t);
    await drain(t);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Put it back the way a lost acknowledgement leaves it: sent, but never marked.
    await t.run(async (ctx) => {
      const event = await ctx.db.query("events").first();
      await ctx.db.patch(event!._id, {
        state: "delivering",
        updatedAt: Date.now() - 30 * MINUTE,
      });
    });

    await t.mutation(api.lib.requeueStuck, {});
    await drain(t);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("spends one limit across both scans and reports whether more remain", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    const t = setup();
    await parked(t, "d1", "delivering", 30 * MINUTE, "w1");
    await parked(t, "d2", "delivering", 30 * MINUTE, "w2");
    await parked(t, "p1", "pending", 30 * MINUTE, "w3");

    const first = await t.mutation(api.lib.requeueStuck, { limit: 2 });
    expect(first).toMatchObject({ requeued: 2, remaining: true });

    const second = await t.mutation(api.lib.requeueStuck, { limit: 2 });
    expect(second.remaining).toBe(false);
  });

  it("refuses a threshold it cannot compare against", async () => {
    // `NaN` sorts above every finite number in Convex, so `lt("updatedAt", NaN)` matches every
    // row — a threshold of `NaN` would requeue everything in flight, which is the same hazard
    // the retention validation exists for and the same fix.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup();
    await parked(t, "live", "delivering", 0, "w-live");

    // `codeOf` and not `rejects.toThrow()`: a bare toThrow passes when the mutation does not
    // exist at all, which is exactly the state this test was written in. It would have gone
    // green before a line of the implementation was written.
    for (const olderThanMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(await codeOf(t.mutation(api.lib.requeueStuck, { olderThanMs }))).toBe(
        "invalid_threshold",
      );
    }
    expect(await stateOf(t, "live")).toMatchObject({ state: "delivering" });
  });
});
