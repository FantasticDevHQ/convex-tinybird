import { convexTest } from "convex-test";
import workpool from "@convex-dev/workpool/test";

import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const row = { event_id: "evt_1", kind: "order_created" };

/** A component instance with the nested pool registered, as a host mount would have. */
function setup(token = "p.token") {
  vi.stubEnv("TINYBIRD_TOKEN", token);
  const t = convexTest(schema, modules);
  workpool.register(t, "workpool");
  return t;
}

/** Runs the scheduled delivery to completion. */
async function drain(t: ReturnType<typeof convexTest>) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

function jsonResponse(status: number, body: unknown) {
  return new Response(body === null ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function enqueueOne(t: ReturnType<typeof convexTest>) {
  return t.mutation(api.lib.enqueue, { datasource: "events", eventId: "evt_1", payload: row });
}

async function statusOf(t: ReturnType<typeof convexTest>) {
  return t.query(api.lib.getStatus, { datasource: "events", eventId: "evt_1" });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("scheduling", () => {
  it("schedules exactly one delivery for a new event when configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
    const t = setup();

    await enqueueOne(t);
    await drain(t);

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("does not schedule a second delivery for a duplicate enqueue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
    const t = setup();

    await enqueueOne(t);
    await enqueueOne(t);
    await drain(t);

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("schedules nothing and sends nothing while unconfigured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup("");

    await enqueueOne(t);
    await drain(t);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await statusOf(t)).toMatchObject({ state: "pending" });
  });
});

describe("the request", () => {
  it("posts one NDJSON line to the events endpoint with a bearer token", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { successful_rows: 1, quarantined_rows: 0 }));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup("p.append-token");

    await enqueueOne(t);
    await drain(t);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.tinybird.co/v0/events?name=events&wait=true");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer p.append-token");
    expect(new Headers(init.headers).get("content-type")).toBe("application/x-ndjson");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // One canonical row, newline-terminated, and nothing else.
    expect(init.body).toBe('{"event_id":"evt_1","kind":"order_created"}\n');
  });

  it("uses the configured host instead of the default", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 }));
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("TINYBIRD_HOST", "https://api.eu-central-1.aws.tinybird.co");
    const t = setup();

    await enqueueOne(t);
    await drain(t);

    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe(
      "https://api.eu-central-1.aws.tinybird.co/v0/events?name=events&wait=true",
    );
  });
});

describe("outcomes", () => {
  it("marks the event delivered and stamps deliveredAt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
    const t = setup();

    await enqueueOne(t);
    await drain(t);

    const status = await statusOf(t);
    expect(status).toMatchObject({ state: "delivered", attempts: 1 });
    expect(status?.deliveredAt).toEqual(expect.any(Number));
    expect(await t.query(api.lib.health, {})).toMatchObject({ paused: false });
  });

  it.each([
    ["quarantined rows", 200, { successful_rows: 0, quarantined_rows: 1 }, "quarantined"],
    ["a bad request", 400, null, "invalid_request"],
    ["an unknown datasource", 404, null, "not_found"],
    ["an oversized payload", 413, null, "payload_too_large"],
    ["a materialized view error", 422, null, "invalid_request"],
  ])("fails terminally on %s without retrying", async (_label, status, body, category) => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(status, body));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();

    await enqueueOne(t);
    await drain(t);

    expect(await statusOf(t)).toMatchObject({ state: "failed", lastError: { category } });
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  it("records a sanitized error that never carries the token or the body", async () => {
    // The marker exists only in the response body, so finding it in the stored message
    // could only mean the body was echoed. A word the component might legitimately use
    // (say "rejected") would not discriminate.
    const bodyOnlyMarker = "quux-body-marker-9f3a";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse(400, { error: `${bodyOnlyMarker} token p.append-token` })),
    );
    const t = setup("p.append-token");

    await enqueueOne(t);
    await drain(t);

    const message = (await statusOf(t))?.lastError?.message ?? "";
    expect(message).not.toContain("p.append-token");
    expect(message).not.toContain(bodyOnlyMarker);
    expect(message.length).toBeLessThanOrEqual(200);
  });

  it("fails the event when Tinybird returns a status this layer does not handle", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, null)));
    const t = setup();

    await enqueueOne(t);
    await drain(t);

    expect(await statusOf(t)).toMatchObject({
      state: "failed",
      lastError: { category: "exhausted" },
    });
  });
});

describe("terminal states are final", () => {
  it("ignores a late delivered acknowledgement for an already failed event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, null)));
    const t = setup();
    await enqueueOne(t);
    await drain(t);
    const before = await statusOf(t);
    expect(before).toMatchObject({ state: "failed" });

    const eventId = await t.run(async (ctx) => (await ctx.db.query("events").first())!._id);
    await t.mutation(internal.lib.markDelivered, { eventId });

    expect(await statusOf(t)).toMatchObject({ state: "failed" });
    expect((await statusOf(t))?.deliveredAt).toBeUndefined();
  });

  it("ignores a late failure for an already delivered event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
    const t = setup();
    await enqueueOne(t);
    await drain(t);

    const eventId = await t.run(async (ctx) => (await ctx.db.query("events").first())!._id);
    await t.mutation(internal.lib.markFailed, {
      eventId,
      error: { category: "invalid_request", message: "late", at: Date.now() },
    });

    expect(await statusOf(t)).toMatchObject({ state: "delivered" });
  });
});
