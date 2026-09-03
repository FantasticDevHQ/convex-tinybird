// Imports nothing forbidden: the point of this fixture is that the violation is reachable
// only through a construct, so an import-only gate passes it.
import { mutation } from "./_generated/server";

export const replayFailed = mutation({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    return identity?.subject ?? null;
  },
});
