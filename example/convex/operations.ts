import { TinybirdDelivery, vFailureCategory } from "@fantastic-dev/convex-tinybird";
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
 * host's job. The example does not do it, because inventing an auth scheme here would obscure
 * the one thing it is demonstrating.
 *
 * Do not copy these verbatim. Every one of them pauses, replays or requeues a live delivery
 * stream, and as written any caller can invoke them. A real host opens each handler with its own
 * check and passes the identity it just established as `actor`, so the audit trail records who
 * actually did it rather than a string the caller chose:
 *
 * ```ts
 * const identity = await ctx.auth.getUserIdentity();
 * if (identity === null) throw new Error("unauthenticated");
 * await productEvents.pause(ctx, { actor: identity.subject });
 * ```
 *
 * That `ctx.auth` call is legal HERE and forbidden inside the component — the boundary gate
 * enforces exactly that split, and scans this app for imports only.
 */
/** Both signals an operator dashboard polls: the cheap one and the counted one. */
export const operatorHeartbeat = query({
  args: { datasource: v.optional(v.string()) },
  returns: v.object({ heartbeat: v.any(), health: v.any() }),
  handler: async (ctx, { datasource }) => ({
    heartbeat: await productEvents.heartbeat(ctx),
    health: await productEvents.health(ctx, { datasource }),
  }),
});

export const operatorPause = mutation({
  args: { datasource: v.optional(v.string()), actor: v.string() },
  returns: v.any(),
  // A real host authorizes `actor` before this line.
  handler: async (ctx, { actor, datasource }) => productEvents.pause(ctx, { actor, datasource }),
});

/**
 * Unpause, and keep requeueing until nothing is left waiting.
 *
 * `resume` unpauses and requeues one batch, so a single call leaves a large backlog partly
 * scheduled. Looping is what an operator actually wants after an outage.
 */
export const operatorResume = mutation({
  args: { datasource: v.optional(v.string()), actor: v.string() },
  returns: v.object({ requeued: v.number() }),
  handler: async (ctx, { actor, datasource }) => {
    let requeued = 0;
    let pass = 0;
    do {
      const result = await productEvents.resume(ctx, { actor, datasource });
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
  args: {
    datasource: v.optional(v.string()),
    actor: v.string(),
    category: v.optional(vFailureCategory),
  },
  returns: v.object({ replayed: v.number() }),
  handler: async (ctx, { actor, category, datasource }) => {
    let replayed = 0;
    for (let pass = 0; pass < 10; pass += 1) {
      const result = await productEvents.replayFailed(ctx, { actor, category, datasource });
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
