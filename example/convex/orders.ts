import { TinybirdDelivery } from "@fantastic.dev/convex-tinybird";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

/**
 * One client per mount. Both are ordinary values — the component holds no global state, so a
 * host can construct as many as it has mounts, with different options each.
 */
const productEvents = new TinybirdDelivery(components.productEvents);
const auditEvents = new TinybirdDelivery(components.auditEvents);

/**
 * Place an order and record it, in ONE transaction.
 *
 * The enqueue is a write in the caller's mutation, so it commits or rolls back with the order
 * itself. That is the property the whole design exists for: there is no window in which the
 * order exists and the event does not, and no outbox row to reconcile afterwards.
 */
export const place = mutation({
  args: { sku: v.string(), quantity: v.number(), failAfterEnqueue: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, { sku, quantity, failAfterEnqueue }) => {
    const orderId = await ctx.db.insert("orders", { sku, quantity, placedAt: Date.now() });

    await productEvents.enqueue(ctx, {
      datasource: "orders",
      // The identity a host chooses is what makes delivery idempotent end to end: the same
      // `eventId` must map to the same Tinybird row, so the order's id is the natural key.
      eventId: orderId,
      payload: { order_id: orderId, sku, quantity },
    });

    // A separate stream with its own credentials, its own retry state and its own pause
    // switch. Nothing here is shared with the product stream.
    await auditEvents.enqueue(ctx, {
      datasource: "audit",
      eventId: orderId,
      payload: { order_id: orderId, action: "order.placed" },
    });

    // Exists so a test can prove the rollback claim rather than assert it. A host failure after
    // the enqueue must take the event with it.
    if (failAfterEnqueue === true) throw new Error("host failed after enqueueing");
    return null;
  },
});

/** Delivery state of one order's product event, or null if it was never enqueued. */
export const deliveryStatus = query({
  args: { orderId: v.id("orders") },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, { orderId }) =>
    productEvents.status(ctx, { datasource: "orders", eventId: orderId }),
});

/** Both streams' health, which an operator dashboard would poll. */
export const health = query({
  args: {},
  returns: v.object({ product: v.any(), audit: v.any() }),
  handler: async (ctx) => ({
    product: await productEvents.health(ctx),
    audit: await auditEvents.health(ctx),
  }),
});
