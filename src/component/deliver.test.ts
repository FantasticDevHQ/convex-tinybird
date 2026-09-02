import { convexTest } from "convex-test";
import type { WorkId } from "@convex-dev/workpool";
import workpool from "@convex-dev/workpool/test";

import { api, internal } from "./_generated/api";
import { DEFAULT_RESUME_LIMIT, DEFAULT_RETRY, MAX_ERROR_HISTORY } from "./contract";
import type { Doc } from "./_generated/dataModel";
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

    const failed = await statusOf(t);
    expect(failed).toMatchObject({ state: "failed", lastError: { category: "exhausted" } });
    // `exhausted` alone cannot tell an operator whether the token was rejected or the
    // service was down, so the status has to survive into the stored message.
    expect(failed?.lastError?.message).toContain("503");
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

describe("a retried attempt", () => {
  it("re-claims the event on each attempt and dead-letters it once the budget is spent", async () => {
    // The shipped client always sends a retry policy, so this is the ordinary path, not an
    // exotic one. Without releasing the claim after a failed attempt the event would sit in
    // `delivering` forever: the pool re-runs the action, the row is no longer `pending`, the
    // claim is refused, the action reports success, and nothing ever dead-letters it.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(503, null));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();

    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: row,
      retry: { maxAttempts: 3, initialBackoffMs: 100, base: 2 },
    });
    await drain(t);

    expect(fetchSpy.mock.calls).toHaveLength(3);
    expect(await statusOf(t)).toMatchObject({
      state: "failed",
      attempts: 3,
      lastError: { category: "exhausted" },
    });
  });

  it("stops retrying as soon as an attempt succeeds", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, null))
      .mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 }));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();

    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: row,
      retry: { maxAttempts: 5, initialBackoffMs: 100, base: 2 },
    });
    await drain(t);

    expect(fetchSpy.mock.calls).toHaveLength(2);
    expect(await statusOf(t)).toMatchObject({ state: "delivered", attempts: 2 });
  });
});

describe("claiming an event", () => {
  it("refuses a second claim, so two workers cannot send the same row twice", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await enqueueOne(t);
    const eventId = await t.run(async (ctx) => (await ctx.db.query("events").first())!._id);

    expect(await t.mutation(internal.lib.markDelivering, { eventId })).toBe(true);
    expect(await t.mutation(internal.lib.markDelivering, { eventId })).toBe(false);

    // The refused claim must not have counted as an attempt.
    expect(await statusOf(t)).toMatchObject({ state: "delivering", attempts: 1 });
  });

  it("refuses to claim an event that already finished", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
    const t = setup();
    await enqueueOne(t);
    await drain(t);
    const eventId = await t.run(async (ctx) => (await ctx.db.query("events").first())!._id);

    expect(await t.mutation(internal.lib.markDelivering, { eventId })).toBe(false);
    expect(await statusOf(t)).toMatchObject({ state: "delivered", attempts: 1 });
  });
});

describe("the pool's verdict", () => {
  it("never dead-letters an event that was already delivered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
    const t = setup();
    await enqueueOne(t);
    await drain(t);
    const eventId = await t.run(async (ctx) => (await ctx.db.query("events").first())!._id);

    // A late failure verdict for work whose action already confirmed the write.
    await t.mutation(internal.lib.onDeliveryComplete, {
      workId: "late-work-id" as WorkId,
      context: { eventId },
      result: { kind: "failed", error: "pool gave up" },
    });

    expect(await statusOf(t)).toMatchObject({ state: "delivered" });
    expect((await statusOf(t))?.lastError).toBeUndefined();
  });

  it("returns a canceled event to the queue rather than losing it", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await enqueueOne(t);
    const eventId = await t.run(async (ctx) => (await ctx.db.query("events").first())!._id);
    await t.mutation(internal.lib.markDelivering, { eventId });

    await t.mutation(internal.lib.onDeliveryComplete, {
      workId: "canceled-work-id" as WorkId,
      context: { eventId },
      result: { kind: "canceled" },
    });

    expect(await statusOf(t)).toMatchObject({ state: "pending" });
  });
});

/** The single settings row, which mirrors the newest error for operators. */
async function settingsOf(t: ReturnType<typeof convexTest>): Promise<Doc<"settings"> | null> {
  return t.run(async (ctx) => {
    return (await ctx.db.query("settings").first()) as Doc<"settings"> | null;
  });
}

async function enqueueWithRetry(t: ReturnType<typeof convexTest>, maxAttempts: number) {
  return t.mutation(api.lib.enqueue, {
    datasource: "events",
    eventId: "evt_1",
    payload: row,
    retry: { maxAttempts, initialBackoffMs: 100, base: 2 },
  });
}

describe("a failed attempt is recorded", () => {
  it.each([
    ["a rate limit", 429, "rate_limited"],
    ["a server error", 503, "server_error"],
  ])(
    "records %s with its category while the event waits for the next attempt",
    async (_l, status, category) => {
      // One attempt only, so the event is observed mid-retry rather than after the budget.
      const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(status, null));
      vi.stubGlobal("fetch", fetchSpy);
      const t = setup();
      await enqueueWithRetry(t, 1);
      await drain(t);

      // maxAttempts 1 means the budget is spent immediately, so the row ends dead-lettered,
      // but the attempt's own category must survive into the operator-visible history.
      const status_ = await statusOf(t);
      expect(status_).toMatchObject({ attempts: 1 });
      expect(status_?.lastError?.message).toContain(String(status));
      expect((await settingsOf(t))?.lastError).toBeDefined();
      // The attempt's own category has to reach the history: once the budget is spent
      // `lastError` reads `exhausted`, so this is the only place it survives. Asserting
      // the table value itself, as this once did, tests nothing.
      expect(status_?.previousErrors?.map((e) => e.category)).toEqual([category]);
    },
  );

  it.each([
    ["a timeout", new DOMException("The operation was aborted", "TimeoutError"), "timeout"],
    ["a dropped connection", new TypeError("fetch failed"), "network"],
  ])("records %s under its own category while attempts remain", async (_l, rejection, category) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(rejection));
    const t = setup();
    await enqueueWithRetry(t, 3);
    await drain(t);

    // The budget is spent, so `lastError` reads `exhausted`; the attempt's own reason has
    // to survive in the history or an operator cannot tell a timeout from a refused token.
    const failed = await statusOf(t);
    expect(failed).toMatchObject({ state: "failed", attempts: 3 });
    expect(failed?.previousErrors?.map((e) => e.category)).toContain(category);
  });

  it("keeps the reason for an attempt that later succeeded", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new DOMException("aborted", "TimeoutError"))
        .mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
    const t = setup();
    await enqueueWithRetry(t, 3);
    await drain(t);

    const delivered = await statusOf(t);
    expect(delivered).toMatchObject({ state: "delivered", attempts: 2 });
    // Only one attempt failed, so there is nothing older to keep; the reason it failed
    // survives on the delivered row rather than being cleared by the success.
    expect(delivered?.previousErrors).toBeUndefined();
    expect(delivered?.lastError?.category).toBe("timeout");
  });

  it("leaves the event waiting, not dead, while the budget still has attempts left", async () => {
    // Two failures then a success: the middle state must have been pending, never failed,
    // which is what lets the pool pick it up again.
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, null))
      .mockResolvedValueOnce(jsonResponse(503, null))
      .mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 }));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await enqueueWithRetry(t, 5);
    await drain(t);

    expect(fetchSpy.mock.calls).toHaveLength(3);
    expect(await statusOf(t)).toMatchObject({ state: "delivered", attempts: 3 });
  });
});

describe("an exhausted budget", () => {
  it("dead-letters the event and mirrors the error for operators", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, null)));
    const t = setup();
    await enqueueWithRetry(t, 3);
    await drain(t);

    const final = await statusOf(t);
    expect(final).toMatchObject({
      state: "failed",
      attempts: 3,
      lastError: { category: "exhausted" },
    });
    const settings = await settingsOf(t);
    expect(settings?.lastError?.category).toBe("exhausted");
    // Nothing further is queued once the budget is spent.
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(20));
    expect(scheduled.filter((s) => s.state.kind === "pending")).toEqual([]);
  });

  it("makes a single attempt when no policy is stored at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, null)));
    const t = setup();
    // Calling the component directly with no `retry`: the absence of a policy, which is not
    // the same thing as the client's default. That default is covered below.
    await enqueueOne(t);
    await drain(t);

    expect(await statusOf(t)).toMatchObject({ state: "failed", attempts: 1 });
  });

  it("spends the shipped default policy and keeps a bounded history of the attempts", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(503, null));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    // DEFAULT_RETRY is what `TinybirdDelivery.enqueue` sends when a caller sets nothing, so
    // this is the policy every host gets by default.
    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: row,
      retry: DEFAULT_RETRY,
    });
    await drain(t);

    expect(fetchSpy.mock.calls).toHaveLength(DEFAULT_RETRY.maxAttempts);
    const final = await statusOf(t);
    expect(final).toMatchObject({
      state: "failed",
      attempts: DEFAULT_RETRY.maxAttempts,
      lastError: { category: "exhausted" },
    });
    // Eight attempts, five kept: the cap is what stops a permanently failing event from
    // growing its own row without bound.
    expect(final?.previousErrors).toHaveLength(MAX_ERROR_HISTORY);
  });
});

describe("stored errors never leak", () => {
  it("keeps the token, the response body and the query string out of every stored error", async () => {
    const bodyMarker = "grault-body-marker-77b1";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(503, { error: `${bodyMarker} p.append-token` })),
    );
    const t = setup("p.append-token");
    await enqueueWithRetry(t, 2);
    await drain(t);

    const serialized = JSON.stringify([await statusOf(t), await settingsOf(t)]);
    expect(serialized).not.toContain("p.append-token");
    expect(serialized).not.toContain(bodyMarker);
    expect(serialized).not.toContain("wait=true");
  });
});

describe("recording an attempt", () => {
  it.each([
    ["an event that is only queued", "", false],
    ["an event that already finished", "p.token", true],
  ])("refuses to record against %s", async (_label, token, deliverFirst) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
    const t = setup(token);
    await enqueueOne(t);
    if (deliverFirst) await drain(t);
    const before = await statusOf(t);
    const eventId = await t.run(async (ctx) => (await ctx.db.query("events").first())!._id);

    await t.mutation(internal.lib.markAttemptFailed, {
      eventId,
      error: { category: "server_error", message: "late attempt report", at: Date.now() },
    });

    // Only an in-flight event can have an attempt recorded against it; anything else would
    // resurrect a finished event or invent an attempt that never happened.
    const after = await statusOf(t);
    expect(after?.state).toBe(before?.state);
    expect(after?.attempts).toBe(before?.attempts);
    expect(after?.lastError?.message).not.toBe("late attempt report");
  });
});

describe("a refused token pauses the destination", () => {
  it.each([401, 403])("pauses on %i instead of spending the retry budget", async (status) => {
    // Retrying a wrong token cannot help, and doing so would dead-letter the whole backlog
    // one event at a time. Pausing keeps the events and stops the requests.
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(status, null));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: row,
      retry: { maxAttempts: 5, initialBackoffMs: 100, base: 2 },
    });
    await drain(t);

    // One request, not five: the budget is untouched.
    expect(fetchSpy.mock.calls).toHaveLength(1);
    expect(await statusOf(t)).toMatchObject({ state: "pending", attempts: 1 });
    expect(await t.query(api.lib.health, {})).toMatchObject({
      paused: true,
      pausedReason: "unauthorized",
    });
    // The event itself records why, so the reason survives on the row and not only on the
    // destination: `unauthorized`, never the server-error fallback.
    expect(await statusOf(t)).toMatchObject({ lastError: { category: "unauthorized" } });
  });

  it("stores but does not send events enqueued while paused", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(401, null));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await enqueueOne(t);
    await drain(t);
    expect(fetchSpy.mock.calls).toHaveLength(1);

    await t.mutation(api.lib.enqueue, { datasource: "events", eventId: "evt_2", payload: row });
    await drain(t);

    // Still one request in total: the second event was stored and left alone.
    expect(fetchSpy.mock.calls).toHaveLength(1);
    expect(
      await t.query(api.lib.getStatus, { datasource: "events", eventId: "evt_2" }),
    ).toMatchObject({ state: "pending", attempts: 0 });
  });
});

describe("resume", () => {
  it("clears the pause and drains the backlog in bounded batches", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, null))
      .mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 }));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();

    // One event trips the pause, then a backlog accumulates behind it.
    await enqueueOne(t);
    await drain(t);
    for (let i = 2; i <= 6; i += 1) {
      await t.mutation(api.lib.enqueue, {
        datasource: "events",
        eventId: `evt_${i}`,
        payload: { ...row, event_id: `evt_${i}` },
      });
    }
    expect((await t.query(api.lib.health, {})).counts.pending.count).toBe(6);

    const first = await t.mutation(api.lib.resume, { limit: 4, actor: "operator_1" });
    await drain(t);
    expect(first).toEqual({ paused: false, requeued: 4 });

    const second = await t.mutation(api.lib.resume, { limit: 4, actor: "operator_1" });
    await drain(t);
    expect(second).toEqual({ paused: false, requeued: 2 });

    const third = await t.mutation(api.lib.resume, { limit: 4, actor: "operator_1" });
    expect(third).toEqual({ paused: false, requeued: 0 });

    const health = await t.query(api.lib.health, {});
    expect(health).toMatchObject({ paused: false });
    expect(health.counts.pending.count).toBe(0);
  });

  it("records who paused and who resumed", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");

    await t.mutation(api.lib.pause, { reason: "operator", actor: "operator_1" });
    const paused = await settingsOf(t);
    expect(paused).toMatchObject({
      paused: true,
      pausedReason: "operator",
      lastOperatorAction: { kind: "pause", actor: "operator_1" },
    });

    await t.mutation(api.lib.resume, { actor: "operator_2" });
    expect(await settingsOf(t)).toMatchObject({
      paused: false,
      lastOperatorAction: { kind: "resume", actor: "operator_2" },
    });
  });

  it("is a no-op that reports honestly when nothing is paused or waiting", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup();

    expect(await t.mutation(api.lib.resume, {})).toEqual({ paused: false, requeued: 0 });
  });
});

describe("resume and live work", () => {
  it("does not requeue an event the pool is already working on", async () => {
    // The row is `pending` because an attempt is queued, not because it needs an operator.
    // Queueing a second work item for it would give the event two independent retry
    // budgets, which is how one event gets sent more times than its policy allows.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
    const t = setup();
    await enqueueOne(t);

    expect(await t.mutation(api.lib.resume, {})).toEqual({ paused: false, requeued: 0 });
  });

  it("never sends an event more times than its retry policy allows", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(503, null));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: row,
      retry: { maxAttempts: 2, initialBackoffMs: 100, base: 2 },
    });

    // An operator resuming while the pool is mid-retry must not add a second budget.
    await t.mutation(api.lib.resume, {});
    await drain(t);

    expect(fetchSpy.mock.calls).toHaveLength(2);
    expect(await statusOf(t)).toMatchObject({ state: "failed", attempts: 2 });
  });

  it("terminates the documented drain loop instead of requeueing the same rows forever", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, null)));
    const t = setup();
    await enqueueOne(t);
    await drain(t);
    for (const id of ["evt_2", "evt_3"]) {
      await t.mutation(api.lib.enqueue, {
        datasource: "events",
        eventId: id,
        payload: { ...row, event_id: id },
      });
    }

    // The README tells hosts to loop until `resume` reports nothing left. Run that loop
    // WITHOUT letting the pool run in between, which is the case where a resume that
    // ignored live work would report the same rows forever.
    const reported: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { requeued } = await t.mutation(api.lib.resume, { limit: 10 });
      reported.push(requeued);
      if (requeued === 0) break;
    }

    expect(reported).toEqual([3, 0]);
  });
});

describe("resume batch bounds", () => {
  /** Inserts rows straight into the table; the point here is the batch, not delivery. */
  async function seedPending(t: ReturnType<typeof convexTest>, count: number) {
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i += 1) {
        await ctx.db.insert("events", {
          datasource: "events",
          eventId: `seed_${i}`,
          payload: '{"seed":1}',
          payloadBytes: 11,
          state: "pending" as const,
          attempts: 0,
          createdAt: Date.now() + i,
          updatedAt: Date.now() + i,
        });
      }
    });
  }

  it("never requeues more than the documented maximum in one call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, null)));
    const t = setup();
    await seedPending(t, DEFAULT_RESUME_LIMIT + 5);

    // A host asking for more than the cap gets the cap, so one mutation cannot exceed
    // Convex's transaction limits however it is called.
    expect(await t.mutation(api.lib.resume, { limit: 10_000 })).toEqual({
      paused: false,
      requeued: DEFAULT_RESUME_LIMIT,
    });
  });

  it.each([0, -5])("treats a limit of %i as one rather than none or an error", async (limit) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, null)));
    const t = setup();
    await seedPending(t, 3);

    expect(await t.mutation(api.lib.resume, { limit })).toEqual({ paused: false, requeued: 1 });
  });
});

describe("marking a pause", () => {
  it.each([
    ["one that is only queued", false],
    ["one that already delivered", true],
  ])("does not rewrite the state of an event %s", async (_label, deliverFirst) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
    const t = setup(deliverFirst ? "p.token" : "");
    await enqueueOne(t);
    if (deliverFirst) await drain(t);
    const before = await statusOf(t);
    const eventId = await t.run(async (ctx) => (await ctx.db.query("events").first())!._id);

    await t.mutation(internal.lib.markPaused, {
      eventId,
      reason: "unauthorized",
      error: { category: "unauthorized", message: "refused", at: Date.now() },
    });

    // The destination pauses either way, but only an in-flight event goes back to the queue.
    const after = await statusOf(t);
    expect(after?.state).toBe(before?.state);
    expect((await t.query(api.lib.health, {})).paused).toBe(true);
  });
});
