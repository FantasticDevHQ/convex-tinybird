import { v } from "convex/values";
import { boundedBatch, vEventIdentity } from "./contract.js";
import { internalMutation } from "./_generated/server.js";

/** Upgrade existing mounts before using category-filtered replay. Safe to repeat. */
export const backfillErrorCategories = internalMutation({
  args: { limit: v.optional(v.number()), cursor: v.optional(v.union(vEventIdentity, v.null())) },
  returns: v.object({
    updated: v.number(),
    isDone: v.boolean(),
    continueCursor: v.union(vEventIdentity, v.null()),
  }),
  handler: async (ctx, { limit, cursor }) => {
    const batch = boundedBatch(limit, 100, 100);
    // Identity is immutable and unique within the mount; creation timestamps may tie.
    // Two ranges resume a composite cursor without filtering a page or losing its tail.
    const found = await ctx.db
      .query("events")
      .withIndex("by_identity", (q) =>
        cursor == null ? q : q.eq("datasource", cursor.datasource).gt("eventId", cursor.eventId),
      )
      .take(batch + 1);
    if (cursor != null && found.length < batch + 1) {
      found.push(
        ...(await ctx.db
          .query("events")
          .withIndex("by_identity", (q) => q.gt("datasource", cursor.datasource))
          .take(batch + 1 - found.length)),
      );
    }
    const selected = found.slice(0, batch);
    let updated = 0;
    for (const event of selected) {
      if (event.lastErrorCategory !== event.lastError?.category) {
        await ctx.db.patch(event._id, { lastErrorCategory: event.lastError?.category });
        updated++;
      }
    }
    const last = selected.at(-1);
    return {
      updated,
      isDone: found.length <= batch,
      continueCursor: last
        ? { datasource: last.datasource, eventId: last.eventId }
        : (cursor ?? null),
    };
  },
});
