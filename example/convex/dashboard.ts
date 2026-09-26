import { TinybirdDelivery } from "@fantastic.dev/convex-tinybird";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

/**
 * What the demo page reads FROM CONVEX, which is deliberately not the metrics. Every aggregate
 * on the page (orders, units, per-SKU, per-minute, audit actions) comes from Tinybird through
 * the endpoints deployed from example/tinybird. Convex only answers the operational questions
 * the component exists to answer: what happened to event X, and how is this mount doing.
 */
const productEvents = new TinybirdDelivery(components.productEvents);
const auditEvents = new TinybirdDelivery(components.auditEvents);

/** The endpoints deployed from example/tinybird that the page is allowed to read. */
export const DEMO_PIPES = [
  "orders_summary",
  "orders_by_sku",
  "orders_per_minute",
  "orders_per_hour",
  "orders_per_day",
  "audit_actions",
] as const;

/** How many recent orders the page lists. Bounded so the query cost is bounded. */
const RECENT = 8;

/**
 * The newest orders with the delivery state of each one's events on BOTH mounts. `status`
 * returns null for an identity that was never enqueued, which cannot happen here because
 * `orders.place` enqueues in the same transaction as the insert; the page still handles null.
 */
export const recentOrders = query({
  args: {},
  returns: v.array(
    v.object({
      orderId: v.id("orders"),
      sku: v.string(),
      quantity: v.number(),
      placedAt: v.number(),
      product: v.union(v.null(), v.string()),
      audit: v.union(v.null(), v.string()),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("orders").order("desc").take(RECENT);
    const out = [];
    for (const row of rows) {
      const [product, audit] = await Promise.all([
        productEvents.status(ctx, { datasource: "orders", eventId: row._id }),
        auditEvents.status(ctx, { datasource: "audit", eventId: row._id }),
      ]);
      out.push({
        orderId: row._id,
        sku: row.sku,
        quantity: row.quantity,
        placedAt: row.placedAt,
        product: product?.state ?? null,
        audit: audit?.state ?? null,
      });
    }
    return out;
  },
});

/**
 * Mint a browser read token for the demo's Tinybird endpoint, if this deployment has a signing
 * secret and workspace ID on its product mount.
 *
 * UNAUTHENTICATED ON PURPOSE, like everything in operations.ts, and for the same reason: the
 * example demonstrates the component, not an auth scheme. A real host authenticates the viewer
 * here and derives the fixed parameters (tenant, project) from records it trusts. Never expose
 * a mutation that lets the browser choose its own scopes.
 */
export const demoReadToken = mutation({
  args: {},
  returns: v.union(
    v.null(),
    v.object({ token: v.string(), expiresAt: v.number(), host: v.string() }),
  ),
  handler: async (ctx) => {
    const health = await productEvents.health(ctx);
    if (!health.readTokensConfigured) return null;
    return productEvents.mintReadToken(ctx, {
      name: "demo-page",
      ttlSeconds: 300,
      scopes: DEMO_PIPES.map((pipe) => ({ pipe, fixedParams: {} })),
    });
  },
});

/**
 * Schedule delivery for events that were enqueued before the deployment had a destination.
 * Enqueue without a token stores the event and schedules nothing; `resume` unpauses (a no-op
 * when not paused) and requeues what is waiting. The launcher calls this once the destination
 * is configured. Unauthenticated for the same reason as operations.ts.
 */
export const resumeDelivery = mutation({
  args: {},
  returns: v.object({ product: v.number(), audit: v.number() }),
  handler: async (ctx) => {
    const out = { product: 0, audit: 0 };
    for (const [key, stream] of [
      ["product", productEvents],
      ["audit", auditEvents],
    ] as const) {
      for (let pass = 0; pass < 10; pass += 1) {
        const result = await stream.resume(ctx, { actor: "demo launcher" });
        out[key] += result.requeued;
        if (result.requeued === 0) break;
      }
    }
    return out;
  },
});
