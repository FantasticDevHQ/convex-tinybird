import { getFunctionName, makeFunctionReference } from "convex/server";

import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY,
  HARD_MAX_PAYLOAD_BYTES,
} from "../component/contract";
import { type RunMutationCtx, type RunQueryCtx, TinybirdDelivery } from "./index";

/** A stand-in for `components.tinybird`; only the shape the client touches. */
const component = {
  lib: {
    health: makeFunctionReference<"query">("lib:health"),
    enqueue: makeFunctionReference<"mutation">("lib:enqueue"),
  },
} as never;

describe("TinybirdDelivery options", () => {
  it("accepts an empty options object and applies the documented defaults", () => {
    const delivery = new TinybirdDelivery(component, {});

    expect(delivery.options).toEqual({
      maxPayloadBytes: 65536,
      requestTimeoutMs: 15000,
      retry: { maxAttempts: 8, initialBackoffMs: 1000, base: 2 },
    });
  });

  it("rejects a payload bound of zero or above the hard cap", () => {
    expect(() => new TinybirdDelivery(component, { maxPayloadBytes: 0 })).toThrow(
      /maxPayloadBytes/,
    );
    expect(
      () => new TinybirdDelivery(component, { maxPayloadBytes: HARD_MAX_PAYLOAD_BYTES + 1 }),
    ).toThrow(/maxPayloadBytes/);
  });

  it("rejects a request timeout outside 1s–60s", () => {
    expect(() => new TinybirdDelivery(component, { requestTimeoutMs: 999 })).toThrow(
      /requestTimeoutMs/,
    );
    expect(() => new TinybirdDelivery(component, { requestTimeoutMs: 60001 })).toThrow(
      /requestTimeoutMs/,
    );
  });

  it("rejects an option it does not support, so configuration is always explicit", () => {
    expect(
      () => new TinybirdDelivery(component, { batchSize: 10 } as unknown as Record<string, never>),
    ).toThrow(/unsupported option "batchSize"/);
  });

  it("rejects retry settings outside their documented ranges", () => {
    expect(() => new TinybirdDelivery(component, { retry: { maxAttempts: 0 } })).toThrow(
      /maxAttempts/,
    );
    expect(() => new TinybirdDelivery(component, { retry: { initialBackoffMs: 50 } })).toThrow(
      /initialBackoffMs/,
    );
    expect(() => new TinybirdDelivery(component, { retry: { base: 5 } })).toThrow(/base/);
  });
});

describe("TinybirdDelivery.health", () => {
  it("runs the component's health query through the caller's context", async () => {
    type Reference = Parameters<RunQueryCtx["runQuery"]>[0];
    const calls: Array<{ reference: Reference; args: unknown }> = [];
    const ctx: RunQueryCtx = {
      runQuery: ((reference: Reference, args: unknown) => {
        calls.push({ reference, args });
        return Promise.resolve({ configured: false, paused: false });
      }) as unknown as RunQueryCtx["runQuery"],
    };
    const delivery = new TinybirdDelivery(component, {});

    const result = await delivery.health(ctx);

    expect(result).toEqual({ configured: false, paused: false });
    expect(calls).toHaveLength(1);
    expect(getFunctionName(calls[0].reference)).toBe("lib:health");
    expect(calls[0].args).toEqual({});
  });
});

describe("TinybirdDelivery.enqueue", () => {
  type Reference = Parameters<RunMutationCtx["runMutation"]>[0];

  /** Captures what the client actually sends to the component. */
  function capturing() {
    const calls: Array<{ reference: Reference; args: Record<string, unknown> }> = [];
    const ctx: RunMutationCtx = {
      runMutation: ((reference: Reference, args: Record<string, unknown>) => {
        calls.push({ reference, args });
        return Promise.resolve({ outcome: "enqueued", eventId: "evt_1", state: "pending" });
      }) as unknown as RunMutationCtx["runMutation"],
    };
    return { calls, ctx };
  }

  const event = { datasource: "events", eventId: "evt_1", payload: { a: 1 } };

  it("sends the shipped default policy when the caller sets none", async () => {
    const { calls, ctx } = capturing();

    await new TinybirdDelivery(component, {}).enqueue(ctx, event);

    expect(calls[0].args.retry).toEqual(DEFAULT_RETRY);
    expect(calls[0].args.maxPayloadBytes).toBe(DEFAULT_MAX_PAYLOAD_BYTES);
    // An option the client validates but never sends is a silent no-op. The component
    // honours this one, so the only thing left to prove is that it arrives.
    expect(calls[0].args.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it("sends a configured request deadline rather than the default", async () => {
    const { calls, ctx } = capturing();

    await new TinybirdDelivery(component, { requestTimeoutMs: 3_000 }).enqueue(ctx, event);

    expect(calls[0].args.requestTimeoutMs).toBe(3_000);
  });

  it("sends the instance policy when one is configured", async () => {
    const { calls, ctx } = capturing();
    const delivery = new TinybirdDelivery(component, { retry: { maxAttempts: 2 } });

    await delivery.enqueue(ctx, event);

    // The instance overrides only what it names; the rest stays at the documented default.
    expect(calls[0].args.retry).toEqual({ ...DEFAULT_RETRY, maxAttempts: 2 });
  });

  it("lets a single call override the instance policy without changing it", async () => {
    const { calls, ctx } = capturing();
    const delivery = new TinybirdDelivery(component, { retry: { maxAttempts: 2 } });

    await delivery.enqueue(ctx, { ...event, retry: { maxAttempts: 5 } });
    await delivery.enqueue(ctx, event);

    expect(calls[0].args.retry).toEqual({ ...DEFAULT_RETRY, maxAttempts: 5 });
    // The next call is unaffected: a per-call override must not mutate the instance.
    expect(calls[1].args.retry).toEqual({ ...DEFAULT_RETRY, maxAttempts: 2 });
  });
});
