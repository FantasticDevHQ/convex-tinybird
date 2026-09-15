import tinybird from "@fantasticdevhq/convex-tinybird/convex.config";
import { defineApp } from "convex/server";

/**
 * Two instances, mounted under different names.
 *
 * This is the portability proof, not decoration. Each mount gets its own tables, its own
 * settings row and its own Workpool, so an event enqueued into `productEvents` is invisible to
 * `auditEvents` — and pausing one does not pause the other. A component that leaked state
 * between mounts would be unusable for anything but a single global stream, and nothing in the
 * component's own test suite can notice that, because it registers one instance.
 *
 * The two also carry different credentials, which is the realistic shape: a product stream and
 * an audit stream usually live in different Tinybird workspaces with separately scoped tokens.
 */
const app = defineApp();

app.use(tinybird, {
  name: "productEvents",
  env: {
    TINYBIRD_TOKEN: process.env.PRODUCT_TINYBIRD_TOKEN,
    TINYBIRD_HOST: process.env.PRODUCT_TINYBIRD_HOST,
    // Only needed for browser reads: the signing secret and workspace the JWTs are bound to.
    TINYBIRD_ADMIN_TOKEN: process.env.PRODUCT_TINYBIRD_ADMIN_TOKEN,
    TINYBIRD_WORKSPACE_ID: process.env.PRODUCT_TINYBIRD_WORKSPACE_ID,
  },
});

app.use(tinybird, {
  name: "auditEvents",
  env: {
    TINYBIRD_TOKEN: process.env.AUDIT_TINYBIRD_TOKEN,
    TINYBIRD_HOST: process.env.AUDIT_TINYBIRD_HOST,
    TINYBIRD_ADMIN_TOKEN: process.env.AUDIT_TINYBIRD_ADMIN_TOKEN,
    TINYBIRD_WORKSPACE_ID: process.env.AUDIT_TINYBIRD_WORKSPACE_ID,
  },
});

export default app;
