import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Deliberately unrelated to analytics.
 *
 * The component must not require anything of the host's schema, so the example's schema is an
 * ordinary orders table with no event, delivery or Tinybird concept in it. If adopting the
 * component ever forces a column into a table like this one, that is a defect.
 */
export default defineSchema({
  // Host-owned progress for its bounded maintenance job, separate from domain data.
  maintenanceCursors: defineTable({
    stream: v.string(),
    cursor: v.union(
      v.null(),
      v.object({
        delivering: v.union(
          v.null(),
          v.object({ updatedAt: v.number(), creationTime: v.number() }),
        ),
        pending: v.union(v.null(), v.object({ updatedAt: v.number(), creationTime: v.number() })),
      }),
    ),
  }).index("by_stream", ["stream"]),
  orders: defineTable({
    sku: v.string(),
    quantity: v.number(),
    placedAt: v.number(),
  }).index("by_sku", ["sku"]),
});
