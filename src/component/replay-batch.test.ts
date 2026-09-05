import { api } from "./_generated/api";
import { DEFAULT_REPLAY_LIMIT, DEFAULT_RESUME_LIMIT, MAX_REPLAY_LIMIT } from "./contract";
import {
  drain,
  installComponentTestHooks,
  jsonResponse,
  seedEvent,
  setup,
} from "../testing/fixtures";

installComponentTestHooks();

it("queues and delivers the 100-event ceiling with large separate payloads", async () => {
  const t = setup();
  const fetchMock = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
  vi.stubGlobal("fetch", fetchMock);
  const payload = JSON.stringify({ data: "x".repeat(64 * 1024 - 11) });
  const failure = { category: "quarantined" as const, message: "schema mismatch", at: 1 };
  for (let start = 0; start < 101; start += 10) {
    await t.run(async (ctx) => {
      for (let i = start; i < Math.min(start + 10, 101); i += 1) {
        await seedEvent(ctx, {
          datasource: "events",
          eventId: `batch_${i}`,
          payload,
          state: "failed",
          attempts: 3,
          createdAt: i,
          updatedAt: i,
          lastError: failure,
          previousErrors: [failure],
        });
      }
    });
  }
  expect(await t.mutation(api.lib.replayFailed, { limit: 100 })).toEqual({
    replayed: 100,
    remaining: true,
  });
  await t.run(async (ctx) => {
    const pending = await ctx.db
      .query("events")
      .withIndex("by_state_createdAt", (q) => q.eq("state", "pending"))
      .collect();
    expect(pending).toHaveLength(100);
    for (const event of pending) {
      expect(event.workId).toBeDefined();
      expect(event.attempts).toBe(0);
      expect(event.previousErrors).toEqual([failure, failure]);
      expect((await ctx.db.get(event.payloadId!))?.payload).toBe(payload);
    }
  });
  expect(DEFAULT_REPLAY_LIMIT).toBe(50);
  expect(MAX_REPLAY_LIMIT).toBe(100);
  expect(MAX_REPLAY_LIMIT).toBe(DEFAULT_RESUME_LIMIT);
  await drain(t);
  expect(fetchMock).toHaveBeenCalledTimes(100);
  const health = await t.query(api.lib.health, {});
  const delivered = await t.run((ctx) =>
    ctx.db
      .query("events")
      .withIndex("by_state_createdAt", (q) => q.eq("state", "delivered"))
      .collect(),
  );
  expect(delivered).toHaveLength(100);
  expect(health.counts.failed.count).toBe(1);
});
