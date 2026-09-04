import { Workpool, type WorkId } from "@convex-dev/workpool";

import { components } from "./_generated/api";

/**
 * The component's own delivery pool.
 *
 * `retryActionsByDefault` stays false here: this layer classifies a response and either
 * finishes the event or fails the attempt. Retry policy is configured per enqueue by the
 * next layer, so turning it on globally would silently retry before the policy exists.
 *
 * `maxParallelism` is deliberately far below Tinybird's default 100 requests per second;
 * one event is one request in this design, and the cap is what keeps a large backlog from
 * becoming a burst.
 */
export const pool = new Workpool(components.workpool, {
  maxParallelism: 4,
  retryActionsByDefault: false,
});

/** Re-exported so callers can type a stored `workId` without importing the pool package. */
export type { WorkId };
