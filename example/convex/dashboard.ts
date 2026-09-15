import { TinybirdDelivery } from "@fantasticdevhq/convex-tinybird";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

/**
 * What the demo page reads. Everything here is HOST code: the component knows nothing about
 * orders, SKUs or which mount is "product". It only answers "what happened to event X" and
 * "how is this mount doing", and the page combines that with the host's own tables.
 */
const productEvents = new TinybirdDelivery(components.productEvents);
const auditEvents = new TinybirdDelivery(components.auditEvents);

/** How many recent orders the page reasons about. Bounded so the query cost is bounded. */
const WINDOW = 200;
const RECENT = 8;

export const vOrderSummary = v.object({
  orders: v.number(),
  units: v.number(),
  bySku: v.array(v.object({ sku: v.string(), orders: v.number(), units: v.number() })),
  /** True when more than WINDOW orders exist and the numbers describe only the newest WINDOW. */
  truncated: v.boolean(),
});

/** Host-side metrics: nothing analytics-related, just the orders table summarised. */
export const orderSummary = query({
  args: {},
  returns: vOrderSummary,
  handler: async (ctx) => {
    const rows = await ctx.db.query("orders").order("desc").take(WINDOW + 1);
    const truncated = rows.length > WINDOW;
    const window = rows.slice(0, WINDOW);
    const bySku = new Map<string, { orders: number; units: number }>();
    let units = 0;
    for (const row of window) {
      units += row.quantity;
      const entry = bySku.get(row.sku) ?? { orders: 0, units: 0 };
      entry.orders += 1;
      entry.units += row.quantity;
      bySku.set(row.sku, entry);
    }
    return {
      orders: window.length,
      units,
      bySku: [...bySku.entries()]
        .map(([sku, entry]) => ({ sku, ...entry }))
        .sort((a, b) => b.orders - a.orders || a.sku.localeCompare(b.sku)),
      truncated,
    };
  },
});

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
      scopes: [{ pipe: "orders_by_sku", fixedParams: {} }],
    });
  },
});
