import { TinybirdDelivery } from "@fantastic.dev/convex-tinybird";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const streams = {
  productEvents: new TinybirdDelivery(components.productEvents),
  auditEvents: new TinybirdDelivery(components.auditEvents),
};

/**
 * One recovery page and one retention page per stream, per cron invocation.
 * Child mutations share this transaction's read budget, so do not loop over their pages.
 * Save unfinished recovery cursors: old but healthy work can occupy many consecutive pages.
 * Retention needs no cursor because each deleted row leaves its scan range.
 */
export const maintain = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (const [name, stream] of Object.entries(streams)) {
      const checkpoint = await ctx.db
        .query("maintenanceCursors")
        .withIndex("by_stream", (q) => q.eq("stream", name))
        .unique();
      const result = await stream.requeueStuck(ctx, {
        actor: "example cron",
        cursor: checkpoint?.cursor ?? undefined,
      });
      const cursor = result.remaining ? result.cursor : null;
      if (checkpoint) {
        await ctx.db.patch(checkpoint._id, { cursor });
      } else {
        await ctx.db.insert("maintenanceCursors", { stream: name, cursor });
      }
      await stream.cleanup(ctx, { actor: "example cron" });
    }
    return null;
  },
});
