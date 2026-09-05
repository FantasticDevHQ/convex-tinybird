import { v } from "convex/values";

import { classifyResponse } from "./classify.js";
import { readAppendToken } from "./credentials.js";
import { eventsUrl, resolveDestination } from "./destination.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { type ActionCtx, env, internalAction } from "./_generated/server.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./contract.js";
import { sanitizeMessage } from "./sanitize.js";

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
/**
 * Result of one delivery attempt. Declared rather than inferred: the handler reaches back
 * into `internal.*`, and inferring its type from that would make the generated API depend on
 * the very function it describes.
 */
type DeliveryOutcome = {
  outcome: "delivered" | "failed" | "deferred" | "skipped" | "paused";
};

export const deliverEvent = internalAction({
  args: { eventId: v.id("events") },
  returns: v.object({
    outcome: v.union(
      v.literal("delivered"),
      v.literal("failed"),
      v.literal("deferred"),
      v.literal("skipped"),
      v.literal("paused"),
    ),
  }),
  handler: async (ctx, { eventId }): Promise<DeliveryOutcome> => {
    const loaded = await ctx.runQuery(internal.lifecycle.loadForDelivery, { eventId });
    // The event was cleaned up, replayed elsewhere, or already finished. All races, all
    // benign, and none of them records anything.
    if (loaded === null || loaded.state === "delivered" || loaded.state === "failed") {
      return { outcome: "skipped" as const };
    }

    // A missing payload is not a race. The event is real and will never be deliverable, so
    // it becomes a dead letter an operator can find and replay rather than a `pending` row
    // that nothing will ever pick up. Recorded before the claim, so it costs no attempt.
    if (loaded.payload === undefined) {
      await ctx.runMutation(internal.lifecycle.markFailed, {
        eventId,
        error: {
          category: "payload_missing" as const,
          message: "The event has no stored payload, so there is nothing to send",
          at: Date.now(),
        },
      });
      return { outcome: "failed" as const };
    }

    const token = readAppendToken();
    // Unconfigured or paused: leave the event pending so a later resume can drain it.
    // Returning rather than throwing keeps this out of the failure budget.
    if (token.trim() === "" || loaded.paused) return { outcome: "deferred" as const };

    // Resolve the destination BEFORE claiming: a bad host is a configuration fault, not a
    // delivery attempt, and it must not consume the event's budget or leave it in flight.
    const destination = resolveDestination(env.TINYBIRD_HOST);
    if (!destination.ok) {
      await ctx.runMutation(internal.lifecycle.markPaused, {
        eventId,
        reason: "invalid_host",
        error: { category: "invalid_request", message: destination.reason, at: Date.now() },
      });
      return { outcome: "paused" as const };
    }

    const claimed = await ctx.runMutation(internal.lifecycle.markDelivering, { eventId });
    if (!claimed) return { outcome: "skipped" as const };

    try {
      return await attemptDelivery(ctx, eventId, {
        datasource: loaded.datasource,
        payload: loaded.payload,
        host: destination.host,
        requestTimeoutMs: loaded.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        token,
      });
    } catch (error) {
      // The claim must not outlive the attempt: a retry has to be able to claim it again.
      await ctx.runMutation(internal.lifecycle.releaseForRetry, { eventId });
      throw error;
    }
  },
});

/** One request and its consequence. Throws when the outcome is not decided at this layer. */
async function attemptDelivery(
  ctx: { runMutation: ActionCtx["runMutation"] },
  eventId: Id<"events">,
  request: {
    datasource: string;
    payload: string;
    host: string;
    requestTimeoutMs: number;
    token: string;
  },
): Promise<DeliveryOutcome> {
  {
    const { payload, host, requestTimeoutMs, token } = request;
    const url = eventsUrl(host, request.datasource);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-ndjson",
        },
        // One canonical row as a single NDJSON line.
        body: `${payload}\n`,
        // A redirect could forward the Authorization header to another host.
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      // Timeout, connection loss or a refused redirect: all worth another attempt.
      //
      // Only the error's NAME reaches the message: a fetch failure can carry the request
      // URL, and this string is persisted on the row and surfaced by `health`. The original
      // is attached as `cause`, which stays in the deployment log rather than a public API.
      const name = (error as Error).name;
      await ctx.runMutation(internal.lifecycle.markAttemptFailed, {
        eventId,
        error: {
          category: transportCategory(name),
          message: sanitizeMessage(`Tinybird request failed: ${name}`, token),
          at: Date.now(),
        },
      });
      throw new Error(sanitizeMessage(`Tinybird request failed: ${name}`, token), {
        cause: error,
      });
    }

    const classified = classifyResponse(response.status, await readJson(response));

    if (classified.kind === "delivered") {
      await ctx.runMutation(internal.lifecycle.markDelivered, { eventId });
      return { outcome: "delivered" as const };
    }
    if (classified.kind === "failed") {
      await ctx.runMutation(internal.lifecycle.markFailed, {
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
    // A refused token is not worth retrying: no number of attempts fixes a wrong
    // credential, and spending the budget would dead-letter the whole backlog one event at
    // a time. Pause the destination, keep the event, and return without throwing so the
    // pool records success and schedules nothing further.
    if (classified.category === "unauthorized") {
      await ctx.runMutation(internal.lifecycle.markPaused, {
        eventId,
        reason: "unauthorized",
        error: {
          category: classified.category,
          httpStatus: classified.httpStatus,
          message: sanitizeMessage(classified.message, token),
          at: Date.now(),
        },
      });
      return { outcome: "paused" as const };
    }

    // Retryable: record the attempt, then fail it so the pool applies the retry policy.
    // Running out of attempts is what turns this into a dead letter, in onDeliveryComplete.
    await ctx.runMutation(internal.lifecycle.markAttemptFailed, {
      eventId,
      error: {
        category: classified.category,
        httpStatus: classified.httpStatus,
        message: sanitizeMessage(classified.message, token),
        at: Date.now(),
      },
    });
    throw new Error(sanitizeMessage(classified.message, token));
  }
}

/**
 * Why a request never produced a response. `AbortSignal.timeout` rejects with a
 * `TimeoutError`; a refused redirect or a dropped connection surfaces as a `TypeError`.
 */
function transportCategory(errorName: string): "timeout" | "network" {
  return errorName === "TimeoutError" || errorName === "AbortError" ? "timeout" : "network";
}

/** Reads a JSON body, returning null rather than throwing when there is not one. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}
