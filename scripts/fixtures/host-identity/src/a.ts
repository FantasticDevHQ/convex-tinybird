// Idiomatic Convex, and invisible to a gate that only knows the string `ctx.auth`.
import { query } from "./_generated/server";

export const whoami = query({
  handler: async ({ auth }) => {
    const identity = await auth.getUserIdentity();
    return identity?.subject ?? null;
  },
});
