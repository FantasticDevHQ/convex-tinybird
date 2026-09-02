import { env, query, type QueryCtx } from "./_generated/server";
import { type BoundedCount, COUNT_CAP, type EventState, vHealth } from "./contract";

/** Present and non-blank. `convex env set X ""` leaves a variable present-but-empty. */
function hasToken(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** Reads at most `COUNT_CAP + 1` rows so health stays cheap on a large outbox. */
async function boundedCount(ctx: QueryCtx, state: EventState): Promise<BoundedCount> {
  const rows = await ctx.db
    .query("events")
    .withIndex("by_state_createdAt", (q) => q.eq("state", state))
    .take(COUNT_CAP + 1);
  const capped = rows.length > COUNT_CAP;
  return { count: capped ? COUNT_CAP : rows.length, capped };
}

/** Delivery health for operators: configuration, pause state and bounded backlog counts. */
export const health = query({
  args: {},
  returns: vHealth,
  handler: async (ctx) => {
    const settings = await ctx.db.query("settings").first();
    // Three independent index range scans; there is no ordering between them.
    const [pending, delivering, failed] = await Promise.all([
      boundedCount(ctx, "pending"),
      boundedCount(ctx, "delivering"),
      boundedCount(ctx, "failed"),
    ]);
    return {
      configured: hasToken(env.TINYBIRD_TOKEN),
      paused: settings?.paused ?? false,
      pausedReason: settings?.pausedReason,
      counts: { pending, delivering, failed },
    };
  },
});
