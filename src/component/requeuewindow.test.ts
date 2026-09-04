import { api } from "./_generated/api";
import {
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

/**
 * How the scan WALKS, as distinct from what it rescues.
 *
 * Its own file because the failures here are a different kind: not "did it act on the right
 * row" but "could it ever reach the row at all". Every defect in this file was a window that
 * looked like it was making progress — `remaining: true`, `requeued: 0`, for ever — and each
 * one was found by an independent verifier rather than by the tests above.
 */
describe("how the scan walks", () => {
  it("cannot let a saturated delivering scan starve the pending scan", async () => {
    // Rows skipped for being alive still consume the budget — they had to be read to be
    // judged — so a saturated pool yields a full page of old, healthy `delivering` rows on
    // every call. If the first scan could spend the whole budget there, the `pending` scan
    // would never run and a stranded row behind it would never be found. Not slow: never.
    //
    // Four live delivering rows against a limit of 2, plus one genuinely stranded pending
    // row. Without the half share the delivering scan consumes both and the rescue is 0.
    const fetchSpy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    // The settled row FIRST. `parked(settled: true)` drains, and a drain finishes every queued
    // item — so seeding it last would settle the four "live" rows too and the fixture would
    // be testing nothing it claims to.
    await parked(t, "behind", { state: "pending", ageMs: 30 * MINUTE, settled: true });
    for (let i = 0; i < 4; i += 1) {
      await parked(t, `busy-${i}`, { state: "delivering", ageMs: 30 * MINUTE, settled: false });
    }

    expect(await t.mutation(api.recovery.requeueStuck, { limit: 2 })).toMatchObject({
      requeued: 1,
    });
    expect(await stateOf(t, "behind")).toMatchObject({ tagged: true });
  });
  it("reaches an abandoned row sitting behind older live work", async () => {
    // The crowding defect, on the AGE axis this time. A row skipped for still working is never
    // patched, so its `updatedAt` never moves and it stays at the head of
    // `by_state_updatedAt` — without a cursor the scan reads the same page on every call for
    // ever, returning `requeued: 0, remaining: true` and never reaching anything behind it.
    //
    // This is the condition the cron exists to recover from, not a corner case:
    // `maxParallelism` is 4, so a backlog of a few hundred puts the tail past the threshold
    // while every item is healthy. Verification reproduced it on a real deployment against an
    // earlier revision and showed the abandoned row became rescuable when the ONLY change was
    // making the live rows younger than it.
    //
    // Seeding order is load-bearing: the settled row must be built FIRST, because `drain`
    // finishes every scheduled function and would otherwise settle the rows this needs alive.
    const fetchSpy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await parked(t, "behind", { state: "pending", ageMs: 30 * MINUTE, settled: true });
    for (let i = 0; i < 3; i += 1) {
      await parked(t, `ahead-${i}`, {
        state: "pending",
        ageMs: (60 - i) * MINUTE,
        settled: false,
      });
    }

    // The README's loop shape, and the client now exposes `cursor` so a host can write it —
    // verification found the previous version threading a cursor the published client did not
    // accept and the README discarded, so it passed on a path no caller could take. That is
    // the comment-makes-an-assumption-look-considered failure, in a comment I wrote about
    // exactly that failure.
    // Typed from the mutation's own return, so this cannot drift from the shape a host
    // actually receives — the previous version declared its own and the test passed on a path
    // no caller could take.
    let cursor:
      | Awaited<ReturnType<typeof t.mutation<typeof api.recovery.requeueStuck>>>["cursor"]
      | undefined;
    let requeued = 0;
    for (let pass = 0; pass < 10; pass += 1) {
      const result = await t.mutation(api.recovery.requeueStuck, { limit: 3, cursor });
      requeued += result.requeued;
      cursor = result.cursor;
      if (!result.remaining) break;
    }

    expect(requeued).toBe(1);
    expect(await stateOf(t, "behind")).toMatchObject({ tagged: true });
    // And the live rows were left alone throughout, which is the other half of the claim.
    expect(await stateOf(t, "ahead-0")).toMatchObject({ tagged: false, hasWorkId: true });
  });
  it("does not jump the rest of a group sharing one updatedAt", async () => {
    // Convex freezes `Date.now()` for a transaction, so a host enqueuing a batch gives every
    // row an identical `updatedAt` — and so does this function to every row it rescues in one
    // call. A strict `gt` on the last value seen therefore jumps whatever else shares it, and
    // if the leading members are live and never patched the group never shrinks, so every run
    // repeats the jump identically.
    //
    // Six tied rows with the abandoned one fourth. Verification demonstrated it was never
    // reached, and that the same fixture with distinct timestamps rescued it on pass one.
    const fetchSpy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();

    // The abandoned row must sit BEHIND live ones inside the tie, which `parked` cannot build:
    // ties order by `_creationTime`, and a settled row has to be drained, which settles every
    // queued item alongside it. So all six are enqueued and drained together, then the live
    // ones are given FRESH work items by `resume` — which skips the abandoned row precisely
    // because it still holds a pointer.
    //
    // Getting this wrong is not academic: the first version of this test seeded the abandoned
    // row first, so it sorted first in the tie and was rescued immediately. It passed under a
    // strict `gt`, which is the defect it exists to catch.
    const ids = ["tied-0", "tied-1", "tied-2", "tied-abandoned", "tied-4", "tied-5"];
    for (const id of ids) {
      await t.mutation(api.lib.enqueue, { datasource: "events", eventId: id, payload: row });
    }
    // Captured BEFORE the drain: a completed delivery clears `workId`, so reading it afterwards
    // yields nothing and `resume` would then schedule this row too, making it live — which is
    // how the previous version of this fixture quietly tested nothing.
    const stale = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_identity", (q) =>
          q.eq("datasource", "events").eq("eventId", "tied-abandoned"),
        )
        .unique();
      return event?.workId;
    });
    expect(stale).toBeDefined();
    await drain(t);

    const tied = Date.now() - 30 * MINUTE;
    await t.run(async (ctx) => {
      // A bounded read: the fixture is six rows, and `take` keeps the rule honest rather than
      // silenced.
      for (const event of await ctx.db.query("events").take(20)) {
        await ctx.db.patch(event._id, { state: "pending", updatedAt: tied });
      }
    });
    // Its own finished pointer, restored, so `resume` walks past it and it stays abandoned.
    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_identity", (q) =>
          q.eq("datasource", "events").eq("eventId", "tied-abandoned"),
        )
        .unique();
      await ctx.db.patch(event!._id, { workId: stale });
    });
    await t.mutation(api.lib.resume, {});

    // Precondition: the abandoned row is NOT first in the tie, or this proves nothing.
    const order = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("events")
          .withIndex("by_state_updatedAt", (q) => q.eq("state", "pending"))
          // `take`, not `collect`: the fixture is six rows and a bounded read keeps this
          // precondition from being the one query in the file that could blow up on a bad
          // fixture.
          .take(20)
      ).map((event) => event.eventId),
    );
    expect(order.indexOf("tied-abandoned")).toBeGreaterThan(2);

    let cursor:
      | Awaited<ReturnType<typeof t.mutation<typeof api.recovery.requeueStuck>>>["cursor"]
      | undefined;
    let requeued = 0;
    for (let pass = 0; pass < 10; pass += 1) {
      const result = await t.mutation(api.recovery.requeueStuck, { limit: 3, cursor });
      requeued += result.requeued;
      cursor = result.cursor;
      if (!result.remaining) break;
    }

    expect(requeued).toBeGreaterThanOrEqual(1);
    expect(await stateOf(t, "tied-abandoned")).toMatchObject({ tagged: true });
  });
  it("makes no progress past live work when the cursor is discarded", async () => {
    // The control for the whole cursor design, and the reason it is in the client and the
    // README rather than only in the mutation. A host that drops the cursor restarts at the
    // head of the scan every call, so a page of old-but-healthy rows pins it for ever.
    //
    // This asserts the FAILURE deliberately: it is the behaviour a caller gets for free, and
    // documenting it as a test is what stops the next person removing the plumbing as noise.
    const fetchSpy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await parked(t, "behind", { state: "pending", ageMs: 30 * MINUTE, settled: true });
    for (let i = 0; i < 3; i += 1) {
      await parked(t, `ahead-${i}`, {
        state: "pending",
        ageMs: (60 - i) * MINUTE,
        settled: false,
      });
    }

    for (let pass = 0; pass < 10; pass += 1) {
      await t.mutation(api.recovery.requeueStuck, { limit: 3 });
    }
    expect(await stateOf(t, "behind")).toMatchObject({ tagged: false });
  });
});
