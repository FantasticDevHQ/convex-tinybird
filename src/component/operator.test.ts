import { api, internal } from "./_generated/api";
import { DEFAULT_RESUME_LIMIT } from "./contract";
import {
  drain,
  enqueueOne,
  installComponentTestHooks,
  jsonResponse,
  row,
  settingsOf,
  seedEvent,
  setup,
  statusOf,
  type TestInstance,
} from "../testing/fixtures";

installComponentTestHooks();

const accepted = { successful_rows: 1, quarantined_rows: 0 };

describe("a refused token pauses the destination", () => {
  it.each([401, 403])("pauses on %i instead of spending the retry budget", async (status) => {
    // Retrying a wrong token cannot help, and doing so would dead-letter the whole backlog
    // one event at a time. Pausing keeps the events and stops the requests.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(status, null));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: row,
      retry: { maxAttempts: 5, initialBackoffMs: 100, base: 2 },
    });
    await drain(t);

    // One request, not five: the budget is untouched.
    expect(fetchSpy.mock.calls).toHaveLength(1);
    expect(await statusOf(t)).toMatchObject({ state: "pending", attempts: 1 });
    expect(await t.query(api.lib.health, {})).toMatchObject({
      paused: true,
      pausedReason: "unauthorized",
    });
    // The event itself records why, so the reason survives on the row and not only on the
    // destination: `unauthorized`, never the server-error fallback.
    expect(await statusOf(t)).toMatchObject({ lastError: { category: "unauthorized" } });
  });

  it("stores but does not send events enqueued while paused", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(401, null));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await enqueueOne(t);
    await drain(t);
    expect(fetchSpy.mock.calls).toHaveLength(1);

    await t.mutation(api.lib.enqueue, { datasource: "events", eventId: "evt_2", payload: row });
    await drain(t);

    // Still one request in total: the second event was stored and left alone.
    expect(fetchSpy.mock.calls).toHaveLength(1);
    expect(
      await t.query(api.lib.getStatus, { datasource: "events", eventId: "evt_2" }),
    ).toMatchObject({ state: "pending", attempts: 0 });
  });
});

describe("resume", () => {
  it("clears the pause and drains the backlog in bounded batches", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, null))
      .mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 }));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();

    // One event trips the pause, then a backlog accumulates behind it.
    await enqueueOne(t);
    await drain(t);
    for (let i = 2; i <= 6; i += 1) {
      await t.mutation(api.lib.enqueue, {
        datasource: "events",
        eventId: `evt_${i}`,
        payload: { ...row, event_id: `evt_${i}` },
      });
    }
    expect((await t.query(api.lib.health, {})).counts.pending.count).toBe(6);

    const first = await t.mutation(api.lib.resume, { limit: 4, actor: "operator_1" });
    await drain(t);
    expect(first).toEqual({ paused: false, requeued: 4 });

    const second = await t.mutation(api.lib.resume, { limit: 4, actor: "operator_1" });
    await drain(t);
    expect(second).toEqual({ paused: false, requeued: 2 });

    const third = await t.mutation(api.lib.resume, { limit: 4, actor: "operator_1" });
    expect(third).toEqual({ paused: false, requeued: 0 });

    const health = await t.query(api.lib.health, {});
    expect(health).toMatchObject({ paused: false });
    expect(health.counts.pending.count).toBe(0);
  });

  it("records who paused and who resumed", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");

    await t.mutation(api.lib.pause, { reason: "operator", actor: "operator_1" });
    const paused = await settingsOf(t);
    expect(paused).toMatchObject({
      paused: true,
      pausedReason: "operator",
      lastOperatorAction: { kind: "pause", actor: "operator_1" },
    });

    await t.mutation(api.lib.resume, { actor: "operator_2" });
    expect(await settingsOf(t)).toMatchObject({
      paused: false,
      lastOperatorAction: { kind: "resume", actor: "operator_2" },
    });
  });

  it("records how many events each resume actually put back to work", async () => {
    // A configured instance with a real backlog, because the audit count is the number of
    // events the call requeued and an unconfigured instance requeues nothing. Asserting
    // `count` against a fixture that can only ever produce zero would pass no matter what
    // the code wrote.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    const t = setup();
    await t.mutation(api.lib.pause, { actor: "operator_1" });
    for (let i = 0; i < 5; i += 1) {
      await t.mutation(api.lib.enqueue, {
        datasource: "events",
        eventId: `evt_${i}`,
        payload: { ...row, event_id: `evt_${i}` },
      });
    }

    // Two calls with different counts, so neither a hardcoded constant nor a zero can
    // satisfy both legs.
    expect(await t.mutation(api.lib.resume, { actor: "operator_2", limit: 3 })).toMatchObject({
      requeued: 3,
    });
    expect(await settingsOf(t)).toMatchObject({
      lastOperatorAction: { kind: "resume", actor: "operator_2", count: 3 },
    });

    expect(await t.mutation(api.lib.resume, { actor: "operator_2" })).toMatchObject({
      requeued: 2,
    });
    expect(await settingsOf(t)).toMatchObject({
      lastOperatorAction: { kind: "resume", actor: "operator_2", count: 2 },
    });
  });

  it("does not claim to have requeued events it never scheduled", async () => {
    // Unconfigured, so `scheduleDelivery` declines every row. The events are genuinely
    // there and genuinely waiting — the `waiting` index finds all four — so a count of
    // rows VISITED reads four while nothing was queued at all. That number is returned to
    // the caller and written durably into the operator audit trail, where it is the record
    // of what the action did.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    for (let i = 0; i < 4; i += 1) {
      await t.mutation(api.lib.enqueue, {
        datasource: "events",
        eventId: `evt_${i}`,
        payload: { ...row, event_id: `evt_${i}` },
      });
    }

    expect(await t.mutation(api.lib.resume, { actor: "operator_1" })).toEqual({
      paused: false,
      requeued: 0,
    });
    expect(await settingsOf(t)).toMatchObject({
      lastOperatorAction: { kind: "resume", count: 0 },
    });

    // The rows really are unscheduled, so this is not passing because the fixture was empty.
    const waiting = await t.run(async (ctx) => {
      // eslint-disable-next-line @convex-dev/no-collect-in-query
      const events = await ctx.db.query("events").collect();
      return {
        total: events.length,
        pendingWithoutWork: events.filter(
          (event) => event.state === "pending" && event.workId === undefined,
        ).length,
      };
    });
    expect(waiting).toEqual({ total: 4, pendingWithoutWork: 4 });
  });

  it("is a no-op that reports honestly when nothing is paused or waiting", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup();

    expect(await t.mutation(api.lib.resume, {})).toEqual({ paused: false, requeued: 0 });
  });
});

describe("resume and live work", () => {
  it("does not requeue an event the pool is already working on", async () => {
    // The row is `pending` because an attempt is queued, not because it needs an operator.
    // Queueing a second work item for it would give the event two independent retry
    // budgets, which is how one event gets sent more times than its policy allows.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
    const t = setup();
    await enqueueOne(t);

    expect(await t.mutation(api.lib.resume, {})).toEqual({ paused: false, requeued: 0 });
  });

  it("never sends an event more times than its retry policy allows", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(503, null));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: row,
      retry: { maxAttempts: 2, initialBackoffMs: 100, base: 2 },
    });

    // An operator resuming while the pool is mid-retry must not add a second budget.
    await t.mutation(api.lib.resume, {});
    await drain(t);

    expect(fetchSpy.mock.calls).toHaveLength(2);
    expect(await statusOf(t)).toMatchObject({ state: "failed", attempts: 2 });
  });

  it("terminates the documented drain loop instead of requeueing the same rows forever", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, null)));
    const t = setup();
    await enqueueOne(t);
    await drain(t);
    for (const id of ["evt_2", "evt_3"]) {
      await t.mutation(api.lib.enqueue, {
        datasource: "events",
        eventId: id,
        payload: { ...row, event_id: id },
      });
    }

    // The README tells hosts to loop until `resume` reports nothing left. Run that loop
    // WITHOUT letting the pool run in between, which is the case where a resume that
    // ignored live work would report the same rows forever.
    const reported: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { requeued } = await t.mutation(api.lib.resume, { limit: 10 });
      reported.push(requeued);
      if (requeued === 0) break;
    }

    expect(reported).toEqual([3, 0]);
  });
});

describe("resume batch bounds", () => {
  /** Inserts rows straight into the table; the point here is the batch, not delivery. */
  async function seedPending(t: TestInstance, count: number) {
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i += 1) {
        await seedEvent(ctx, {
          datasource: "events",
          eventId: `seed_${i}`,
          state: "pending" as const,
          attempts: 0,
          createdAt: Date.now() + i,
          updatedAt: Date.now() + i,
        });
      }
    });
  }

  it("never requeues more than the documented maximum in one call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, null)));
    const t = setup();
    await seedPending(t, DEFAULT_RESUME_LIMIT + 5);

    // A host asking for more than the cap gets the cap, so one mutation cannot exceed
    // Convex's transaction limits however it is called.
    expect(await t.mutation(api.lib.resume, { limit: 10_000 })).toEqual({
      paused: false,
      requeued: DEFAULT_RESUME_LIMIT,
    });
  });

  it.each([0, -5])("treats a limit of %i as one rather than none or an error", async (limit) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, null)));
    const t = setup();
    await seedPending(t, 3);

    expect(await t.mutation(api.lib.resume, { limit })).toEqual({ paused: false, requeued: 1 });
  });
});

describe("marking a pause", () => {
  it.each([
    ["one that is only queued", false],
    ["one that already delivered", true],
  ])("does not rewrite the state of an event %s", async (_label, deliverFirst) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
    const t = setup(deliverFirst ? "p.token" : "");
    await enqueueOne(t);
    if (deliverFirst) await drain(t);
    const before = await statusOf(t);
    const eventId = await t.run(async (ctx) => (await ctx.db.query("events").first())!._id);

    await t.mutation(internal.lib.markPaused, {
      eventId,
      reason: "unauthorized",
      error: { category: "unauthorized", message: "refused", at: Date.now() },
    });

    // The destination pauses either way, but only an in-flight event goes back to the queue.
    const after = await statusOf(t);
    expect(after?.state).toBe(before?.state);
    expect((await t.query(api.lib.health, {})).paused).toBe(true);
  });
});

describe("resume against a large backlog", () => {
  it("drains every waiting event, not just the ones near the front", async () => {
    // The failure this guards against: an implementation that scans a window of pending
    // rows and filters out the ones with live work reports "nothing left" once the window
    // fills with rows it just scheduled, leaving the events behind them waiting forever.
    // A host loops in milliseconds while the pool needs a network round trip per event, so
    // the window does fill. A post-outage backlog is exactly this shape.
    const waiting = 550;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
    const t = setup();
    await t.run(async (ctx) => {
      for (let i = 0; i < waiting; i += 1) {
        await seedEvent(ctx, {
          datasource: "events",
          eventId: `backlog_${i}`,
          payload: '{"backlog":1}',
          state: "pending" as const,
          attempts: 0,
          createdAt: Date.now() + i,
          updatedAt: Date.now() + i,
        });
      }
    });

    // The documented loop, with no pool progress in between.
    let total = 0;
    for (let call = 0; call < 20; call += 1) {
      const { requeued } = await t.mutation(api.lib.resume, { limit: DEFAULT_RESUME_LIMIT });
      total += requeued;
      if (requeued === 0) break;
    }

    expect(total).toBe(waiting);
    const stillWaiting = await t.run(async (ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_state_workId_createdAt", (q) =>
          q.eq("state", "pending").eq("workId", undefined),
        )
        .take(10),
    );
    expect(stillWaiting).toEqual([]);
  });
});
