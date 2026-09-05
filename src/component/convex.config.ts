import workpool from "@convex-dev/workpool/convex.config";
import { defineComponent } from "convex/server";
import { v } from "convex/values";

/**
 * Tinybird delivery component.
 *
 * Credentials are declared here and supplied by the host at mount time:
 *
 *   app.use(tinybird, {
 *     env: {
 *       TINYBIRD_TOKEN: process.env.TINYBIRD_TOKEN,
 *       TINYBIRD_HOST: process.env.TINYBIRD_HOST,
 *     },
 *   });
 *
 * Component code reads them only through the generated `env` export. Without an append
 * token enqueue still stores events, but schedules no delivery. Optional read-signing
 * configuration is independent of the append path.
 */
const component = defineComponent("tinybird", {
  env: {
    /** Append token (`DATASOURCE:APPEND` scope). Absent → unconfigured. */
    TINYBIRD_TOKEN: v.optional(v.string()),
    /** API base URL, e.g. `https://api.tinybird.co`. Absent → the default host. */
    TINYBIRD_HOST: v.optional(v.string()),
    /** Workspace admin token used only to sign short-lived read JWTs. */
    TINYBIRD_ADMIN_TOKEN: v.optional(v.string()),
    /** Workspace whose endpoints accept those JWTs. */
    TINYBIRD_WORKSPACE_ID: v.optional(v.string()),
  },
});

/**
 * Delivery runs on a nested Workpool: it owns scheduling, parallelism and (from the next
 * layer) retry policy, so this component never calls `ctx.scheduler` itself. One mounted
 * Tinybird instance gets exactly one pool, so two host mounts cannot contend.
 */
component.use(workpool);

export default component;
