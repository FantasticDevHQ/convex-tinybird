// Does not read the identity itself; hands the capability to someone who will.
import type { QueryCtx } from "./_generated/server";

export function identityProvider(ctx: QueryCtx) {
  return ctx.auth;
}
