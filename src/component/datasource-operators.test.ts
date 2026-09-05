import { COUNT_CAP, DEFAULT_RESUME_LIMIT } from "./contract";
import { api } from "./_generated/api";
import {
  drain,
  installComponentTestHooks,
  jsonResponse,
  seedEvent,
  setup,
} from "../testing/fixtures";

installComponentTestHooks();

it("counts only the requested datasource while retaining mount-wide counts", async () => {
  const t = setup("");
  for (const [i, datasource] of ["orders", "clicks", "clicks"].entries()) {
    await t.mutation(api.lib.enqueue, { datasource, eventId: String(i), payload: {} });
  }
  expect((await t.query(api.lib.health, { datasource: "orders" })).counts.pending.count).toBe(1);
  expect((await t.query(api.lib.health, { datasource: "clicks" })).counts.pending.count).toBe(2);
  expect((await t.query(api.lib.health, {})).counts.pending.count).toBe(3);
});

it("pauses and resumes one datasource while another keeps delivering", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(() => jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
  );
  const t = setup();
  await t.mutation(api.lib.pause, { datasource: "clicks" });
  for (const datasource of ["orders", "clicks"]) {
    await t.mutation(api.lib.enqueue, { datasource, eventId: "one", payload: {} });
  }
  await drain(t);
  expect((await t.query(api.lib.getStatus, { datasource: "orders", eventId: "one" }))?.state).toBe(
    "delivered",
  );
  expect((await t.query(api.lib.getStatus, { datasource: "clicks", eventId: "one" }))?.state).toBe(
    "pending",
  );
  expect(await t.mutation(api.lib.resume, { datasource: "clicks" })).toMatchObject({ requeued: 1 });
  await drain(t);
  expect((await t.query(api.lib.getStatus, { datasource: "clicks", eventId: "one" }))?.state).toBe(
    "delivered",
  );
});

it.each([undefined, "quarantined" as const])(
  "replays a datasource behind a full page of unrelated dead letters (%s)",
  async (category) => {
    const t = setup("");
    await t.run(async (ctx) => {
      for (let i = 0; i < 135; i++)
        await seedEvent(ctx, {
          datasource: i < 130 ? "orders" : "clicks",
          eventId: String(i),
          state: "failed",
          attempts: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastError: { category: "quarantined", message: "bad row", at: Date.now() },
        });
    });
    expect(await t.mutation(api.lib.replayFailed, { datasource: "clicks", category })).toEqual({
      replayed: 5,
      remaining: false,
    });
    expect((await t.query(api.lib.health, { datasource: "orders" })).counts.failed.count).toBe(130);
  },
);

it("applies a scoped pause to queued work without stopping the other datasource", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(() => jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
  );
  const t = setup();
  for (const datasource of ["orders", "clicks"])
    await t.mutation(api.lib.enqueue, { datasource, eventId: "one", payload: {} });
  await t.mutation(api.lib.pause, { datasource: "clicks", actor: "click-operator" });
  await drain(t);
  expect((await t.query(api.lib.getStatus, { datasource: "orders", eventId: "one" }))?.state).toBe(
    "delivered",
  );
  expect((await t.query(api.lib.getStatus, { datasource: "clicks", eventId: "one" }))?.state).toBe(
    "pending",
  );
  const clicks = await t.query(api.lib.health, { datasource: "clicks" });
  const orders = await t.query(api.lib.health, { datasource: "orders" });
  expect(clicks).toMatchObject({ paused: true, lastOperatorAction: { actor: "click-operator" } });
  expect(clicks.lastDeliveredAt).toBeUndefined();
  expect(orders.paused).toBe(false);
  expect(orders.lastDeliveredAt).toBeDefined();
});

it("does not let scoped resume override a mount pause, and global resume clears every pause", async () => {
  const t = setup("");
  await t.mutation(api.lib.pause, { datasource: "clicks" });
  await t.mutation(api.lib.pause, {});
  expect(await t.mutation(api.lib.resume, { datasource: "orders" })).toMatchObject({
    paused: true,
    requeued: 0,
  });
  expect((await t.query(api.lib.health, { datasource: "clicks" })).paused).toBe(true);
  await t.mutation(api.lib.resume, {});
  expect((await t.query(api.lib.health, { datasource: "clicks" })).paused).toBe(false);
  expect((await t.query(api.lib.health, { datasource: "orders" })).paused).toBe(false);
  await t.mutation(api.lib.pause, { datasource: "clicks" });
  expect((await t.query(api.lib.health, { datasource: "clicks" })).paused).toBe(true);
  expect((await t.query(api.lib.health, {})).paused).toBe(false);
});

it("scoped resume reaches its datasource past a full paused prefix", async () => {
  const t = setup();
  await t.mutation(api.lib.pause, { datasource: "orders" });
  await t.mutation(api.lib.pause, { datasource: "clicks" });
  for (let i = 0; i < DEFAULT_RESUME_LIMIT + 5; i++)
    await t.mutation(api.lib.enqueue, {
      datasource: "orders",
      eventId: String(i),
      payload: {},
    });
  await t.mutation(api.lib.enqueue, { datasource: "clicks", eventId: "one", payload: {} });
  expect(await t.mutation(api.lib.resume, { datasource: "clicks" })).toEqual({
    paused: false,
    requeued: 1,
  });
  expect((await t.query(api.lib.health, { datasource: "orders" })).paused).toBe(true);
  const orders = await t.run((ctx) =>
    ctx.db
      .query("events")
      .withIndex("by_identity", (q) => q.eq("datasource", "orders"))
      .take(DEFAULT_RESUME_LIMIT + 6),
  );
  expect(orders.every((event) => event.workId === undefined)).toBe(true);
});

it("scoped health reaches its datasource beyond another datasource's count cap", async () => {
  const t = setup("");
  await t.run(async (ctx) => {
    for (let i = 0; i < COUNT_CAP + 4; i++)
      await seedEvent(ctx, {
        datasource: i < COUNT_CAP + 2 ? "orders" : "clicks",
        eventId: String(i),
        state: "pending",
        attempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
  });
  expect((await t.query(api.lib.health, { datasource: "clicks" })).counts.pending).toEqual({
    count: 2,
    capped: false,
  });
  expect((await t.query(api.lib.health, {})).counts.pending).toEqual({
    count: COUNT_CAP,
    capped: true,
  });
});
