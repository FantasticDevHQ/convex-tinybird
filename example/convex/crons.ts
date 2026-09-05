import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

// The host chooses the interval. Each invocation processes bounded maintenance pages.
const crons = cronJobs();

crons.daily("tinybird maintenance", { hourUTC: 4, minuteUTC: 0 }, internal.maintenance.maintain);

export default crons;
