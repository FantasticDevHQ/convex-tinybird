import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reports an unconfigured, unpaused component with zero bounded counts", async () => {
    vi.stubEnv("TINYBIRD_TOKEN", "");
    const t = convexTest(schema, modules);

    const health = await t.query(api.lib.health, {});

    expect(health).toEqual({
      configured: false,
      paused: false,
      counts: {
        pending: { count: 0, capped: false },
        delivering: { count: 0, capped: false },
        failed: { count: 0, capped: false },
      },
    });
  });

  it("reports configured once the append token is present", async () => {
    vi.stubEnv("TINYBIRD_TOKEN", "p.append-token");
    const t = convexTest(schema, modules);

    const health = await t.query(api.lib.health, {});

    expect(health.configured).toBe(true);
  });

  it("schedules nothing and touches the network for nothing while unconfigured", async () => {
    vi.stubEnv("TINYBIRD_TOKEN", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);

    await t.query(api.lib.health, {});
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(10));

    expect(scheduled).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats a blank token as absent", async () => {
    vi.stubEnv("TINYBIRD_TOKEN", "   ");
    const t = convexTest(schema, modules);

    expect((await t.query(api.lib.health, {})).configured).toBe(false);
  });
});

const row = { event_id: "evt_1", kind: "order_created", total: 12.5 };

function unconfigured() {
  vi.stubEnv("TINYBIRD_TOKEN", "");
  return convexTest(schema, modules);
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConvexError) return (error.data as { code?: string }).code;
    throw error;
  }
  return undefined;
}

describe("enqueue", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores a pending row with the canonical payload and returns enqueued", async () => {
    const t = unconfigured();

    const result = await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: { total: 12.5, kind: "order_created", event_id: "evt_1" },
    });

    expect(result).toEqual({ outcome: "enqueued", eventId: "evt_1", state: "pending" });
    const stored = await t.run((ctx) => ctx.db.query("events").take(10));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      datasource: "events",
      eventId: "evt_1",
      state: "pending",
      attempts: 0,
      payload: '{"event_id":"evt_1","kind":"order_created","total":12.5}',
      payloadBytes: 56,
    });
  });

  it("returns duplicate for the same identity and an equivalent payload in another key order", async () => {
    const t = unconfigured();
    await t.mutation(api.lib.enqueue, { datasource: "events", eventId: "evt_1", payload: row });

    const again = await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: { total: 12.5, kind: "order_created", event_id: "evt_1" },
    });

    expect(again).toEqual({ outcome: "duplicate", eventId: "evt_1", state: "pending" });
    expect(await t.run((ctx) => ctx.db.query("events").take(10))).toHaveLength(1);
  });

  it("throws identity_conflict for the same identity with a different payload and leaves the row untouched", async () => {
    const t = unconfigured();
    await t.mutation(api.lib.enqueue, { datasource: "events", eventId: "evt_1", payload: row });

    const code = await codeOf(
      t.mutation(api.lib.enqueue, {
        datasource: "events",
        eventId: "evt_1",
        payload: { ...row, total: 99 },
      }),
    );

    expect(code).toBe("identity_conflict");
    const stored = await t.run((ctx) => ctx.db.query("events").take(10));
    expect(stored).toHaveLength(1);
    expect(stored[0].payload).toContain('"total":12.5');
  });

  it("keeps identities separate per datasource", async () => {
    const t = unconfigured();
    await t.mutation(api.lib.enqueue, { datasource: "events", eventId: "evt_1", payload: row });

    const other = await t.mutation(api.lib.enqueue, {
      datasource: "audit",
      eventId: "evt_1",
      payload: { ...row, total: 99 },
    });

    expect(other.outcome).toBe("enqueued");
    expect(await t.run((ctx) => ctx.db.query("events").take(10))).toHaveLength(2);
  });

  it.each([
    ["invalid_datasource", { datasource: "bad-name!", eventId: "evt_1", payload: row }],
    ["invalid_datasource", { datasource: "", eventId: "evt_1", payload: row }],
    ["invalid_event_id", { datasource: "events", eventId: "   ", payload: row }],
    ["invalid_event_id", { datasource: "events", eventId: "x".repeat(257), payload: row }],
    ["invalid_payload", { datasource: "events", eventId: "evt_1", payload: "not an object" }],
    ["invalid_payload", { datasource: "events", eventId: "evt_1", payload: { a: Number.NaN } }],
    [
      "payload_too_large",
      { datasource: "events", eventId: "evt_1", payload: { blob: "x".repeat(70_000) } },
    ],
    [
      "payload_too_large",
      {
        datasource: "events",
        eventId: "evt_1",
        payload: { blob: "x".repeat(2_000) },
        maxPayloadBytes: 1_000,
      },
    ],
  ])("rejects %s before any write", async (expected, args) => {
    const t = unconfigured();

    expect(await codeOf(t.mutation(api.lib.enqueue, args as never))).toBe(expected);
    expect(await t.run((ctx) => ctx.db.query("events").take(10))).toEqual([]);
  });

  it("never lets a host raise the payload bound above the hard cap", async () => {
    const t = unconfigured();

    const code = await codeOf(
      t.mutation(api.lib.enqueue, {
        datasource: "events",
        eventId: "evt_1",
        payload: { blob: "x".repeat(600_000) },
        maxPayloadBytes: 10_000_000,
      }),
    );

    expect(code).toBe("payload_too_large");
  });

  it("validates a per-call retry policy against the documented ranges", async () => {
    const t = unconfigured();

    const code = await codeOf(
      t.mutation(api.lib.enqueue, {
        datasource: "events",
        eventId: "evt_1",
        payload: row,
        retry: { maxAttempts: 0, initialBackoffMs: 1000, base: 2 },
      }),
    );

    expect(code).toBe("invalid_retry");
    expect(await t.run((ctx) => ctx.db.query("events").take(10))).toEqual([]);
  });

  it("schedules nothing and calls no fetch while unconfigured, even after an enqueue", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const t = unconfigured();

    await t.mutation(api.lib.enqueue, { datasource: "events", eventId: "evt_1", payload: row });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(10));

    expect(scheduled).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await t.query(api.lib.health, {})).counts.pending).toEqual({ count: 1, capped: false });
  });
});

describe("getStatus", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null for an unknown identity", async () => {
    const t = unconfigured();

    expect(await t.query(api.lib.getStatus, { datasource: "events", eventId: "nope" })).toBeNull();
  });

  it("returns the row's state without its payload", async () => {
    const t = unconfigured();
    await t.mutation(api.lib.enqueue, { datasource: "events", eventId: "evt_1", payload: row });

    const status = await t.query(api.lib.getStatus, { datasource: "events", eventId: "evt_1" });

    expect(status).toMatchObject({
      datasource: "events",
      eventId: "evt_1",
      state: "pending",
      attempts: 0,
    });
    expect(status && "payload" in status).toBe(false);
  });
});
