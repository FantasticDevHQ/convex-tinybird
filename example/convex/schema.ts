import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Deliberately unrelated to analytics.
 *
 * The component must not require anything of the host's schema, so the example's schema is an
 * ordinary domain table with no event, delivery or Tinybird concept in it. If adopting the
 * component ever forces a column into a table like this one, that is a defect.
 */
export default defineSchema({
  orders: defineTable({
    sku: v.string(),
    quantity: v.number(),
    placedAt: v.number(),
  }).index("by_sku", ["sku"]),
});
