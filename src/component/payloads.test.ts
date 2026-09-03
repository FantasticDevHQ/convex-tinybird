import { readFileSync } from "node:fs";

import { api } from "./_generated/api";
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

  it("refuses to send an event whose payload row is gone", async () => {
    // The branch `architecture.md`'s migration note depends on, and nothing else reaches it:
    // no code in this component deletes from either table, so only a hand-built fixture or a
    // future retention sweep can produce a payload-less event. Deleting the guard leaves an
    // event that POSTs an empty NDJSON line to Tinybird, which is worse than not sending.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await enqueueOne(t);
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("payloads").first();
      await ctx.db.delete(stored!._id);
    });
    await drain(t);

    expect(fetchSpy).not.toHaveBeenCalled();

    // And the honest consequence, which the migration note now states rather than implying
    // a `failed` state an operator could find: the event is STRANDED. It stays `pending`
    // with no attempt and no recorded error, so replay cannot reach it — replay only takes
    // `failed` — and resume re-queues it into the same silent skip. The only moving signal
    // is `oldestPendingAgeMs`. Making that a dead letter needs a failure category the
    // contract does not have, which is FTD-2531.
    expect(await statusOf(t)).toMatchObject({ state: "pending", attempts: 0 });
    expect((await statusOf(t))?.lastError).toBeUndefined();
    expect((await t.query(api.lib.health, {})).counts.failed.count).toBe(0);
  });

  it("reads the payload only on the delivery path", () => {
    // A source assertion, because convex-test enforces no byte limit and so cannot show the
    // cost. Anchored on the call shape rather than a word, comments stripped first.
    //
    // Every file, not just `lib.ts`. `scheduleDelivery`, `boundedCount` and `readHeartbeat`
    // live in `state.ts`, and `scheduleDelivery` runs once per row on exactly the paged
    // paths this ticket exists to make cheap — `resume` and both replays. An earlier
    // version of this test read `lib.ts` alone, and independent verification put a real
    // per-row payload read inside `scheduleDelivery` with the whole suite still green.
    const read = (name: string) =>
      readFileSync(new URL(`./${name}`, import.meta.url), "utf8").replace(
        /\/\/[^\n]*|\/\*[\s\S]*?\*\//gu,
        "",
      );
    const counts = Object.fromEntries(
      ["lib.ts", "state.ts", "deliver.ts", "canonical.ts", "classify.ts", "destination.ts"].map(
        (name) => [name, (read(name).match(/query\("payloads"\)/gu) ?? []).length],
      ),
    );

    // Two in `lib.ts`: the dedupe comparison in `enqueue`, and `loadForDelivery`. Zero
    // everywhere else. A third anywhere is a new consumer and has to be justified rather
    // than added silently.
    expect(counts).toEqual({
      "lib.ts": 2,
      "state.ts": 0,
      "deliver.ts": 0,
      "canonical.ts": 0,
      "classify.ts": 0,
      "destination.ts": 0,
    });
  });
});
