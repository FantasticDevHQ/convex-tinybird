import { api, internal } from "./_generated/api";
import { canonicalJson, payloadFingerprint, utf8Length } from "./canonical";
import {
  codeOf,
  drain,
  enqueueOne,
  enqueueWithRetry,
  installComponentTestHooks,
  jsonResponse,
  row,
  setup,
  statusOf,
} from "../testing/fixtures";

installComponentTestHooks();

const accepted = { successful_rows: 1, quarantined_rows: 0 };

/**
 * Repairing a `payload_missing` dead letter.
 *
 * Split from `payloads.test.ts` when it crossed the file-size ratchet. These share that
 * file's subject — the payload living outside the counted row — but they are all about the
 * one operation that writes a payload row for an event that already exists, and that
 * operation has more states than everything else here combined.
 */
describe("repairing a lost payload", () => {
  it("lets a re-enqueue of the same event restore a lost payload and drain it", async () => {
    // The resolution the `payload_missing` category needs. Without it the dead letter is
    // reachable but not drainable: `replayFailed` selects it, delivery finds nothing, and it
    // returns to `failed` forever. `enqueue` is the ONLY surface a host has that writes
    // `payloads` — a component's tables are unreachable from the host — so if a re-enqueue
    // is rejected as a conflict, there is no remedy at all and the row is stuck permanently.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await enqueueOne(t);
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("payloads").first();
      await ctx.db.delete(stored!._id);
    });
    await drain(t);
    expect((await statusOf(t))?.lastError?.category).toBe("payload_missing");

    // The same identity and the same payload the host committed originally.
    expect(await enqueueOne(t)).toMatchObject({ outcome: "repaired", state: "pending" });
    await drain(t);

    const healed = await statusOf(t);
    expect(healed).toMatchObject({ state: "delivered" });
    // It really sent the restored payload, rather than merely changing state.
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(`${canonicalJson(row)}\n`);
    // The failure that caused it is kept, because "why did this die" survives a repair.
    expect(healed?.previousErrors?.map((e) => e.category)).toContain("payload_missing");
  });

  it("does not hand a repaired event a second work item", async () => {
    // Repairing a row that is still `pending` was re-creating this ticket's own defect.
    // `requeueDeadLetter` schedules unconditionally, so the row got a SECOND work item while
    // the first was still queued. Its `workId` then pointed at the new one, so when the
    // original exhausted, `onDeliveryComplete` saw a mismatch, treated its own verdict as
    // stale, and discarded it — leaving a `pending` row with its whole budget spent and no
    // dead letter. Invisible to `replayFailed`, counted by `health` as ordinary backlog, and
    // then handed a SECOND full budget by `resume`: six requests under a `maxAttempts: 3`
    // policy, which is verbatim the harm `resume`'s own index comment exists to prevent.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(500, { error: "down" }));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await enqueueWithRetry(t, 3);
    // Deleted while the row is still `pending` with live work — the normal timing for any
    // host that re-enqueues on its own schedule, or an operator repairing before the drain.
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("payloads").first();
      await ctx.db.delete(stored!._id);
    });
    await t.mutation(api.lib.enqueue, { datasource: "events", eventId: "evt_1", payload: row });
    await drain(t);

    // The budget is spent exactly once and the row is a dead letter, matching what the same
    // fixture produces with no repair at all.
    const after = await statusOf(t);
    expect(after).toMatchObject({ state: "failed", attempts: 3 });
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // And resume cannot grant a second budget, because there is nothing left pending.
    expect(await t.mutation(api.lib.resume, {})).toMatchObject({ requeued: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("schedules a repaired event that was waiting with no worker", async () => {
    // The other half of the requeue guard, and the half that says "this one DOES need
    // scheduling". A `pending` row with no work item is waiting for someone to start it, and
    // repair has to start it — otherwise the payload comes back and the event still sits
    // there until an operator happens to run `resume`, which is stranding in a quieter form.
    //
    // The fixture has to leave NOTHING in the pool, which is what makes it discriminate. My
    // first version enqueued normally and then cleared `workId` by hand: the original work
    // item was still queued, so the drain delivered the event whether or not repair had
    // scheduled anything, and dropping the clause left the suite green. Enqueueing while
    // paused is what produces a genuinely unscheduled row; the pause is then lifted directly
    // rather than through `resume`, because `resume` would schedule it itself and mask the
    // very thing under test.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await t.mutation(api.lib.pause, { actor: "operator_1" });
    await enqueueOne(t);
    // Nothing queued, established BEHAVIOURALLY rather than by reading the marker. Draining
    // now must send nothing, because a paused instance stores without scheduling — so the
    // drain after the repair can only deliver something the repair itself scheduled.
    //
    // The marker cannot establish this, and verification measured why: on the fixture I
    // first wrote — enqueue normally, then clear `workId` by hand — the marker also reads
    // zero, because clearing it is exactly what makes it say zero while the pool item
    // survives. That fixture delivered the event with or without the clause under test. A
    // drain that sends nothing reads 0 here and 1 there.
    await drain(t);
    expect(fetchSpy).not.toHaveBeenCalled();

    await t.run(async (ctx) => {
      const stored = await ctx.db.query("payloads").first();
      await ctx.db.delete(stored!._id);
      const settings = await ctx.db.query("settings").first();
      await ctx.db.patch(settings!._id, { paused: false, pausedReason: undefined });
    });

    expect(await enqueueOne(t)).toMatchObject({ outcome: "repaired", state: "pending" });
    await drain(t);

    // Delivered without anyone calling `resume`. Without the clause the payload comes back
    // and nothing ever starts the event.
    expect(await statusOf(t)).toMatchObject({ state: "delivered" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("repairs on an unconfigured instance, where resume cannot start it either", async () => {
    // The third shape, and the one that hides. `scheduleDelivery` declines on a missing
    // token as well as on a pause, so the row after repair looks IDENTICAL to the paused
    // case: `repaired`/`pending`, no worker, `health` counting ordinary backlog. What
    // differs is the operator's next move. `resume` counts what it actually scheduled, so
    // on a paused instance it reports 1 and delivers, and here it reports 0 and does
    // nothing at all — the documented remedy, "fix the payload, then resume", silently
    // achieves nothing until a token exists.
    //
    // That is correct rather than a defect: an unconfigured instance delivers nothing by
    // design. It is pinned because the row state cannot distinguish the two declines, so
    // this test and the paused one beside it are the only thing that says which is which.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await enqueueOne(t);
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("payloads").first();
      await ctx.db.delete(stored!._id);
    });
    await drain(t);
    expect((await statusOf(t))?.lastError?.category).toBe("payload_missing");

    // The token goes away before the repair, so scheduling declines for that reason.
    vi.stubEnv("TINYBIRD_TOKEN", "");
    fetchSpy.mockClear();
    expect(await enqueueOne(t)).toMatchObject({ outcome: "repaired", state: "pending" });
    await drain(t);
    expect(fetchSpy).not.toHaveBeenCalled();

    // The discriminating assertion: zero, where the paused instance reports one.
    expect(await t.mutation(api.lib.resume, {})).toMatchObject({ requeued: 0 });
    await drain(t);
    expect(await statusOf(t)).toMatchObject({ state: "pending" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("repairs a dead letter on a paused instance without scheduling it", async () => {
    // The one shape where the guard's condition is TRUE and the repair still schedules
    // nothing: `scheduleDelivery` declines while paused, so `requeueDeadLetter` returns the
    // row to `pending` with no worker and nothing moves until `resume`.
    //
    // That outcome is correct, and it is also exactly what the test above exists to rule
    // out — arrived at through a different door. Which is why it is worth pinning: if
    // `scheduleDelivery`'s early exits are ever reordered, this is the shape that changes
    // silently, and the two tests together say which of the two outcomes belongs where.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await enqueueOne(t);
    await t.mutation(api.lib.pause, { actor: "operator_1" });
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("payloads").first();
      await ctx.db.delete(stored!._id);
    });
    await drain(t);
    expect((await statusOf(t))?.lastError?.category).toBe("payload_missing");
    fetchSpy.mockClear();

    // Repaired and requeued, but deliberately not started: the destination is paused.
    expect(await enqueueOne(t)).toMatchObject({ outcome: "repaired", state: "pending" });
    await drain(t);
    expect(fetchSpy).not.toHaveBeenCalled();

    // The operator ordering is fix the payload, then resume — same as every other pause.
    expect(await t.mutation(api.lib.resume, {})).toMatchObject({ requeued: 1 });
    await drain(t);
    expect(await statusOf(t)).toMatchObject({ state: "delivered" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("delivers a repaired pending row through the work item it already had", async () => {
    // Named for what it does, after an earlier version claimed something it did not build.
    // It said the retry picked up a payload the first attempt never saw. Neither half was
    // true: the timers are fake, so `enqueueWithRetry` only queues the item and both the
    // delete and the repair happen before the first drain, so nothing was ever in flight
    // when the payload vanished. And the `delivered` assertion below refutes the rest — had
    // attempt 1 found no payload, `markFailed` would have written `payload_missing` and this
    // row would be `failed`.
    //
    // What it actually pins is worth keeping and was untested: a repaired `pending` row is
    // delivered by the work item it ALREADY holds. Repair deliberately does not schedule
    // that row, so if the existing item did not carry it through, nothing would.
    let attempt = 0;
    const fetchSpy = vi.fn().mockImplementation(() => {
      attempt += 1;
      return Promise.resolve(
        attempt === 1 ? jsonResponse(503, { error: "down" }) : jsonResponse(200, accepted),
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await enqueueWithRetry(t, 3);
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("payloads").first();
      await ctx.db.delete(stored!._id);
    });

    // The row holds a live item, so repair restores the payload and leaves it alone.
    expect(await enqueueOne(t)).toMatchObject({ outcome: "repaired", state: "pending" });
    await drain(t);

    expect(await statusOf(t)).toMatchObject({ state: "delivered" });
  });

  it("restores the payload of an in-flight event without disturbing it", async () => {
    // The third state a repair can find, and the one that must NOT be requeued: a
    // `delivering` row is mid-attempt by definition, so returning it to `pending` would be
    // the same double-delivery the guard exists to prevent. Recovering one that is genuinely
    // stuck is the recovery sweep's job, not enqueue's.
    //
    // This is also what stops the returned `state` being a prediction. Every other repair
    // path requeues, so `pending` was true by accident; here it is not.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    const t = setup("");
    await enqueueOne(t);
    const id = await t.run(async (ctx) => (await ctx.db.query("events").first())!._id);
    await t.mutation(internal.lifecycle.markDelivering, { eventId: id });
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("payloads").first();
      await ctx.db.delete(stored!._id);
    });

    expect(await enqueueOne(t)).toEqual({
      outcome: "repaired",
      eventId: "evt_1",
      state: "delivering",
    });
    // The payload is back, so the attempt in flight can still complete.
    expect(await t.run((ctx) => ctx.db.query("payloads").first())).not.toBeNull();
    // And it was not knocked back to pending behind that attempt's back.
    expect(await statusOf(t)).toMatchObject({ state: "delivering" });
  });

  it("refuses to repair with different content of the SAME length", async () => {
    // The case a byte-length check cannot see, and the one that dominates real payloads:
    // uuids, ISO-8601 timestamps, enum codes, booleans, zero-padded ids, numerics of equal
    // digit count. A host bug that flips a status or swaps an id produces exactly this, and
    // before the fingerprint the substituted payload was accepted AND delivered to Tinybird
    // under an identity the host already treats as settled.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: { a: "AAA" },
    });
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("payloads").first();
      await ctx.db.delete(stored!._id);
    });
    await drain(t);

    expect(
      await codeOf(
        t.mutation(api.lib.enqueue, {
          datasource: "events",
          eventId: "evt_1",
          payload: { a: "ZZZ" },
        }),
      ),
    ).toBe("identity_conflict");
    // Nothing was written and nothing was sent under the substituted content.
    expect(await t.run((ctx) => ctx.db.query("payloads").first())).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the attempt that failed before the payload went missing", async () => {
    // `markFailed` overwrites `lastError` without moving the old one into the history, so a
    // real failure is simply lost. Pre-existing, but this ticket is what makes it reachable:
    // `payload_missing` is written through `markFailed` over whatever the last attempt
    // recorded, so an event that failed a transient attempt and THEN lost its payload row
    // ends up saying only that the payload is gone — hiding the reason it was retrying.
    //
    // The state is built directly rather than driven through the pool: reaching it that way
    // needs an attempt to fail and the payload to vanish between that attempt and the next,
    // which fake timers make fragile to express and which is not what is under test here.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    const t = setup();
    await enqueueOne(t);
    const id = await t.run(async (ctx) => (await ctx.db.query("events").first())!._id);
    await t.run(async (ctx) => {
      await ctx.db.patch(id, {
        state: "pending" as const,
        attempts: 1,
        workId: undefined,
        lastError: { category: "server_error" as const, message: "503", at: Date.now() },
      });
      const stored = await ctx.db.query("payloads").first();
      await ctx.db.delete(stored!._id);
    });

    expect(await t.action(internal.deliver.deliverEvent, { eventId: id })).toEqual({
      outcome: "failed",
    });

    const dead = await statusOf(t);
    expect(dead?.lastError?.category).toBe("payload_missing");
    // The server error that came first is still readable rather than overwritten.
    expect(dead?.previousErrors?.map((error) => error.category)).toContain("server_error");
  });

  it("is idempotent: repairing twice does not resend or re-repair", async () => {
    // A host retrying its own repair is the ordinary case, not an exotic one: the call that
    // repairs is just an `enqueue`, and hosts retry those. The second call must find the
    // payload row it wrote and behave like any other duplicate.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await enqueueOne(t);
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("payloads").first();
      await ctx.db.delete(stored!._id);
    });
    await drain(t);

    expect(await enqueueOne(t)).toMatchObject({ outcome: "repaired" });
    await drain(t);
    expect(await statusOf(t)).toMatchObject({ state: "delivered" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second repair: a duplicate, no second payload row, and nothing sent again.
    expect(await enqueueOne(t)).toMatchObject({ outcome: "duplicate", state: "delivered" });
    await drain(t);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const payloadRows = await t.run(async (ctx) => {
      // eslint-disable-next-line @convex-dev/no-collect-in-query
      return (await ctx.db.query("payloads").collect()).length;
    });
    expect(payloadRows).toBe(1);
  });

  it("catches a repair whose fingerprint collides but whose length does not", async () => {
    // Why the check is length AND fingerprint rather than either alone. The fingerprint is
    // 32-bit FNV-1a, so collisions exist and are findable: these two canonical payloads both
    // hash to 61dcfbeb. They differ in length, which is the half only `payloadBytes` can see.
    //
    // Found by brute force over `{"a":"<v>"}` — the point is not that a host would hit it by
    // accident, but that with the byte check removed the suite could not tell. Every other
    // repair fixture differs in both length and hash, so nothing else discriminates them.
    //
    // The premise is asserted, not assumed. This test's whole discriminating power rests on
    // those two payloads colliding, and nothing else in the suite pins the hash's identity:
    // change the FNV offset basis and they stop colliding, the test starts passing because
    // the fingerprint now catches the mismatch, and the byte check it exists to bind can be
    // deleted again with everything green. Verification measured exactly that. So the
    // collision is checked here, and a change to the hash reds this test rather than
    // disarming it.
    const left = canonicalJson({ a: "8pwf" });
    const right = canonicalJson({ a: "0j0e0" });
    expect(payloadFingerprint(left)).toBe(payloadFingerprint(right));
    expect(utf8Length(left)).not.toBe(utf8Length(right));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    const t = setup();
    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: { a: "8pwf" },
    });
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("payloads").first();
      await ctx.db.delete(stored!._id);
    });
    await drain(t);

    expect(
      await codeOf(
        t.mutation(api.lib.enqueue, {
          datasource: "events",
          eventId: "evt_1",
          payload: { a: "0j0e0" },
        }),
      ),
    ).toBe("identity_conflict");
    expect(await t.run((ctx) => ctx.db.query("payloads").first())).toBeNull();
  });

  it("checks the content of a DELIVERED event before calling it a duplicate", async () => {
    // The repair branch must not be more permissive than the path beside it. Returning
    // `duplicate` before comparing content meant a delivered event whose payload row had
    // gone accepted anything at all — so a host relying on `identity_conflict` to catch a
    // payload-generation bug lost that signal precisely when something was already known to
    // be wrong.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    const t = setup();
    await enqueueOne(t);
    await drain(t);
    expect(await statusOf(t)).toMatchObject({ state: "delivered" });
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("payloads").first();
      await ctx.db.delete(stored!._id);
    });

    // Different content: a conflict, exactly as it would be with the payload row present.
    expect(
      await codeOf(
        t.mutation(api.lib.enqueue, {
          datasource: "events",
          eventId: "evt_1",
          payload: { ...row, changed: true },
        }),
      ),
    ).toBe("identity_conflict");

    // Matching content: a duplicate, because there is nothing to resend and nothing to fix.
    expect(await enqueueOne(t)).toMatchObject({ outcome: "duplicate", state: "delivered" });
    // Not repaired: a delivered event gets no payload row back.
    expect(await t.run((ctx) => ctx.db.query("payloads").first())).toBeNull();
  });

  it("refuses to repair a lost payload with a different one", async () => {
    // The payload itself is gone, so it cannot be compared. `payloadBytes` stays on the
    // event row and is the only surviving evidence of what was committed — a weak check,
    // but the alternative is letting a repair silently substitute different content under
    // an identity a host already treats as settled.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    const t = setup();
    await enqueueOne(t);
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("payloads").first();
      await ctx.db.delete(stored!._id);
    });
    await drain(t);

    expect(
      await codeOf(
        t.mutation(api.lib.enqueue, {
          datasource: "events",
          eventId: "evt_1",
          payload: { ...row, extra: "a much longer payload than the original" },
        }),
      ),
    ).toBe("identity_conflict");
    // Still no payload row: a refused repair must not leave a partial one.
    expect(await t.run((ctx) => ctx.db.query("payloads").first())).toBeNull();
  });
});
