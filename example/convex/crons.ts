import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

/**
 * The schedule a host owns.
 *
 * This file exists in the example so the README's cron sample is lifted from code that
 * compiles, rather than written from memory. Verification found the sample had no counterpart
 * here and I had recorded, wrongly, that it could not have one: Convex reserves `crons.ts` for
 * a module whose DEFAULT export is a Crons object, which forbids exporting mutations from it —
 * not registering crons in it. The mutations live in `maintenance.ts`; the schedule lives here.
 *
 * Once a day is a starting point, not a recommendation. A deployment with a large backlog or a
 * short stuck-threshold wants it more often, and the loops inside `maintain` are bounded so a
 * run cannot grow without limit whatever the interval.
 */
const crons = cronJobs();

crons.daily("tinybird maintenance", { hourUTC: 4, minuteUTC: 0 }, internal.maintenance.maintain);

export default crons;
