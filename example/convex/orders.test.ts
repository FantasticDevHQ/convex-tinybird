import { register } from "@fantasticdevhq/convex-tinybird/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";

import { api, components, internal } from "./_generated/api";
import schema from "./schema";

export const modules = import.meta.glob("./**/*.ts");

const accepted = { successful_rows: 1, quarantined_rows: 0 };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A host app with BOTH instances registered.
 *
 * `register` is called once per mount, which is the thing a consumer has to get right and the
 * thing this file exists to demonstrate. It also registers each instance's nested Workpool,
 * without which the first enqueue would fail the moment it scheduled work.
 */
function setup() {
  const t = convexTest({ schema, modules, transactionLimits: true });
  register(t, "productEvents");
  register(t, "auditEvents");
  return t;
}

/** A fresh Response per call: a body can be read once, and these tests deliver twice. */
function acceptEverything() {
  const spy = vi.fn().mockImplementation(() => jsonResponse(200, accepted));
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  // Delivery runs on a Workpool, which schedules — so draining it needs the timers mocked.
  // Without this every test that waits for a delivery fails on "timers APIs are not mocked".
  vi.useFakeTimers();
  // The component's own declared variable, not the host's mount-time names. `convex.config.ts`
  // maps `PRODUCT_TINYBIRD_TOKEN` into the mount's `TINYBIRD_TOKEN` on a real deployment, but
  // `convex-test` registers the component's modules directly and never evaluates that mapping —
  // so a test that stubs the host-side names configures nothing and every delivery silently
  // does not happen. Worth knowing before writing a test that asserts a request was made.
  //
  // Both mounts therefore share one token here. `vi.stubEnv` is process-wide, so per-instance
  // credentials are not expressible in this harness; that is a limit of the harness and not of
  // the component, which reads each mount's own env on a real deployment.
  vi.stubEnv("TINYBIRD_TOKEN", "p.example");
});

afterEach(() => {
  // Restored explicitly. Leaving fake timers installed makes an async teardown elsewhere wait
  // on a clock that never advances, which shows up as an unrelated ten-second hang.
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("adopting the component in an unrelated app", () => {
  it("delivers an order event end to end", async () => {
    const fetchSpy = acceptEverything();
    const t = setup();

    await t.mutation(api.orders.place, { sku: "SKU-1", quantity: 2 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Two streams, two requests. Asserting the count rather than "at least one" is what makes
    // this see a mount that quietly delivers to the wrong instance.
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const order = await t.run(async (ctx) => ctx.db.query("orders").first());
    const status = await t.query(api.orders.deliveryStatus, { orderId: order!._id });
    expect(status).toMatchObject({ state: "delivered" });
  });

  it("rolls the event back with the order when the host mutation fails", async () => {
    // The whole reason the enqueue is a write in the caller's transaction. If this ever passes
    // with an event surviving, the component has stopped being transactional and a host would
    // ship analytics for orders that do not exist.
    acceptEverything();
    const t = setup();

    await expect(
      t.mutation(api.orders.place, { sku: "SKU-2", quantity: 1, failAfterEnqueue: true }),
    ).rejects.toThrow(/host failed/u);

    const orders = await t.run(async (ctx) => ctx.db.query("orders").take(10));
    expect(orders).toHaveLength(0);

    // And neither instance kept the event.
    for (const name of ["productEvents", "auditEvents"] as const) {
      const health = await t.query(components[name].lib.health, {});
      expect(health.counts).toMatchObject({ pending: { count: 0 }, delivering: { count: 0 } });
    }
  });

  it("keeps the two instances' events, settings and health separate", async () => {
    const fetchSpy = acceptEverything();
    const t = setup();
    await t.mutation(api.orders.place, { sku: "SKU-3", quantity: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Pausing one must not pause the other. A component that shared a settings row between
    // mounts would fail here and nowhere in its own suite, which registers one instance.
    await t.mutation(components.productEvents.lib.pause, { actor: "operator" });

    const paused = await t.query(components.productEvents.lib.health, {});
    const untouched = await t.query(components.auditEvents.lib.health, {});
    expect(paused.paused).toBe(true);
    expect(untouched.paused).toBe(false);

    // Each mount holds ONLY its own event, checked by asking each one for the other's.
    //
    // The previous version of this counted rows in the host's `orders` table, which has
    // nothing to do with either mount and is invariant under every event-isolation defect
    // there is — the comment claimed event isolation and the assertion checked that one
    // `place` inserted one order. Verification found it, and it is the third fixture on this
    // component that asserted something true and unrelated.
    const order = await t.run(async (ctx) => ctx.db.query("orders").first());

    const productSeesOwn = await t.query(components.productEvents.lib.getStatus, {
      datasource: "orders",
      eventId: order!._id,
    });
    const productSeesAudit = await t.query(components.productEvents.lib.getStatus, {
      datasource: "audit",
      eventId: order!._id,
    });
    const auditSeesOwn = await t.query(components.auditEvents.lib.getStatus, {
      datasource: "audit",
      eventId: order!._id,
    });
    const auditSeesProduct = await t.query(components.auditEvents.lib.getStatus, {
      datasource: "orders",
      eventId: order!._id,
    });

    // Both halves matter. Only the "sees own" pair would pass for a component whose mounts
    // share one table; only the "sees other" pair would pass for one that stores nothing.
    expect(productSeesOwn).not.toBeNull();
    expect(auditSeesOwn).not.toBeNull();
    expect(productSeesAudit).toBeNull();
    expect(auditSeesProduct).toBeNull();
  });

  it("accepts the same identity in both instances, and rejects a conflict within one", async () => {
    const fetchSpy = acceptEverything();
    const t = setup();
    await t.mutation(api.orders.place, { sku: "SKU-4", quantity: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const order = await t.run(async (ctx) => ctx.db.query("orders").first());

    // The same `eventId` lives independently in both mounts — that is what "isolated" means
    // for identity, and it is why a host can use its own row id as the event id in every
    // stream without coordinating between them.
    for (const name of ["productEvents", "auditEvents"] as const) {
      const status = await t.query(components[name].lib.getStatus, {
        datasource: name === "productEvents" ? "orders" : "audit",
        eventId: order!._id,
      });
      expect(status).not.toBeNull();
    }

    // Re-enqueuing the same identity with a DIFFERENT payload inside one instance is a
    // conflict, not a silent overwrite.
    const conflict = await t
      .mutation(components.productEvents.lib.enqueue, {
        datasource: "orders",
        eventId: order!._id,
        payload: { order_id: order!._id, sku: "CHANGED", quantity: 99 },
      })
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    // A string by construction, so the assertion cannot pass on an object's default
    // stringification if the rejection shape ever changes.
    expect(conflict).toContain("identity_conflict");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("accepts an identical datasource and event id independently in both mounts", async () => {
    const fetchSpy = acceptEverything();
    const t = setup();
    const identity = { datasource: "shared_events", eventId: "same-event" };

    for (const name of ["productEvents", "auditEvents"] as const) {
      await expect(
        t.mutation(components[name].lib.enqueue, {
          ...identity,
          payload: { stream: name },
        }),
      ).resolves.toMatchObject({ outcome: "enqueued" });
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    for (const name of ["productEvents", "auditEvents"] as const) {
      expect(await t.query(components[name].lib.getStatus, identity)).toMatchObject({
        state: "delivered",
      });
    }
  });

  it("replays a dead letter after the destination recovers", async () => {
    // Rejected permanently, then replayed once the destination is healthy — the operator path
    // a consumer actually needs, exercised through the mounted instance rather than the
    // component's own tests.
    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse(400, { error: "bad request" }))
      .mockImplementation(() => jsonResponse(200, accepted));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();

    await t.mutation(api.orders.place, { sku: "SKU-5", quantity: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const order = await t.run(async (ctx) => ctx.db.query("orders").first());
    const failed = await t.query(api.orders.deliveryStatus, { orderId: order!._id });
    expect(failed).toMatchObject({ state: "failed" });

    const replayed = await t.mutation(components.productEvents.lib.replayFailed, {
      actor: "operator",
    });
    expect(replayed.replayed).toBe(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.orders.deliveryStatus, { orderId: order!._id })).toMatchObject({
      state: "delivered",
    });
  });

  it("runs the host's maintenance job against BOTH streams, not just the first", async () => {
    // The previous version asserted only `resolves.toBeNull()`, which an empty `maintain()`
    // satisfies — measured, along with four other mutants including "iterate productEvents
    // alone". The reason every one of them lived is that the fixture gave the job NOTHING TO
    // DO: delivered rows are kept for seven days, so a row delivered a moment ago is not
    // eligible for the sweep and a cleanup that ran correctly and a cleanup that never ran are
    // indistinguishable. Moving the clock past retention is what turns this into a test.
    acceptEverything();
    const t = setup();
    await t.mutation(api.orders.place, { sku: "SKU-7", quantity: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const order = await t.run(async (ctx) => await ctx.db.query("orders").first());
    const stillThere = async (name: "productEvents" | "auditEvents") =>
      (await t.query(components[name].lib.getStatus, {
        datasource: name === "productEvents" ? "orders" : "audit",
        eventId: order!._id,
      })) !== null;

    // The precondition is asserted, not assumed: a sweep that removes nothing looks identical
    // to a fixture that had nothing to remove.
    expect(await stillThere("productEvents")).toBe(true);
    expect(await stillThere("auditEvents")).toBe(true);

    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    await expect(t.mutation(internal.maintenance.maintain, {})).resolves.toBeNull();

    expect(await stillThere("productEvents")).toBe(false);
    expect(await stillThere("auditEvents")).toBe(false);
  });

  it("commits bounded cleanup progress with hundreds of large retained payloads", async () => {
    acceptEverything();
    const t = setup();
    for (let i = 0; i < 400; i += 1) {
      await t.mutation(components.productEvents.lib.enqueue, {
        datasource: "large_events",
        eventId: `large-${i}`,
        payload: { body: "x".repeat(60 * 1024) },
      });
      if (i % 50 === 49) await t.finishAllScheduledFunctions(vi.runAllTimers);
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const status = (eventId: string) =>
      t.query(components.productEvents.lib.getStatus, {
        datasource: "large_events",
        eventId,
      });
    expect(await status("large-0")).toMatchObject({ state: "delivered" });
    await t.mutation(internal.maintenance.maintain, {});
    expect(await status("large-0")).toBeNull();
    expect(await status("large-399")).toMatchObject({ state: "delivered" });
    for (let pass = 0; pass < 20; pass += 1) {
      await t.mutation(internal.maintenance.maintain, {});
    }
    expect(await status("large-399")).toBeNull();
  }, 30000);

  it("reports each stream separately through the host's own health wrapper", async () => {
    // `api.orders.health` is the operator-facing surface and had no coverage at all: a wrapper
    // returning `productEvents.health()` for BOTH keys passed the whole suite, because the
    // isolation test reads `components[name].lib.health` and bypasses the wrapper entirely.
    // Pausing exactly one mount is what makes the two keys have to differ.
    acceptEverything();
    const t = setup();
    await t.mutation(components.auditEvents.lib.pause, { actor: "operator" });
    await t.mutation(api.orders.place, { sku: "SKU-8", quantity: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const health = await t.query(api.orders.health, {});
    expect(health.product).toMatchObject({ paused: false });
    expect(health.audit).toMatchObject({ paused: true });
    // `delivered` is deliberately not a health count, so the paused stream's BACKLOG is what
    // distinguishes the two keys: the audit event never left `pending`, the product one did.
    expect(health.audit.counts.pending.count).toBe(1);
    expect(health.product.counts.pending.count).toBe(0);
  });
});
