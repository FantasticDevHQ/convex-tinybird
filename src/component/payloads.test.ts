import { readdirSync, readFileSync } from "node:fs";

import { api, internal } from "./_generated/api";

import {
  codeOf,
  drain,
  enqueueOne,
  installComponentTestHooks,
  jsonResponse,
  row,
  settingsOf,
  setup,
  statusOf,
  type TestInstance,
} from "../testing/fixtures";

installComponentTestHooks();

const accepted = { successful_rows: 1, quarantined_rows: 0 };

/** The two tables, counted. Neither number is interesting alone; the pairing is. */
async function rowCounts(t: TestInstance) {
  return t.run(async (ctx) => {
    // eslint-disable-next-line @convex-dev/no-collect-in-query
    const events = await ctx.db.query("events").collect();
    // eslint-disable-next-line @convex-dev/no-collect-in-query
    const payloads = await ctx.db.query("payloads").collect();
    return { events: events.length, payloads: payloads.length };
  });
}

describe("the payload lives outside the counted row", () => {
  it("keeps no payload text on the event row itself", async () => {
    // The whole point of the split. `health`, replay, resume and retention all page over
    // `events`, and Convex returns WHOLE documents — so a payload on this row makes every
    // one of those reads cost `rows x event size` instead of `rows`.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    const t = setup();
    const marker = "x".repeat(4096);
    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: { ...row, blob: marker },
    });

    const event = await t.run((ctx) => ctx.db.query("events").first());
    expect(event).not.toBeNull();
    // Asserted over the serialised row, so a payload smuggled under any other key fails too.
    expect(JSON.stringify(event)).not.toContain(marker);
    expect(event).not.toHaveProperty("payload");
    // Not vacuous: the payload really was stored, just elsewhere.
    const stored = await t.run((ctx) => ctx.db.query("payloads").first());
    expect(stored?.payload).toContain(marker);
  });

  it("keeps exactly one payload per event across a rejected re-enqueue", async () => {
    // Note what this does and does not establish. "A rollback leaves neither row" is
    // Convex's guarantee, not this code's: moving the validation below both inserts leaves
    // this test green, which independent verification confirmed by doing it. The pairing
    // that is NOT free is one payload per event — a conflicting re-enqueue must not add a
    // second one, and nothing but this asserts that.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    const t = setup();

    // An oversize payload is rejected after the canonical form is computed, which is the
    // window in which a half-written pair would be possible.
    expect(
      await codeOf(
        t.mutation(api.lib.enqueue, {
          datasource: "events",
          eventId: "evt_big",
          payload: { ...row, blob: "y".repeat(200_000) },
          maxPayloadBytes: 1024,
        }),
      ),
    ).toBe("payload_too_large");
    expect(await rowCounts(t)).toEqual({ events: 0, payloads: 0 });

    await enqueueOne(t);
    expect(await rowCounts(t)).toEqual({ events: 1, payloads: 1 });

    // A conflicting re-enqueue must not leave a second payload behind either.
    expect(
      await codeOf(
        t.mutation(api.lib.enqueue, {
          datasource: "events",
          eventId: "evt_1",
          payload: { ...row, changed: true },
        }),
      ),
    ).toBe("identity_conflict");
    expect(await rowCounts(t)).toEqual({ events: 1, payloads: 1 });
  });

  it("still compares the canonical payload across the split", async () => {
    // Dedupe is the reason the payload is kept at all. Reordering the keys must still read
    // as the same event, and changing a value must still conflict — both now require
    // reading a different table than the one the identity index found.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    const t = setup();
    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: { b: 2, a: 1 },
    });

    expect(
      await t.mutation(api.lib.enqueue, {
        datasource: "events",
        eventId: "evt_1",
        payload: { a: 1, b: 2 },
      }),
    ).toMatchObject({ outcome: "duplicate" });

    expect(
      await codeOf(
        t.mutation(api.lib.enqueue, {
          datasource: "events",
          eventId: "evt_1",
          payload: { a: 1, b: 3 },
        }),
      ),
    ).toBe("identity_conflict");
    expect(await rowCounts(t)).toEqual({ events: 1, payloads: 1 });
  });

  it("sends the payload it stored, unchanged", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: { b: 2, a: 1 },
    });
    await drain(t);

    expect(await statusOf(t)).toMatchObject({ state: "delivered" });
    // Canonical form, read back out of the other table and put on the wire verbatim.
    // One NDJSON line, so the trailing newline is part of the contract, not noise.
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe('{"a":1,"b":2}\n');
  });

  it("never leaks the payload into an operator surface", async () => {
    // `getStatus`, `health` and every recorded error are read by operators and by hosts.
    // The payload is the one field in this component that can carry customer data, so it
    // must not reach any of them even when the destination is failing.
    const marker = "canary_payload_value";
    // The refusal body ECHOES the payload, the way a real Tinybird schema error quotes the
    // row it rejected. Without that, a future change that copied `body.error` into the
    // recorded message would leak the payload and this test would stay green — the canary
    // would be watching a string that never contained the marker in the first place.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(400, { error: `cannot parse row: {"secret":"${marker}"}` }),
        ),
    );
    const t = setup();
    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: { ...row, secret: marker },
    });
    await drain(t);

    const status = await statusOf(t);
    expect(status).toMatchObject({ state: "failed" });
    expect(JSON.stringify(status)).not.toContain(marker);
    expect(JSON.stringify(await t.query(api.lib.health, {}))).not.toContain(marker);
    expect(JSON.stringify(await t.query(api.lib.heartbeat, {}))).not.toContain(marker);
    expect(JSON.stringify(await settingsOf(t))).not.toContain(marker);
  });

  it("dead-letters an event whose payload row is gone, rather than stranding it", async () => {
    // Nothing in this component deletes from either table, so only a hand-built fixture or a
    // future retention sweep can produce a payload-less event. Before FTD-2531 the delivery
    // action read a missing payload as "the event is gone" — a benign race — so the row sat
    // `pending` with `attempts: 0` and no error, unreachable by replay because replay takes
    // only `failed` rows, and re-queued by resume into the same silent skip forever. The only
    // moving signal was `oldestPendingAgeMs`, carrying no reason.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await enqueueOne(t);
    const id = await t.run(async (ctx) => (await ctx.db.query("events").first())!._id);
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("payloads").first();
      await ctx.db.delete(stored!._id);
    });

    // Asserted BEFORE the drain, and the ordering is the test. The action REPORTS the
    // failure rather than throwing it, but the row converges either way — `markFailed`
    // terminalises it, so a later call returns `skipped` and nothing else in the suite can
    // tell a throw from a return. This is the only moment the distinction is observable.
    expect(await t.action(internal.deliver.deliverEvent, { eventId: id })).toEqual({
      outcome: "failed",
    });
    await drain(t);

    // Still nothing sent: an empty NDJSON line is worse than no request at all.
    expect(fetchSpy).not.toHaveBeenCalled();

    const dead = await statusOf(t);
    // `attempts: 0` is not decoration: it pins that a payload fault does not spend the retry
    // budget, which both the commit message and architecture.md assert. Moving the check
    // below `markDelivering` makes it 1, and an earlier round of review established exactly
    // this — my rewrite dropped the field from the matcher and lost the coverage with it.
    expect(dead).toMatchObject({ state: "failed", attempts: 0 });
    expect(dead?.lastError?.category).toBe("payload_missing");
    // A message an operator can act on, not just a category.
    expect(dead?.lastError?.message).toMatch(/payload/iu);

    // The two things stranding denied an operator: it is counted, and it is reachable.
    expect((await t.query(api.lib.health, {})).counts.failed.count).toBe(1);
    // Reachable means replay actually selects it. It will fail again — the payload is still
    // gone — but an operator who restores the row can now drain it, which is the whole
    // difference between a dead letter and a stranded row.
    expect(await t.mutation(api.lib.replayFailed, {})).toEqual({ replayed: 1, remaining: false });
  });

  it("still treats a missing EVENT row as the benign race it is", async () => {
    // The other half of the distinction. A vanished event is a race — replayed elsewhere,
    // already finished, cleaned up — and must record nothing. Collapsing the two cases back
    // together would either strand payload faults again or dead-letter ordinary races.
    // CONFIGURED, so the delivery action actually runs and reaches the null. An
    // unconfigured instance never schedules, so nothing would exercise this path at all —
    // the first version of this test used `setup("")` and stayed green when the missing-event
    // branch was removed entirely.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await enqueueOne(t);
    const id = await t.run(async (ctx) => (await ctx.db.query("events").first())!._id);
    await t.run(async (ctx) => {
      await ctx.db.delete(id);
      const stored = await ctx.db.query("payloads").first();
      await ctx.db.delete(stored!._id);
    });
    await drain(t);

    expect(await t.run((ctx) => ctx.db.query("events").first())).toBeNull();
    // Nothing sent and nothing recorded: no settings row, so no destination-wide lastError.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await settingsOf(t)).toBeNull();

    // Asserted on the action's own return, because with the row deleted there is no durable
    // trace to read: a thrown action and a skipped one leave the same empty database, and
    // `onDeliveryComplete` finds nothing to write against either. `skipped` is the whole
    // observable difference between treating this as a race and dereferencing a null.
    expect(await t.action(internal.deliver.deliverEvent, { eventId: id })).toEqual({
      outcome: "skipped",
    });
  });

  it("reads the payload only on the delivery path", () => {
    // A source assertion, because convex-test enforces no byte limit and so cannot show the
    // cost. Anchored on the call shape rather than a word, comments stripped first.
    //
    // ENUMERATED, not listed. Two earlier versions of this test were blind in the same way
    // for different reasons: the first read `lib.ts` alone, and independent verification put
    // a per-row payload read inside `scheduleDelivery` in `state.ts` with the suite green;
    // the second named six files, and a new `retention.ts` with a per-row read inside a
    // paged loop was equally invisible. A hardcoded list cannot see the file that does not
    // exist yet, and retention is the next file this component gains.
    //
    // Note the failure mode is not that someone loosens this guard when a file is added —
    // it is that nobody has to, because the new file is silently uncounted.
    const dir = new URL(".", import.meta.url);
    const files = readdirSync(dir).filter(
      (name) => name.endsWith(".ts") && !name.includes(".test."),
    );
    // A floor, so an empty or mis-scoped glob cannot pass by reading nothing at all.
    expect(files.length).toBeGreaterThan(6);

    const sourceOf = (name: string) =>
      readFileSync(new URL(name, dir), "utf8").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, "");
    const reads = Object.fromEntries(
      files.map((name) => [name, (sourceOf(name).match(/query\("payloads"\)/gu) ?? []).length]),
    );

    // Three reads, each one justified, and the whole point is that there are no others.
    //
    // `lib.ts` — the duplicate comparison in `enqueue`, which needs the canonical text to
    // tell a duplicate from a conflict. `lifecycle.ts` — `loadForDelivery`, which needs it
    // to send. Both run once per event, not once per paged read.
    //
    // `state.ts` has two, and WHERE they are is the claim — not how many. Counting per file
    // cannot see a read moved from a justified function into a paged loop in the same file,
    // and verification demonstrated exactly that: deleting the fallback and putting a
    // per-row read inside `sweepExpired` left the count at one and the test green — which is
    // the defect this guard's own comment says it exists to catch.
    //
    // So each read is bound to the function allowed to make it.
    const bodyOf = (source: string, fn: string) => {
      const start = source.indexOf(`export async function ${fn}`);
      expect(start).toBeGreaterThan(-1);
      const end = source.indexOf("\n}", start);
      return source.slice(start, end === -1 ? undefined : end);
    };
    const state = sourceOf("state.ts");
    const readsIn = (fn: string) => (bodyOf(state, fn).match(/query\("payloads"\)/gu) ?? []).length;

    // The fallback for a row whose pointer was never recorded: leaking a payload is worse
    // than paying for one read, and it is bounded to rows that should not exist.
    expect(readsIn("deleteEventWithPayload")).toBe(1);
    // The orphan scan cannot avoid reading payloads, which is why it is a separate, rarer
    // call with a much smaller limit rather than part of the sweep.
    expect(readsIn("sweepOrphanedPayloads")).toBe(1);
    // And the paged path makes none, which is the whole point of the pointer.
    expect(readsIn("sweepExpired")).toBe(0);

    // The per-function pins above bound the three functions they NAME, and nothing else. So
    // the file's total is pinned too. Verification walked straight through the named-only
    // version by extracting a helper — moving the per-row read into a new `auditPayload()`
    // called from `sweepExpired`'s loop left all three assertions true and the suite green
    // at 222/222. A read added to `scheduleDelivery` or `requeueDeadLetter` would do the
    // same, and neither is named here.
    //
    // Two, matching the two pinned above. Together the assertions say: exactly these reads,
    // in exactly these functions. Extracting a helper now fails on the total even though
    // every per-function count still holds, which is the case the pins alone cannot see.
    expect(reads["state.ts"]).toBe(2);

    // The stale-pointer tolerance must ask the DATABASE, never the error message. Matching
    // the message was a live production bug rather than a style preference: convex-test
    // throws `Delete on non-existent doc` and the Convex backend throws `Delete on
    // nonexistent document ID {id}` — different spellings of "nonexistent", and the
    // hyphenated form appears nowhere in the backend. A guard written against the harness
    // rethrew in production on the one case it existed to tolerate, restoring a permanent
    // retention wedge, while every test stayed green because the harness produced the only
    // string that satisfied it.
    //
    // No behavioural test can catch that, here or anywhere: the harness IS what the guard
    // would be matching against. So the shape is asserted instead — the positive claim that
    // it consults the database, and the negative one that it reads no message.
    const deleteBody = bodyOf(state, "deleteEventWithPayload");
    expect(deleteBody).toContain("await ctx.db.get(event.payloadId)");
    expect(deleteBody).not.toMatch(/message/u);

    const justified = ["lib.ts", "lifecycle.ts", "state.ts"];
    const unexpected = Object.keys(reads).filter(
      (name) => !justified.includes(name) && reads[name] > 0,
    );
    expect(unexpected).toEqual([]);
  });
});
