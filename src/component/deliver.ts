import { v } from "convex/values";

import { classifyResponse } from "./classify";
import { eventsUrl, resolveHost } from "./destination";
import { internal } from "./_generated/api";
import { env, internalAction } from "./_generated/server";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./contract";
import { sanitizeMessage } from "./sanitize";

/**
 * Deliver one event to Tinybird.
 *
 * Runs on the nested Workpool, in the default Convex runtime (no `"use node"`), so it must
 * use only `fetch` and Web APIs. It is deliberately one row per request: a batch would have
 * to decide what "partially accepted" means for the events it did not own, and the volumes
 * this is built for sit far below Tinybird's rate limit.
 *
 * The token is read here from the component's declared env rather than passed in from a
 * query, so it never crosses a function boundary or appears in a return value.
 */
export const deliverEvent = internalAction({
  args: { eventId: v.id("events") },
  returns: v.object({
    outcome: v.union(
      v.literal("delivered"),
      v.literal("failed"),
      v.literal("deferred"),
      v.literal("skipped"),
    ),
  }),
  handler: async (ctx, { eventId }) => {
    const loaded = await ctx.runQuery(internal.lib.loadForDelivery, { eventId });
    // The event was cleaned up, replayed elsewhere, or already finished.
    if (loaded === null || loaded.state === "delivered" || loaded.state === "failed") {
      return { outcome: "skipped" as const };
    }

    const token = env.TINYBIRD_TOKEN ?? "";
    // Unconfigured or paused: leave the event pending so a later resume can drain it.
    // Returning rather than throwing keeps this out of the failure budget.
    if (token.trim() === "" || loaded.paused) return { outcome: "deferred" as const };

    const claimed = await ctx.runMutation(internal.lib.markDelivering, { eventId });
    if (!claimed) return { outcome: "skipped" as const };

    const url = eventsUrl(resolveHost(env.TINYBIRD_HOST), loaded.datasource);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-ndjson",
        },
        // One canonical row as a single NDJSON line.
        body: `${loaded.payload}\n`,
        // A redirect could forward the Authorization header to another host.
        redirect: "error",
        signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Timeout, connection loss or a refused redirect. The retry layer owns the policy,
      // so fail the attempt rather than deciding here.
      //
      // Only the error's NAME reaches the message: a fetch failure can carry the request
      // URL, and this string is persisted on the row and surfaced by `health`. The original
      // is attached as `cause`, which stays in the deployment log rather than a public API.
      throw new Error(sanitizeMessage(`Tinybird request failed: ${(error as Error).name}`, token), {
        cause: error,
      });
    }

    const classified = classifyResponse(response.status, await readJson(response));

    if (classified.kind === "delivered") {
      await ctx.runMutation(internal.lib.markDelivered, { eventId });
      return { outcome: "delivered" as const };
    }
    if (classified.kind === "failed") {
      await ctx.runMutation(internal.lib.markFailed, {
        eventId,
        error: {
          category: classified.category,
          httpStatus: classified.httpStatus,
          message: sanitizeMessage(classified.message, token),
          at: Date.now(),
        },
      });
      return { outcome: "failed" as const };
    }
    // Not decided at this layer; failing the attempt hands it to the retry policy.
    throw new Error(sanitizeMessage(classified.message, token));
  },
});

/** Reads a JSON body, returning null rather than throwing when there is not one. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}
