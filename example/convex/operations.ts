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
/** Both signals an operator dashboard polls: the cheap one and the counted one. */
export const operatorHeartbeat = query({
  args: {},
  returns: v.object({ heartbeat: v.any(), health: v.any() }),
  handler: async (ctx) => ({
    heartbeat: await productEvents.heartbeat(ctx),
    health: await productEvents.health(ctx),
  }),
});

export const operatorPause = mutation({
  args: { actor: v.string() },
  returns: v.any(),
  // A real host authorizes `actor` before this line.
  handler: async (ctx, { actor }) => productEvents.pause(ctx, { actor }),
});

/**
 * Unpause, and keep requeueing until nothing is left waiting.
 *
 * `resume` unpauses and requeues one batch, so a single call leaves a large backlog partly
 * scheduled. Looping is what an operator actually wants after an outage.
 */
export const operatorResume = mutation({
  args: { actor: v.string() },
  returns: v.object({ requeued: v.number() }),
  handler: async (ctx, { actor }) => {
    let requeued = 0;
    let pass = 0;
    do {
      const result = await productEvents.resume(ctx, { actor });
      requeued += result.requeued;
      if (result.requeued === 0) break;
      pass += 1;
    } while (pass < 10);
    return { requeued };
  },
});

/**
 * Replay every dead letter, bounded. Used after a destination outage is over.
 *
 * LOOPED, because one call replays one batch. The guide shows this shape and verification
 * pointed out that an unlooped example makes the documented loop the one thing not compiled —
 * which is the half of the sample most likely to be wrong when copied.
 */
export const operatorReplayFailed = mutation({
  args: { actor: v.string() },
  returns: v.object({ replayed: v.number() }),
  handler: async (ctx, { actor }) => {
    let replayed = 0;
    for (let pass = 0; pass < 10; pass += 1) {
      const result = await productEvents.replayFailed(ctx, { actor });
      replayed += result.replayed;
      if (!result.remaining) break;
    }
    return { replayed };
  },
});

/** Replay one dead letter by its identity, for the case an operator investigated by hand. */
export const operatorReplayEvent = mutation({
  args: { orderId: v.id("orders"), actor: v.string() },
  returns: v.any(),
  handler: async (ctx, { orderId, actor }) =>
    productEvents.replayEvent(ctx, { datasource: "orders", eventId: orderId, actor }),
});
