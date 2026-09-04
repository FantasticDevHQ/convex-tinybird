import { TinybirdDelivery } from "@fantastic-dev/convex-tinybird";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const productEvents = new TinybirdDelivery(components.productEvents);
const auditEvents = new TinybirdDelivery(components.auditEvents);

/**
 * Named `maintenance.ts` and not `crons.ts`: Convex reserves that filename for a module whose
 * default export is a Crons object, and pushing a `crons.ts` that exports anything else fails
 * with `must have a default export of a Crons object`. The ticket named the file; the platform
 * disagreed, and the platform wins.
 *
 * The maintenance the host owns. The component schedules nothing itself, so without something
 * like this a crashed delivery is never retried and delivered rows are never removed.
 *
 * Rescue runs BEFORE the sweep: a rescued row becomes `pending` and is outside retention either
 * way, so the ordering costs nothing, while the reverse leaves a stuck row unexamined for a
 * whole interval.
 *
 * The cursor is carried, not discarded. Every call without it restarts at the head of the scan,
 * and a page of work that is old but still HEALTHY sits there permanently — so a loop that drops
 * the cursor makes no progress at all in the condition this exists for.
 *
 * That last claim is NOT proven by this app's tests, and it is worth saying so rather than
 * leaving a comment that appears to vouch for one. Deleting `cursor = result.cursor` here leaves
 * the example suite green, because requeued rows leave the scan range and progress continues
 * without it; the cursor only becomes load-bearing when rows are scanned and NOT requeued, which
 * this fixture has no way to build. It is pinned where it is real, against the component
 * directly, in `src/component/cleanup.test.ts` — see the healthy-rows-occupy-the-window case.
 *
 * What this app's tests DO pin is that the job runs against every mounted stream and actually
 * removes expired rows from each: iterating one stream, or iterating none, both fail.
 */
export const maintain = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (const stream of [productEvents, auditEvents]) {
      let cursor;
      for (let pass = 0; pass < 10; pass += 1) {
        const result = await stream.requeueStuck(ctx, { actor: "example cron", cursor });
        cursor = result.cursor;
        if (!result.remaining) break;
      }

      for (let pass = 0; pass < 10; pass += 1) {
        const { remaining } = await stream.cleanup(ctx, { actor: "example cron" });
        if (!remaining) break;
      }
    }
    return null;
  },
});
