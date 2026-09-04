import { api } from "./_generated/api";
import {
  codeOf,
  drain,
  installComponentTestHooks,
  jsonResponse,
  row,
  settingsOf,
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
  // Looked up BY IDENTITY, not `.first()`. With more than one event in the table `.first()`
  // returns the earliest, so every row after the first was handed the first row's pointer —
  // a fixture that quietly builds the wrong thing and still passes.
  const workId = await t.run(
    async (ctx) =>
      (
        await ctx.db
          .query("events")
          .withIndex("by_identity", (q) => q.eq("datasource", "events").eq("eventId", id))
          .unique()
      )?.workId,
  );
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

    expect(await t.mutation(api.recovery.requeueStuck, {})).toMatchObject({ requeued: 1 });
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

    expect(await t.mutation(api.recovery.requeueStuck, {})).toMatchObject({ requeued: 0 });
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

    await t.mutation(api.recovery.requeueStuck, {});

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

    expect(await t.mutation(api.recovery.requeueStuck, {})).toMatchObject({ requeued: 0 });
    expect(await stateOf(t, "recent")).toMatchObject({ state: "delivering" });
  });

  it("re-sends an event Tinybird accepted but never acknowledged to us", async () => {
    // The at-least-once boundary, stated as a test. The request was made and succeeded; the
    // acknowledgement never landed, so the row stayed `delivering`. Requeueing sends it a
    // SECOND time, and that is the contract rather than a bug — dedupe is Tinybird's job on
    // `event_id`. If this ever asserts one call, the contract has quietly become at-most-once
    // and events will be lost instead of duplicated.
    // CONSTRUCTED, not injected, and that is a limitation worth stating rather than papering
    // over. Verification asked for the ticket's suggested injection — make `fetch` throw after
    // the request — and I tried it: a throw runs `markAttemptFailed`, which sets `pending`,
    // never `delivering`. (`failed` arrives later, from `onDeliveryComplete`, once the retry
    // budget is spent — an earlier version of this comment conflated the two.) Either way it
    // exercises the retry and dead-letter paths, not this one.
    //
    // The state this test needs is what a process DEATH leaves: the request went out, and no
    // handler ran afterwards because there was no process left to run one. Nothing in-process
    // can produce that, because everything in-process runs to completion. So the state is
    // built directly, and the fixture is honest about being a stand-in for the state rather
    // than a reproduction of the event.
    const fetchSpy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await parked(t, "unacked", { state: "delivering", ageMs: 30 * MINUTE, settled: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await stateOf(t, "unacked"))?.state).toBe("delivering");

    await t.mutation(api.recovery.requeueStuck, {});
    await drain(t);

    // Both halves matter. The call count is the at-least-once contract; the state is the proof
    // that recovery actually completes, which an earlier version of this test never asserted.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await stateOf(t, "unacked")).toMatchObject({ state: "delivered" });
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

    const result = await t.mutation(api.recovery.requeueStuck, { limit: 2 });
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
    expect(await t.mutation(api.recovery.requeueStuck, { limit: 2 })).toMatchObject({
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
      expect(await codeOf(t.mutation(api.recovery.requeueStuck, { olderThanMs }))).toBe(
        "invalid_threshold",
      );
    }
    expect(await stateOf(t, "live")).toMatchObject({ state: "delivering" });
  });

  it("keeps the failure that was on the row, so a rescue is not a diagnosis erased", async () => {
    // The rescue writes `lastError: { category: "stuck" }`, and that message describes the
    // RESCUE, not the fault. An operator investigating a rescued event needs the 503 that was
    // there before it. Every other transition in state.ts preserves it with `pushHistory`;
    // this one did not, which made it the only place in the file that destroyed evidence.
    const fetchSpy = vi
      .fn()
      .mockImplementation(() => jsonResponse(503, { error: "upstream unavailable" }));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    // A real failure first, so there is a real diagnostic to lose.
    await parked(t, "was-failing", { state: "delivering", ageMs: 30 * MINUTE, settled: true });
    const before = await t.run(async (ctx) => (await ctx.db.query("events").first())?.lastError);
    // Read back rather than predicted: the delivery path decides the category, and asserting a
    // guessed literal here tests my model of that path instead of this one. It must simply be
    // a real diagnostic and not already the rescue's own tag.
    expect(before?.category).toBeDefined();
    expect(before?.category).not.toBe("stuck");

    await t.mutation(api.recovery.requeueStuck, {});

    const after = await t.run(async (ctx) => ctx.db.query("events").first());
    expect(after?.lastError?.category).toBe("stuck");
    // Whatever it was is still on the row. Containment rather than index 0, because the
    // delivery path has already pushed its own history and pinning a position would assert
    // `pushHistory`'s ordering instead of the claim this test is making.
    expect(after?.previousErrors?.map((error) => error.category)).toContain(before?.category);
  });

  it("records the rescue in the operator trail, but not on a no-op pass", async () => {
    // `actor` was accepted and never used: the README documents passing it and nothing was
    // written. It is recorded now — and only when something was actually rescued, because
    // `lastOperatorAction` is a single slot shared with pause, resume and both replays, and
    // this runs on a cron. Writing it every pass would erase the last human action within a
    // day, which is exactly the defect FTD-2502 fixed for `cleanup`.
    const fetchSpy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await t.mutation(api.lib.pause, { actor: "alice@example.com" });
    await t.mutation(api.lib.resume, { actor: "alice@example.com" });

    // Nothing to do: the human's action must survive.
    await t.mutation(api.recovery.requeueStuck, { actor: "nightly cron" });
    expect((await settingsOf(t))?.lastOperatorAction).toMatchObject({
      kind: "resume",
      actor: "alice@example.com",
    });

    // Something to do: now it is attributed.
    await parked(t, "rescued", { state: "delivering", ageMs: 30 * MINUTE, settled: true });
    await t.mutation(api.recovery.requeueStuck, { actor: "nightly cron" });
    expect((await settingsOf(t))?.lastOperatorAction).toMatchObject({
      kind: "requeueStuck",
      actor: "nightly cron",
      count: 1,
    });
  });

  it("does not invent a fault for a row that is merely waiting to be resumed", async () => {
    // The pending scan walks by age regardless of pointer, so on a paused instance every
    // waiting row qualifies. Tagging those `stuck` relabels a backlog that is behaving exactly
    // as designed, and overwriting `lastError` pushes each row's real failure out of view — on
    // the one surface an operator consults to find out why delivery stopped.
    //
    // A pending row with no pointer was never delivering. Nothing about it went wrong.
    const fetchSpy = vi
      .fn()
      .mockImplementation(() => jsonResponse(503, { error: "upstream unavailable" }));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    // No pointer: the shape of a row that was never scheduled, or whose delivery completed
    // and cleared it. This is resume's case, not a stranding.
    await parked(t, "waiting", {
      state: "pending",
      ageMs: 30 * MINUTE,
      settled: true,
      keepPointer: false,
    });
    const before = await t.run(async (ctx) => (await ctx.db.query("events").first())?.lastError);
    expect(before?.category).toBeDefined();
    await t.mutation(api.lib.pause, { actor: "alice@example.com" });

    await t.mutation(api.recovery.requeueStuck, {});

    const after = await stateOf(t, "waiting");
    expect(after).toMatchObject({ state: "pending", tagged: false });
    // Its real diagnosis is untouched, not merely preserved one step back.
    expect((await t.run(async (ctx) => ctx.db.query("events").first()))?.lastError?.category).toBe(
      before?.category,
    );
  });

  it("stops at the limit and still reports that more is waiting", async () => {
    // `limit: 1` gives the delivering scan the whole share, leaving the pending scan nothing.
    //
    // This does NOT test the `batch <= 0` guard, and saying so matters: removing that guard
    // leaves every assertion here true, because `take(0 + 1)` then `slice(0, 0)` produces the
    // same result by a longer route. The guard saves one read and decides nothing. What this
    // does test is that a call which runs out of budget reports `remaining: true` rather than
    // declaring itself finished.
    const fetchSpy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await parked(t, "d1", { state: "delivering", ageMs: 30 * MINUTE, settled: true });
    await parked(t, "p1", { state: "pending", ageMs: 30 * MINUTE, settled: true });

    const result = await t.mutation(api.recovery.requeueStuck, { limit: 1 });

    // One rescue, and the pending row untouched because there was no budget left for it — but
    // the call must still say there is more to do rather than reporting itself finished.
    expect(result).toMatchObject({ requeued: 1, remaining: true });
    expect(await stateOf(t, "p1")).toMatchObject({ tagged: false });
  });

  it("rescues past a pointer the pool cannot parse, instead of failing wholesale", async () => {
    // One unparseable `workId` used to disable the entire recovery path, permanently.
    // `statusBatch` takes `v.array(v.id("work"))` while the schema declares `v.string()`, and
    // argument validation runs BEFORE the handler — so the throw is not something the loop can
    // step over. Every cron run failed, nothing was rescued, and the healthy abandoned row
    // beside the bad one waited for ever.
    //
    // Verification reproduced that on a real deployment with a control, having first hit it by
    // accident on its own seeded rows. `scheduleDelivery` is the only writer today, but a
    // `convex import`, a restored snapshot or a manual repair all produce one.
    const fetchSpy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await parked(t, "healthy", { state: "delivering", ageMs: 30 * MINUTE, settled: true });
    await parked(t, "poisoned", { state: "delivering", ageMs: 31 * MINUTE, settled: true });
    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_identity", (q) => q.eq("datasource", "events").eq("eventId", "poisoned"))
        .unique();
      await ctx.db.patch(event!._id, { workId: "legacy-pointer" });
    });

    // Does not throw, and the healthy row is rescued rather than blocked by its neighbour.
    const result = await t.mutation(api.recovery.requeueStuck, {});
    expect(result.requeued).toBe(2);
    expect(await stateOf(t, "healthy")).toMatchObject({ tagged: true });

    // And the bad pointer is cleared, so the condition heals instead of recurring — with the
    // value named on the row, because something wrote to this table that should not have.
    const poisoned = await t.run(async (ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_identity", (q) => q.eq("datasource", "events").eq("eventId", "poisoned"))
        .unique(),
    );
    expect(poisoned?.lastError?.message).toContain("legacy-pointer");
  });

  it("rescues a delivering row that has no pointer at all", async () => {
    // A regression the pointer-less branch introduced. That branch reasons about rows which
    // were never delivering, but ungated it also caught `delivering` rows: `scheduleDelivery`
    // refuses them (`state !== "pending"`), so nothing was patched, `updatedAt` never moved,
    // and the row was stranded permanently while the call reported `remaining: false`.
    //
    // A `delivering` row with no pointer has no work item at all, which is exactly what
    // abandoned means.
    const fetchSpy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await parked(t, "no-pointer", {
      state: "delivering",
      ageMs: 30 * MINUTE,
      settled: true,
      keepPointer: false,
    });

    expect(await t.mutation(api.recovery.requeueStuck, {})).toMatchObject({ requeued: 1 });
    expect(await stateOf(t, "no-pointer")).toMatchObject({ state: "pending", tagged: true });
  });
});
