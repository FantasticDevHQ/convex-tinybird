import { api, internal } from "./_generated/api";
import { DEFAULT_REPLAY_LIMIT, type FailureCategory } from "./contract";
import { installComponentTestHooks, setup, type TestInstance } from "../testing/fixtures";

installComponentTestHooks();

async function fail(t: TestInstance, eventId: string, category: FailureCategory) {
  await t.mutation(api.lib.enqueue, {
    datasource: "events",
    eventId,
    payload: { event_id: eventId },
  });
  const event = await t.run((ctx) =>
    ctx.db
      .query("events")
      .withIndex("by_identity", (q) => q.eq("datasource", "events").eq("eventId", eventId))
      .unique(),
  );
  await t.mutation(internal.lifecycle.markFailed, {
    eventId: event!._id,
    error: { category, message: "failure", at: Date.now() },
  });
}

describe("category replay", () => {
  it("drains a category hidden behind more than a full page of other failures", async () => {
    const t = setup("");
    for (let i = 0; i < 130; i++) await fail(t, `other_${i}`, "invalid_request");
    for (let i = 0; i < DEFAULT_REPLAY_LIMIT + 3; i++) await fail(t, `target_${i}`, "quarantined");

    const results = [];
    for (let pass = 0; pass < 3; pass++) {
      const result = await t.mutation(api.lib.replayFailed, { category: "quarantined" });
      results.push(result);
      const matching = await t.run(async (ctx) =>
        (await ctx.db.query("events").take(200)).filter(
          (event) => event.state === "failed" && event.lastError?.category === "quarantined",
        ),
      );
      expect(result.remaining).toBe(matching.length > 0);
      if (!result.remaining) break;
    }
    expect(results).toEqual([
      { replayed: DEFAULT_REPLAY_LIMIT, remaining: true },
      { replayed: 3, remaining: false },
    ]);
    const others = await t.run(async (ctx) =>
      (await ctx.db.query("events").take(200)).filter((event) =>
        event.eventId.startsWith("other_"),
      ),
    );
    expect(others).toHaveLength(130);
    expect(others.every((event) => event.state === "failed" && !event.previousErrors?.length)).toBe(
      true,
    );
    expect(await t.mutation(api.lib.replayFailed, { category: "quarantined" })).toEqual({
      replayed: 0,
      remaining: false,
    });
  });
});

it("requires a bounded backfill for pre-index rows without replaying them", async () => {
  const t = setup("");
  for (let i = 0; i < 105; i++) await fail(t, `legacy_${i}`, "quarantined");
  await t.run(async (ctx) => {
    for (const event of await ctx.db.query("events").take(110)) {
      await ctx.db.patch(event._id, { lastErrorCategory: undefined });
    }
  });
  await expect(t.mutation(api.lib.replayFailed, { category: "quarantined" })).rejects.toThrow(
    "category_index_not_ready",
  );
  const first = await t.mutation(internal.migrations.backfillErrorCategories, {
    limit: 10000,
    cursor: null,
  });
  expect(first).toMatchObject({ updated: 100, isDone: false });
  const last = await t.mutation(internal.migrations.backfillErrorCategories, {
    limit: 100,
    cursor: first.continueCursor,
  });
  expect(last).toMatchObject({ updated: 5, isDone: true });
  const rows = await t.run((ctx) => ctx.db.query("events").take(110));
  expect(
    rows.every((event) => event.state === "failed" && event.lastErrorCategory === "quarantined"),
  ).toBe(true);
  expect(await t.mutation(api.lib.replayFailed, { category: "quarantined" })).toEqual({
    replayed: DEFAULT_REPLAY_LIMIT,
    remaining: true,
  });
});

it("moves refailed matching events behind categories not yet replayed", async () => {
  const t = setup("");
  for (let i = 0; i < 5; i++) await fail(t, `target_${i}`, "quarantined");
  for (let pass = 0; pass < 3; pass++) {
    vi.setSystemTime(Date.now() + 1000);
    await t.mutation(api.lib.replayFailed, { category: "quarantined", limit: 2 });
    const pending = await t.run((ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_state_updatedAt", (q) => q.eq("state", "pending"))
        .take(5),
    );
    for (const event of pending)
      await t.mutation(internal.lifecycle.markFailed, {
        eventId: event._id,
        error: { category: "quarantined", message: "still broken", at: Date.now() },
      });
  }
  const events = await t.run((ctx) => ctx.db.query("events").take(5));
  expect(events.map((event) => event.previousErrors?.length ?? 0).sort()).toEqual([1, 1, 1, 1, 2]);
});

it("backfills across datasource boundaries in identity order", async () => {
  const t = setup("");
  await t.run(async (ctx) => {
    for (const datasource of ["gamma", "alpha", "beta"]) {
      for (let i = 0; i < 4; i++) {
        await ctx.db.insert("events", {
          datasource,
          eventId: String(i),
          state: "failed",
          attempts: 1,
          payloadBytes: 2,
          payloadHash: "fixture",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastError: { category: "quarantined", message: "legacy", at: Date.now() },
        });
      }
    }
  });
  let cursor: { datasource: string; eventId: string } | null = null;
  let updated = 0;
  const cursors = [];
  for (let pass = 0; pass < 10; pass++) {
    const result: {
      updated: number;
      isDone: boolean;
      continueCursor: { datasource: string; eventId: string } | null;
    } = await t.mutation(internal.migrations.backfillErrorCategories, {
      limit: 3,
      cursor,
    });
    updated += result.updated;
    cursor = result.continueCursor;
    cursors.push(cursor);
    if (result.isDone) break;
  }
  expect(updated).toBe(12);
  const events = await t.run((ctx) => ctx.db.query("events").take(20));
  expect(cursors).toEqual([
    { datasource: "alpha", eventId: "2" },
    { datasource: "beta", eventId: "1" },
    { datasource: "gamma", eventId: "0" },
    { datasource: "gamma", eventId: "3" },
  ]);
  expect(events.every((event) => event.lastErrorCategory === "quarantined")).toBe(true);
});
