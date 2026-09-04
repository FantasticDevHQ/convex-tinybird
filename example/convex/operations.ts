import { TinybirdDelivery } from "@fantastic-dev/convex-tinybird";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

const productEvents = new TinybirdDelivery(components.productEvents);

/**
 * The operator surface a host exposes, and the reason it lives in the example at all: every
 * operation the guide documents is compiled and tested here, so a sample in the README cannot
 * quietly outlive the method it describes.
 *
 * **These are unauthenticated on purpose, and that is the point.** The component authenticates
 * nobody — `actor` is an opaque string it records and never checks — so authorization is the
 * host's job. A real app puts its own check at the top of each of these. The example does not,
 * because inventing an auth scheme here would obscure the one thing it is demonstrating.
 */
export const operatorHeartbeat = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => productEvents.heartbeat(ctx),
});

export const operatorPause = mutation({
  args: { actor: v.string() },
  returns: v.any(),
  // A real host authorizes `actor` before this line.
  handler: async (ctx, { actor }) => productEvents.pause(ctx, { actor }),
});

export const operatorResume = mutation({
  args: { actor: v.string() },
  returns: v.any(),
  handler: async (ctx, { actor }) => productEvents.resume(ctx, { actor }),
});

/** Replay every dead letter, bounded. Used after a destination outage is over. */
export const operatorReplayFailed = mutation({
  args: { actor: v.string() },
  returns: v.any(),
  handler: async (ctx, { actor }) => productEvents.replayFailed(ctx, { actor }),
});

/** Replay one dead letter by its identity, for the case an operator investigated by hand. */
export const operatorReplayEvent = mutation({
  args: { orderId: v.id("orders"), actor: v.string() },
  returns: v.any(),
  handler: async (ctx, { orderId, actor }) =>
    productEvents.replayEvent(ctx, { datasource: "orders", eventId: orderId, actor }),
});
