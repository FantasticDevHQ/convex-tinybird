import { api } from "./_generated/api";
import {
  codeOf,
  drain,
  installComponentTestHooks,
  jsonResponse,
  row,
  setup,
  type TestInstance,
} from "../testing/fixtures";

installComponentTestHooks();

/**
 * `mockImplementation`, never `mockResolvedValue`.
 *
 * A `Response` body can be read once. `mockResolvedValue` hands every call the SAME object, so
 * the second delivery in these tests read an exhausted body and failed with "HTTP 200 without
 * readable row counts" — a fixture artifact that looks exactly like a product defect, and the
 * only tests it can affect are the ones that deliver twice, which is every test here that
 * matters.
 */
const accepted = { successful_rows: 1, quarantined_rows: 0 };
const MINUTE = 60 * 1000;

/**
 * An event with a REAL Workpool item, parked in `state` at a given age.
 *
 * The `settled` flag is the whole point of this helper, because it is the axis the code
 * actually branches on. A stranded row is one whose work item has FINISHED while the row
 * never advanced; a row whose item is still queued or running is merely waiting, and
 * requeueing it would hand the event a second retry budget.
 *
 * Fake `workId` strings cannot test any of this — the pool validates them as ids for its own
 * table and throws. An earlier version of this file used `"w-gone"` and friends, which meant
 * every assertion here was made against a code path that never reached the pool at all.
 */
async function parked(
  t: TestInstance,
  id: string,
  opts: {
    state: "pending" | "delivering";
    ageMs: number;
    /** true: drain first, so the work item finishes. false: leave it live. */
    settled: boolean;
    /** false to leave the pointer cleared, the shape a completed delivery really has. */
    keepPointer?: boolean;
  },
) {
  await t.mutation(api.lib.enqueue, { datasource: "events", eventId: id, payload: row });
  // Captured BEFORE draining, because a completed delivery clears the pointer. Restoring it
  // afterwards is the only way to build the row this ticket is about: `workId` present,
  // work item finished. Without this the fixture produces a row with no pointer at all, which
  // `resume` can already see, so the test asserts nothing about the defect.
  const workId = await t.run(async (ctx) => (await ctx.db.query("events").first())?.workId);
  if (opts.settled) await drain(t);
  await t.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_identity", (q) => q.eq("datasource", "events").eq("eventId", id))
      .unique();
    await ctx.db.patch(event!._id, {
      state: opts.state,
      updatedAt: Date.now() - opts.ageMs,
      ...(opts.keepPointer === false ? {} : { workId }),
    });
  });
}

async function stateOf(t: TestInstance, id: string) {
  return t.run(async (ctx) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_identity", (q) => q.eq("datasource", "events").eq("eventId", id))
      .unique();
    return event === null
      ? null
      : {
          state: event.state,
          // A BOOLEAN, not the raw `workId`. `toMatchObject({ workId: undefined })` cannot
          // distinguish an absent key from an unset one and passes for a row never touched.
          hasWorkId: event.workId !== undefined,
          category: event.lastError?.category,
          // A boolean for the same reason as `hasWorkId`: `toMatchObject({ category:
          // undefined })` passes for a row this code never looked at.
          tagged: event.lastError?.category === "stuck",
        };
  });
}

describe("requeueing work that stopped moving", () => {
  it("requeues a row whose work item finished without advancing it", async () => {
    const fetchSpy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await parked(t, "crashed", { state: "delivering", ageMs: 30 * MINUTE, settled: true });

    expect(await t.mutation(api.lib.requeueStuck, {})).toMatchObject({ requeued: 1 });
    await drain(t);

    // Delivered again, not merely re-stated. The state alone would pass for an implementation
    // that flips the row and never reschedules.
    expect(await stateOf(t, "crashed")).toMatchObject({ state: "delivered" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("leaves a delivery whose work item is still alive, however old the row looks", async () => {
    // The control that the age-based version failed. `maxParallelism` is 4, so a backlog of a
    // few hundred events puts the tail past ten minutes while every item is queued and
    // perfectly healthy. Requeueing one gives the event a second work item and a second retry
    // budget, and sends it twice — the FTD-2531 defect, reached without any crash at all.
    const fetchSpy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await parked(t, "queued", { state: "pending", ageMs: 30 * MINUTE, settled: false });

    expect(await t.mutation(api.lib.requeueStuck, {})).toMatchObject({ requeued: 0 });
    // Untouched: no `stuck` tag, and the original pointer intact.
    expect(await stateOf(t, "queued")).toMatchObject({
      state: "pending",
      hasWorkId: true,
      tagged: false,
    });

    // And it still delivers exactly once on its own.
    await drain(t);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the workId of a stranded pending row, so resume can finally see it", async () => {
    // The second stranding path. `resume` finds unscheduled work with
    // `by_state_workId_createdAt` filtered to `workId === undefined`, so a row released for
    // retry whose item then vanished keeps its pointer and is invisible to resume for ever,
    // while `health` still counts it as unfinished.
    //
    // The instance is PAUSED so the cleared pointer is observable: on the happy path
    // `scheduleDelivery` immediately sets a new one, and asserting `hasWorkId: false` there
    // would pass for an implementation that never clears it. That mutant survived once.
    const fetchSpy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await parked(t, "stranded", { state: "pending", ageMs: 30 * MINUTE, settled: true });
    await t.mutation(api.lib.pause, { actor: "alice@example.com" });

    // Before: resume walks straight past it, and the pointer is still there.
    expect(await t.mutation(api.lib.resume, {})).toMatchObject({ requeued: 0 });
    expect(await stateOf(t, "stranded")).toMatchObject({ hasWorkId: true });
    await t.mutation(api.lib.pause, {});

    await t.mutation(api.lib.requeueStuck, {});

    expect(await stateOf(t, "stranded")).toMatchObject({
      state: "pending",
      hasWorkId: false,
      category: "stuck",
    });

    // After: resume reaches it and it is delivered. "Invisible before, delivered after."
    expect(await t.mutation(api.lib.resume, {})).toMatchObject({ requeued: 1 });
    await drain(t);
    expect(await stateOf(t, "stranded")).toMatchObject({ state: "delivered" });
  });

  it("does not requeue a row that is merely young", async () => {
    const fetchSpy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await parked(t, "recent", { state: "delivering", ageMs: 1 * MINUTE, settled: true });

    expect(await t.mutation(api.lib.requeueStuck, {})).toMatchObject({ requeued: 0 });
    expect(await stateOf(t, "recent")).toMatchObject({ state: "delivering" });
  });

  it("re-sends an event Tinybird accepted but never acknowledged to us", async () => {
    // The at-least-once boundary, stated as a test. The request was made and succeeded; the
    // acknowledgement never landed, so the row stayed `delivering`. Requeueing sends it a
    // SECOND time, and that is the contract rather than a bug — dedupe is Tinybird's job on
    // `event_id`. If this ever asserts one call, the contract has quietly become at-most-once
    // and events will be lost instead of duplicated.
    const fetchSpy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await parked(t, "unacked", { state: "delivering", ageMs: 30 * MINUTE, settled: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await t.mutation(api.lib.requeueStuck, {});
    await drain(t);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("reports that more remain when the page is full of live work", async () => {
    // The window defect. An earlier version scanned `by_state_workId_createdAt`, which is
    // ordered by an opaque Workpool id uncorrelated with age, and applied age as a filter
    // afterwards — so young rows crowded out old ones and `remaining` was computed from the
    // filtered set, reporting `false` and telling the host to stop looking.
    //
    // `remaining` is now computed from the unfiltered page, so a page the scan declines to act
    // on still says there is more behind it.
    const fetchSpy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    for (let i = 0; i < 3; i += 1) {
      await parked(t, `live-${i}`, { state: "pending", ageMs: 30 * MINUTE, settled: false });
    }

    const result = await t.mutation(api.lib.requeueStuck, { limit: 2 });
    expect(result.requeued).toBe(0);
    expect(result.remaining).toBe(true);
  });

  it("spends one limit across both scans", async () => {
    const fetchSpy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await parked(t, "d1", { state: "delivering", ageMs: 30 * MINUTE, settled: true });
    await parked(t, "d2", { state: "delivering", ageMs: 30 * MINUTE, settled: true });
    await parked(t, "p1", { state: "pending", ageMs: 30 * MINUTE, settled: true });

    // Two, not three: a limit of 2 bounds the call rather than authorising two per scan.
    expect(await t.mutation(api.lib.requeueStuck, { limit: 2 })).toMatchObject({
      requeued: 2,
      remaining: true,
    });
  });

  it("refuses a threshold it cannot compare against", async () => {
    // `NaN` sorts above every finite number in Convex, so `lt("updatedAt", NaN)` matches every
    // row — a threshold of `NaN` would sweep up everything in flight. Same hazard as the
    // retention thresholds, same fix.
    //
    // `codeOf` and not `rejects.toThrow()`: a bare toThrow passes when the mutation does not
    // exist at all, which is the state this test was written in.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => jsonResponse(200, accepted)),
    );
    const t = setup();
    await parked(t, "live", { state: "delivering", ageMs: 0, settled: false });

    for (const olderThanMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(await codeOf(t.mutation(api.lib.requeueStuck, { olderThanMs }))).toBe(
        "invalid_threshold",
      );
    }
    expect(await stateOf(t, "live")).toMatchObject({ state: "delivering" });
  });
});
