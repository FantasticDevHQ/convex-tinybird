import { api } from "./_generated/api";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./contract";
import {
  codeOf,
  drain,
  enqueueOne,
  enqueueWithRetry,
  installComponentTestHooks,
  jsonResponse,
  row,
  settingsOf,
  setup,
  statusOf,
} from "../testing/fixtures";

installComponentTestHooks();

describe("an invalid host", () => {
  it.each([
    ["plain http to a real host", "http://api.tinybird.co"],
    ["a host with a path", "https://api.tinybird.co/v0"],
    ["embedded credentials", "https://user:pass@api.tinybird.co"],
    ["a value that is not a URL", "not a url"],
  ])("pauses the destination on %s instead of dead-lettering the event", async (_l, host) => {
    // The row is fine; the configuration is not. Failing the event would destroy good data
    // for an operator's typo, and would do it once per event in the backlog.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("TINYBIRD_HOST", host);
    const t = setup();

    await enqueueOne(t);
    await drain(t);

    expect(fetchSpy).not.toHaveBeenCalled();
    // `attempts: 0` is the load-bearing half: resolving the host after claiming the event
    // would still leave it pending, but would burn an attempt per event in the backlog for
    // a configuration fault that never reached the network.
    expect(await statusOf(t)).toMatchObject({ state: "pending", attempts: 0 });
    expect(await t.query(api.lib.health, {})).toMatchObject({
      paused: true,
      pausedReason: "invalid_host",
    });
  });

  it("never puts the configured host into a stored error", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("TINYBIRD_HOST", "https://user:p.secret-token@api.tinybird.co");
    const t = setup();

    await enqueueOne(t);
    await drain(t);

    const stored = JSON.stringify([await statusOf(t), await settingsOf(t)]);
    expect(stored).not.toContain("p.secret-token");
  });
});

describe("the request is constrained", () => {
  it("refuses a redirect rather than following it to another host", async () => {
    // `redirect: "error"` is what stops the Authorization header being replayed somewhere
    // else. fetch surfaces the refusal as a TypeError, which is a transport failure.
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError("unexpected redirect"));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await enqueueWithRetry(t, 1);
    await drain(t);

    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1].redirect).toBe("error");
    expect(await statusOf(t)).toMatchObject({ state: "failed" });
  });

  it("uses the configured request deadline rather than waiting forever", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 }));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await enqueueOne(t);
    await drain(t);

    const init = (fetchSpy.mock.calls[0] as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("the token cannot escape", () => {
  it("stays out of every stored row and query result, however it is provoked", async () => {
    const token = "p.append-token-9f3a";
    const bodyMarker = "corge-body-marker-41c2";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(400, { error: `${bodyMarker} ${token}` })),
    );
    const t = setup(token);

    // The datasource name is host-chosen, so plant the token there too: if anything echoes
    // an identifier into an error, this catches it.
    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: `evt_${token}`,
      payload: { ...row, note: token },
    });
    await drain(t);

    const rows = await t.run(async (ctx) => ({
      events: await ctx.db.query("events").take(10),
      settings: await ctx.db.query("settings").take(10),
    }));
    const status = await t.query(api.lib.getStatus, {
      datasource: "events",
      eventId: `evt_${token}`,
    });
    const health = await t.query(api.lib.health, {});

    // The payload and the event id are the host's own data and legitimately contain what
    // the host put there. Errors, settings and health must not.
    const errorSurfaces = JSON.stringify([
      rows.events.map((e) => ({ lastError: e.lastError, previousErrors: e.previousErrors })),
      rows.settings,
      status?.lastError,
      health,
    ]);
    expect(errorSurfaces).not.toContain(token);
    expect(errorSurfaces).not.toContain(bodyMarker);
  });
});

describe("the request deadline", () => {
  it("stores the caller's deadline so delivery honours it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
    const t = setup();

    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: row,
      requestTimeoutMs: 2_000,
    });

    // An option the client validates but never sends would be a silent no-op, so the value
    // has to reach the row that delivery reads.
    const stored = await t.run(async (ctx) => (await ctx.db.query("events").first())!);
    expect((stored as { requestTimeoutMs?: number }).requestTimeoutMs).toBe(2_000);
  });

  it("arms the abort signal with the caller's deadline, not the default", async () => {
    // Storing the value is not using it. Watching the timer being armed is the only way to
    // see the difference, because an AbortSignal does not report the deadline it was given.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
    const t = setup();

    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: row,
      requestTimeoutMs: 2_000,
    });
    await drain(t);

    expect(timeout).toHaveBeenCalledWith(2_000);
    timeout.mockRestore();
  });

  it("falls back to the documented default when the caller sets none", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 })),
    );
    const t = setup();

    await enqueueOne(t);
    await drain(t);

    expect(timeout).toHaveBeenCalledWith(DEFAULT_REQUEST_TIMEOUT_MS);
    timeout.mockRestore();
  });

  it.each([999, 60_001, Number.NaN])("rejects a deadline of %s before any write", async (value) => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup();

    expect(
      await codeOf(
        t.mutation(api.lib.enqueue, {
          datasource: "events",
          eventId: "evt_1",
          payload: row,
          requestTimeoutMs: value,
        }),
      ),
    ).toBe("invalid_request_timeout");
    expect(await t.run((ctx) => ctx.db.query("events").take(10))).toEqual([]);
  });
});
