import { api, internal } from "./_generated/api";
import { DEFAULT_REPLAY_LIMIT, MAX_ERROR_HISTORY, MAX_REPLAY_LIMIT } from "./contract";
import {
  codeOf,
  drain,
  enqueueOne,
  enqueueWithRetry,
  installComponentTestHooks,
  jsonResponse,
  payloadOf,
  row,
  settingsOf,
  seedEvent,
  setup,
  statusOf,
  type TestInstance,
} from "../testing/fixtures";

installComponentTestHooks();

const accepted = { successful_rows: 1, quarantined_rows: 0 };

/**
 * Enqueues `count` events and drives them all to a dead letter with the given response.
 *
 * `prefix` matters: identities are unique per instance, so reusing one across two calls
 * would make the second batch duplicates of the first rather than new dead letters.
 */
async function deadLetter(
  t: TestInstance,
  count: number,
  status = 400,
  body: unknown = null,
  prefix = "evt",
) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(status, body)));
  for (let i = 0; i < count; i += 1) {
    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: `${prefix}_${i}`,
      payload: { ...row, event_id: `${prefix}_${i}` },
    });
  }
  await drain(t);
}

/**
 * How many events exist, and how many of them hold a Workpool item.
 *
 * `workId` is the only durable record that delivery was scheduled, so it is the only thing
 * that can tell "the pause was honoured" apart from "the send was refused later".
 */
async function queuedWork(t: TestInstance) {
  return t.run(async (ctx) => {
    // Bounded by the fixture, not by the database: every test using this seeds a handful
    // of events and asserts the total, so an unbounded read here cannot grow.
    // eslint-disable-next-line @convex-dev/no-collect-in-query
    const events = await ctx.db.query("events").collect();
    return {
      total: events.length,
      withWork: events.filter((event) => event.workId !== undefined).length,
    };
  });
}

describe("replayFailed", () => {
  it("returns dead letters to the queue in bounded batches and says whether more remain", async () => {
    const t = setup();
    await deadLetter(t, 5);
    expect((await t.query(api.lib.health, {})).counts.failed.count).toBe(5);

    // A single mutation cannot requeue an unbounded backlog inside Convex's limits, so the
    // caller loops on `remaining` exactly as it does for resume.
    const first = await t.mutation(api.lib.replayFailed, { limit: 3, actor: "operator_1" });
    expect(first).toEqual({ replayed: 3, remaining: true });

    const second = await t.mutation(api.lib.replayFailed, { limit: 3, actor: "operator_1" });
    expect(second).toEqual({ replayed: 2, remaining: false });

    expect((await t.query(api.lib.health, {})).counts.failed.count).toBe(0);
  });

  it("resends a replayed event and keeps its identity and payload", async () => {
    const t = setup();
    await deadLetter(t, 1);
    const before = await t.run(async (ctx) => (await ctx.db.query("events").first())!);

    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    await t.mutation(api.lib.replayFailed, {});
    await drain(t);

    const after = await t.run(async (ctx) => (await ctx.db.query("events").first())!);
    const payloadBefore = await payloadOf(t, before._id);
    expect(after.eventId).toBe(before.eventId);
    // The payload moved to its own table in FTD-2525; it is still the SAME payload, which
    // is what "replay is not re-enqueue" means.
    expect(await payloadOf(t, after._id)).toBe(payloadBefore);
    expect(after.state).toBe("delivered");
    // The row Tinybird receives is the original, not a new one.
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body).toBe(`${payloadBefore}\n`);
  });

  it("keeps the attempt history so an operator can still see why it died", async () => {
    const t = setup();
    await deadLetter(t, 1);

    await t.mutation(api.lib.replayFailed, {});

    const replayed = await statusOf0(t);
    expect(replayed?.state).toBe("pending");
    // A fresh budget, but not a fresh memory.
    expect(replayed?.attempts).toBe(0);
    expect(replayed?.previousErrors?.some((e) => e.category === "invalid_request")).toBe(true);
  });

  it("drains a backlog larger than one page without stranding the rows at the back", async () => {
    // The backlog is strictly larger than one page, which is the case an operator actually
    // has after an outage and the only case where the paging can be wrong at all. A fixture
    // that fits inside one page cannot tell a scan that advances from one that does not.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await t.run(async (ctx) => {
      for (let i = 0; i < DEFAULT_REPLAY_LIMIT + 30; i += 1) {
        await seedEvent(ctx, {
          datasource: "events",
          eventId: `dead_${i}`,
          state: "failed" as const,
          attempts: 1,
          createdAt: Date.now() + i,
          updatedAt: Date.now() + i,
        });
      }
    });

    // The loop the README documents: call until `remaining` is false. It must terminate,
    // and when it does there must be nothing left in `failed`.
    let calls = 0;
    let replayed = 0;
    let remaining = true;
    while (remaining) {
      const result = await t.mutation(api.lib.replayFailed, {});
      replayed += result.replayed;
      remaining = result.remaining;
      calls += 1;
      if (calls > 10) break;
    }

    expect(calls).toBeLessThanOrEqual(10);
    expect(replayed).toBe(DEFAULT_REPLAY_LIMIT + 30);
    expect((await t.query(api.lib.health, {})).counts.failed.count).toBe(0);
  });

  it("stores but does not schedule while the destination is paused", async () => {
    const t = setup();
    await deadLetter(t, 2);
    await t.mutation(api.lib.pause, { actor: "operator_1" });

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const done = await t.mutation(api.lib.replayFailed, {});

    // Measured BEFORE the drain, and that ordering is the whole test. `onDeliveryComplete`
    // clears `workId` when the pool finishes an item, so draining first erases the only
    // evidence that an item was ever queued and the assertion passes either way.
    //
    // `fetch` alone cannot see this either. `deliver.ts` also refuses to send while paused,
    // so a spy that was never called stays silent whether the pause was honoured at
    // scheduling time or only at delivery time. The claim here is that no work item was
    // queued at all, and `workId` is the only thing that records that.
    //
    // `total` is asserted alongside `withWork`: a count of zero queued rows is trivially
    // satisfied by zero rows.
    expect(await queuedWork(t)).toEqual({ total: 2, withWork: 0 });

    await drain(t);
    expect(done.replayed).toBe(2);
    expect((await t.query(api.lib.health, {})).counts.pending.count).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does queue work for the same replay once the destination is not paused", async () => {
    // The control leg for the test above: without it, a change that stopped scheduling
    // altogether would leave that test green while breaking replay entirely.
    const t = setup();
    await deadLetter(t, 2);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    await t.mutation(api.lib.replayFailed, {});

    // No drain here either, for the same reason: the work item has to still be outstanding
    // to be observable.
    expect(await queuedWork(t)).toEqual({ total: 2, withWork: 2 });
  });

  it("replays an event Tinybird quarantined", async () => {
    // The schema-mismatch shape: Tinybird answered 200 but kept none of the rows. This is
    // the case replay exists for — fix the schema, then send the same events again.
    const t = setup();
    await deadLetter(t, 1, 200, { successful_rows: 0, quarantined_rows: 1 }, "quar");

    const dead = await t.query(api.lib.getStatus, { datasource: "events", eventId: "quar_0" });
    expect(dead?.lastError?.category).toBe("quarantined");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    expect(await t.mutation(api.lib.replayFailed, {})).toEqual({ replayed: 1, remaining: false });
    await drain(t);

    const revived = await t.query(api.lib.getStatus, { datasource: "events", eventId: "quar_0" });
    expect(revived).toMatchObject({ state: "delivered" });
    expect(revived?.previousErrors?.map((error) => error.category)).toContain("quarantined");
  });

  it("does not keep the dead-letter error as the current one after a replay", async () => {
    // `requeueDeadLetter` moves `lastError` into the history. Leaving it ALSO set as the
    // current error means the next failure pushes the same entry a second time, so one of
    // the five history slots is spent on a duplicate and a real earlier failure is evicted
    // a cycle early — degrading the diagnostic the history exists to provide.
    //
    // It is also wrong on its own terms: a replayed event is in flight, not failed, so an
    // operator dashboard reading `lastError` sees a failure that is no longer current.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const t = setup();
    await enqueueWithRetry(t, 2);
    await drain(t);
    expect(await statusOf(t)).toMatchObject({ state: "failed" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    await t.mutation(api.lib.replayFailed, {});

    const replayed = await statusOf(t);
    expect(replayed?.lastError).toBeUndefined();
    // Not vacuous: the error really did move rather than being dropped on the floor.
    expect(replayed?.previousErrors?.map((error) => error.category)).toContain("exhausted");
  });

  it("drops the oldest failure when replaying an event whose history is already full", async () => {
    // The exhausted path is the ONLY input shape that reaches replay with a full history:
    // an event that spent its budget arrives at `failed` carrying one entry per attempt, so
    // pushing the dead-letter reason onto it is the one case where MAX_ERROR_HISTORY can
    // actually bite. Everything else replays with a history of zero or one.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new DOMException("aborted", "TimeoutError"))
        .mockRejectedValue(new TypeError("fetch failed")),
    );
    const t = setup();
    await enqueueWithRetry(t, MAX_ERROR_HISTORY);
    await drain(t);

    // Full, and the first attempt is a different category from the rest so the test can
    // say WHICH end the cap discards rather than just that the length held.
    const dead = await statusOf(t);
    expect(dead?.previousErrors).toHaveLength(MAX_ERROR_HISTORY);
    expect(dead?.previousErrors?.[0]?.category).toBe("timeout");
    expect(dead?.lastError?.category).toBe("exhausted");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    await t.mutation(api.lib.replayFailed, {});

    // Six entries would exceed the cap, so the OLDEST goes and the newest is kept. The
    // timeout was the oldest, so it is what disappears; `exhausted` is what arrives.
    const replayed = await statusOf(t);
    const categories = replayed?.previousErrors?.map((error) => error.category);
    expect(categories).toHaveLength(MAX_ERROR_HISTORY);
    expect(categories).not.toContain("timeout");
    expect(categories?.at(-1)).toBe("exhausted");
  });

  it("replays an event that died by spending its whole retry budget", async () => {
    // The other dead-letter shape. `deadLetter` above produces a Tinybird refusal on the
    // first attempt; this one never gets a usable answer and fails on `exhausted`, which is
    // the case an operator hits after an outage rather than after a bad schema.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const t = setup();
    await enqueueWithRetry(t, 3);
    await drain(t);

    const dead = await statusOf(t);
    expect(dead).toMatchObject({ state: "failed", attempts: 3 });
    expect(dead?.lastError?.category).toBe("exhausted");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    expect(await t.mutation(api.lib.replayFailed, {})).toEqual({ replayed: 1, remaining: false });
    await drain(t);

    // The budget is granted again, so the replayed attempt is attempt 1 of a fresh 3 and
    // the event reaches Tinybird. The reason it died first time survives in the history.
    const revived = await statusOf(t);
    expect(revived).toMatchObject({ state: "delivered", attempts: 1 });
    expect(revived?.previousErrors?.map((error) => error.category)).toContain("exhausted");
  });

  it("replays every dead letter once before replaying any of them twice", async () => {
    // The companion to `operator.test.ts`'s "terminates the documented drain loop instead of
    // requeueing the same rows forever". `resume` is immune to this because its index
    // excludes rows that already have work; replay has no such guard, so ordering is the
    // only thing standing between an operator and a hammer loop.
    //
    // The destination stays broken for the whole test on purpose. That is the case the
    // operator is actually in when they reach for replay and guess wrong about the cause,
    // and it is the only case where the ordering matters at all — if everything succeeds,
    // nothing re-enters `failed` and any order looks fine.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, null)));
    const t = setup();
    for (let i = 0; i < 5; i += 1) {
      await t.mutation(api.lib.enqueue, {
        datasource: "events",
        eventId: `evt_${i}`,
        payload: { ...row, event_id: `evt_${i}` },
      });
    }
    await drain(t);

    // Three cycles at two per call: six slots for five events, so a fair scan reaches all
    // five and revisits one. An unfair scan spends all six on the front of the range.
    for (let call = 0; call < 3; call += 1) {
      await t.mutation(api.lib.replayFailed, { limit: 2 });
      await drain(t);
    }

    // One history entry is added per replay cycle, so the length IS the replay count.
    const replays = await t.run(async (ctx) => {
      // eslint-disable-next-line @convex-dev/no-collect-in-query
      const events = await ctx.db.query("events").collect();
      return events.map((event) => event.previousErrors?.length ?? 0).sort();
    });

    // Ordered by `createdAt` this reads [0, 0, 0, 3, 3]: three events never replayed at all
    // while two were replayed three times each. Both halves of that are asserted, because
    // "nobody was starved" and "nobody was hammered" are different claims.
    expect(replays).toHaveLength(5);
    expect(Math.min(...replays)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...replays) - Math.min(...replays)).toBeLessThanOrEqual(1);
  });

  it("applies the default batch, the ceiling, and a whole number of rows", async () => {
    // Seeded directly: the point is how `limit` is clamped, not how the rows died. The
    // backlog is larger than the ceiling so every leg below is bounded by the clamp rather
    // than by running out of dead letters.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await t.run(async (ctx) => {
      // Large enough for every leg below to be bounded by the clamp rather than by the
      // backlog running out — the legs run in sequence and each one consumes rows.
      for (let i = 0; i < MAX_REPLAY_LIMIT * 2 + DEFAULT_REPLAY_LIMIT * 2 + 20; i += 1) {
        await seedEvent(ctx, {
          datasource: "events",
          eventId: `dead_${i}`,
          state: "failed" as const,
          attempts: 1,
          createdAt: Date.now() + i,
          updatedAt: Date.now() + i,
        });
      }
    });

    // No limit: the conservative default, which is sized so one call stays well inside
    // Convex's per-transaction byte limits at the component's default payload bound.
    expect(await t.mutation(api.lib.replayFailed, {})).toEqual({
      replayed: DEFAULT_REPLAY_LIMIT,
      remaining: true,
    });

    // Above the ceiling: the ceiling, not the default. Asserted as a RELATIONSHIP as well
    // as a value, because both legs above read their expectation from the same constants
    // they exercise — so collapsing the ceiling onto the default, which is the exact
    // regression splitting them was meant to prevent, would otherwise pass green.
    expect(MAX_REPLAY_LIMIT).toBeGreaterThan(DEFAULT_REPLAY_LIMIT);
    expect(await t.mutation(api.lib.replayFailed, { limit: 10_000 })).toEqual({
      replayed: MAX_REPLAY_LIMIT,
      remaining: true,
    });

    // A fraction is truncated rather than reaching `.take()`, which rejects a non-integer
    // with a bare TypeError instead of one of this component's coded errors.
    expect(await t.mutation(api.lib.replayFailed, { limit: 2.9 })).toMatchObject({
      replayed: 2,
    });

    // Below one is raised to one, so a caller cannot ask for a call that does nothing and
    // then loop on `remaining` forever.
    expect(await t.mutation(api.lib.replayFailed, { limit: 0 })).toMatchObject({ replayed: 1 });
    expect(await t.mutation(api.lib.replayFailed, { limit: -5 })).toMatchObject({ replayed: 1 });

    // NaN is the one that clamping alone does not stop: it survives `Math.trunc`, and every
    // comparison against it is false, so `Math.min` and `Math.max` pass it straight through
    // to `.take()`, which throws a bare TypeError. A host reaches it by dividing by a zero
    // backlog or parsing a bad config value. All three non-finite inputs are treated as "no
    // limit given" and take the default, which is the only reading that is not a guess.
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(await t.mutation(api.lib.replayFailed, { limit })).toMatchObject({
        replayed: DEFAULT_REPLAY_LIMIT,
      });
    }
  });

  it.each([0, -5])("treats a limit of %i as one rather than none or an error", async (limit) => {
    // Configured, or nothing would ever be delivered and there would be no dead letters.
    const t = setup();
    await deadLetter(t, 3);

    expect(await t.mutation(api.lib.replayFailed, { limit })).toEqual({
      replayed: 1,
      remaining: true,
    });
  });

  it("is an honest no-op when there is nothing to replay", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup();

    expect(await t.mutation(api.lib.replayFailed, {})).toEqual({
      replayed: 0,
      remaining: false,
    });
  });
});

/** getStatus for the first seeded event id. */
async function statusOf0(t: TestInstance) {
  return t.query(api.lib.getStatus, { datasource: "events", eventId: "evt_0" });
}

it("ignores a completion for a work item the event no longer holds", async () => {
  // The pool's `onComplete` runs in its own transaction, after the delivery action has
  // returned. An operator who replays in that window gives the event a NEW work item, and
  // the OLD item's completion then arrives to find a live `workId` that is not its own.
  //
  // Clearing it unconditionally makes the row `pending` with no `workId`, which is exactly
  // what `resume`'s index selects — so the event gets a second, concurrent work item and
  // two independent retry budgets. That is the failure the index's own comment says it
  // exists to prevent.
  //
  // `convex-test` cannot produce the natural interleaving, so the stale completion is
  // fired by hand. That is the honest way to test this, not a race.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, null)));
  const t = setup();
  await enqueueOne(t);
  await drain(t);
  expect(await statusOf(t)).toMatchObject({ state: "failed" });

  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
  await t.mutation(api.lib.replayFailed, {});

  const live = await t.run(async (ctx) => {
    const event = await ctx.db.query("events").first();
    return { id: event?._id, workId: event?.workId };
  });
  expect(live.workId).toBeTypeOf("string");

  // A completion for some earlier item. The row is holding a different one.
  //
  // `success` rather than `failed`, and the distinction matters: `failed` would take the
  // dead-letter branch and leave the row `failed`, so the `requeued: 0` assertion below
  // would hold because `resume` ignores failed rows — not because the marker was protected.
  // The test would pass for a reason its own comment does not claim. `success` is also the
  // only kind actually reachable in this window, since a row the pool reports `failed` for
  // is `pending` rather than `failed` and so could not have been replayed.
  //
  // A consequence worth knowing before editing either test: for a SUCCESS result, refusing
  // the whole completion and merely refusing the marker clear are equivalent, so this test
  // alone does not distinguish them. What pins the verdict half — which was the live defect —
  // is `ignores a cancellation for a work item the event no longer holds` in deliver.test.ts.
  // Weakening that one silently unpins this fix.
  await t.mutation(internal.lib.onDeliveryComplete, {
    context: { eventId: live.id! },
    workId: "an_earlier_work_item" as never,
    result: { kind: "success", returnValue: null },
  });

  // The live marker survives, so the event still reads as "a worker has this" — and so does
  // the STATE. The marker is only half of it: the stale completion also carries a verdict,
  // and applying that verdict to a row it no longer owns marks a replayed, in-flight event
  // as failed on the strength of the previous attempt.
  const after = await t.run(async (ctx) => {
    const event = await ctx.db.query("events").first();
    return { workId: event?.workId, state: event?.state };
  });
  expect(after).toEqual({ workId: live.workId, state: "pending" });

  // And the consequence that actually matters: resume does not hand it a second worker.
  expect(await t.mutation(api.lib.resume, {})).toMatchObject({ requeued: 0 });
});

describe("replayEvent", () => {
  it("replays one dead letter by its identity", async () => {
    const t = setup();
    await deadLetter(t, 3);

    const done = await t.mutation(api.lib.replayEvent, {
      datasource: "events",
      eventId: "evt_1",
      actor: "operator_1",
    });

    expect(done).toEqual({ replayed: true });
    expect(
      await t.query(api.lib.getStatus, { datasource: "events", eventId: "evt_1" }),
    ).toMatchObject({
      state: "pending",
    });
    // The others are untouched.
    expect((await t.query(api.lib.health, {})).counts.failed.count).toBe(2);
  });

  it("refuses to replay an event that is not a dead letter", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    const t = setup();
    await enqueueOne(t);
    await drain(t);

    expect(
      await t.mutation(api.lib.replayEvent, { datasource: "events", eventId: "evt_1" }),
    ).toEqual({ replayed: false });
    expect(await statusOf(t)).toMatchObject({ state: "delivered" });
  });

  it("reports honestly when the identity is unknown", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup();

    expect(
      await t.mutation(api.lib.replayEvent, { datasource: "events", eventId: "nope" }),
    ).toEqual({ replayed: false });
  });
});

describe("replay and identity", () => {
  it("still treats a matching re-enqueue as a duplicate after a replay", async () => {
    const t = setup();
    await deadLetter(t, 1);
    await t.mutation(api.lib.replayFailed, {});

    const again = await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_0",
      payload: { ...row, event_id: "evt_0" },
    });

    expect(again.outcome).toBe("duplicate");
  });

  it("still raises a conflict for a different payload under the same identity", async () => {
    const t = setup();
    await deadLetter(t, 1);
    await t.mutation(api.lib.replayFailed, {});

    // Replay must not weaken identity: the event is the same event.
    expect(
      await codeOf(
        t.mutation(api.lib.enqueue, {
          datasource: "events",
          eventId: "evt_0",
          payload: { ...row, event_id: "evt_0", changed: true },
        }),
      ),
    ).toBe("identity_conflict");
  });
});

describe("replay audit", () => {
  it("records who replayed, how many, and when", async () => {
    const t = setup();
    await deadLetter(t, 2);

    await t.mutation(api.lib.replayFailed, { actor: "operator_1" });
    expect((await settingsOf(t))?.lastOperatorAction).toMatchObject({
      kind: "replayFailed",
      actor: "operator_1",
      count: 2,
    });

    await deadLetter(t, 1);
    await t.mutation(api.lib.replayEvent, {
      datasource: "events",
      eventId: "evt_0",
      actor: "op_2",
    });
    expect((await settingsOf(t))?.lastOperatorAction).toMatchObject({
      kind: "replayEvent",
      actor: "op_2",
      count: 1,
    });
  });

  it("bounds and redacts the actor here too", async () => {
    const t = setup("p.append-token");
    await deadLetter(t, 1);

    await t.mutation(api.lib.replayFailed, { actor: "who p.append-token there" });

    const actor = (await settingsOf(t))?.lastOperatorAction?.actor ?? "";
    expect(actor).not.toContain("p.append-token");
    expect(actor).toContain("who");
  });
});
