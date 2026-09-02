import { ConvexError, v } from "convex/values";

import { canonicalJson, utf8Length } from "./canonical";
import { env, mutation, query, type QueryCtx } from "./_generated/server";
import {
  type BoundedCount,
  COUNT_CAP,
  DATASOURCE_NAME_PATTERN,
  DEFAULT_MAX_PAYLOAD_BYTES,
  type EventState,
  HARD_MAX_PAYLOAD_BYTES,
  MAX_EVENT_ID_LENGTH,
  retryConfigViolation,
  vEnqueueArgs,
  vEnqueueResult,
  vEventIdentity,
  vEventStatus,
  vHealth,
} from "./contract";

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

/**
 * Store one event for delivery. Runs inside the HOST's mutation (through `ctx.runMutation`), so
 * the row commits or rolls back with the host's own writes. Every check happens before the
 * write, so a rejected call leaves nothing behind.
 *
 * Identity is `(datasource, eventId)`. Same identity and equal canonical payload → `duplicate`
 * (the stored row is returned as-is); different payload → `identity_conflict`.
 *
 * Delivery scheduling is added by the Workpool layer; this mutation never schedules.
 */
export const enqueue = mutation({
  args: vEnqueueArgs,
  returns: vEnqueueResult,
  handler: async (ctx, args) => {
    if (!DATASOURCE_NAME_PATTERN.test(args.datasource)) {
      throw new ConvexError({ code: "invalid_datasource" as const, datasource: args.datasource });
    }
    const eventId = args.eventId;
    if (eventId.trim() === "" || eventId.length > MAX_EVENT_ID_LENGTH) {
      throw new ConvexError({ code: "invalid_event_id" as const, length: eventId.length });
    }
    if (args.retry) {
      const violation = retryConfigViolation(args.retry);
      if (violation) throw new ConvexError({ code: "invalid_retry" as const, reason: violation });
    }
    const payload = canonicalJson(args.payload);
    const payloadBytes = utf8Length(payload);
    const bound = Math.min(
      args.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      HARD_MAX_PAYLOAD_BYTES,
    );
    if (payloadBytes > bound) {
      throw new ConvexError({
        code: "payload_too_large" as const,
        payloadBytes,
        maxPayloadBytes: bound,
      });
    }

    const existing = await ctx.db
      .query("events")
      .withIndex("by_identity", (q) => q.eq("datasource", args.datasource).eq("eventId", eventId))
      .unique();
    if (existing) {
      if (existing.payload === payload) {
        return { outcome: "duplicate" as const, eventId, state: existing.state };
      }
      throw new ConvexError({
        code: "identity_conflict" as const,
        datasource: args.datasource,
        eventId,
      });
    }

    const now = Date.now();
    await ctx.db.insert("events", {
      datasource: args.datasource,
      eventId,
      payload,
      payloadBytes,
      state: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      ...(args.retry ? { retry: args.retry } : {}),
    });
    return { outcome: "enqueued" as const, eventId, state: "pending" as const };
  },
});

/** Delivery state of one event. Never returns the payload. */
export const getStatus = query({
  args: vEventIdentity,
  returns: v.union(vEventStatus, v.null()),
  handler: async (ctx, { datasource, eventId }) => {
    const row = await ctx.db
      .query("events")
      .withIndex("by_identity", (q) => q.eq("datasource", datasource).eq("eventId", eventId))
      .unique();
    if (!row) return null;
    return {
      datasource: row.datasource,
      eventId: row.eventId,
      state: row.state,
      attempts: row.attempts,
      createdAt: row.createdAt,
      deliveredAt: row.deliveredAt,
      lastError: row.lastError,
    };
  },
});
