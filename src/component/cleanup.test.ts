import { api } from "./_generated/api";
import { DEFAULT_CLEANUP_LIMIT } from "./contract";
import {
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
      await ctx.db.patch(event!._id, { createdAt: Date.now() - 10 * DAY });
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
});
