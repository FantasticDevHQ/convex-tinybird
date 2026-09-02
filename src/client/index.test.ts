import { getFunctionName, makeFunctionReference } from "convex/server";

import { HARD_MAX_PAYLOAD_BYTES } from "../component/contract";
import { type RunQueryCtx, TinybirdDelivery } from "./index";

/** A stand-in for `components.tinybird`; only the shape the client touches. */
const component = {
  lib: {
    health: makeFunctionReference<"query">("lib:health"),
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
