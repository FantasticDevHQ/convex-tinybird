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
 * Component code reads them only through the generated `env` export. Both are optional
 * on purpose: without a token the component is *unconfigured* — enqueue still stores
 * events, nothing is scheduled and no request leaves the deployment.
 */
const component = defineComponent("tinybird", {
  env: {
    /** Append token (`DATASOURCE:APPEND` scope). Absent → unconfigured. */
    TINYBIRD_TOKEN: v.optional(v.string()),
    /** API base URL, e.g. `https://api.tinybird.co`. Absent → the default host. */
    TINYBIRD_HOST: v.optional(v.string()),
  },
});

export default component;
