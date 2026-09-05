import type { FailureCategory } from "./contract.js";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

type SettingsPatch = Partial<Omit<Doc<"settings">, "_id" | "_creationTime">>;
type Settings = Doc<"settings"> | Doc<"datasourceSettings"> | null;

export async function readSettings(ctx: QueryCtx, datasource?: string): Promise<Settings> {
  return datasource === undefined
    ? ctx.db.query("settings").first()
    : ctx.db
        .query("datasourceSettings")
        .withIndex("by_datasource", (q) => q.eq("datasource", datasource))
        .unique();
}

/** Omitted datasource addresses the original singleton; scoped writes have their own row. */
export async function patchSettings(
  ctx: MutationCtx,
  patch: SettingsPatch,
  datasource?: string,
): Promise<void> {
  const settings = await readSettings(ctx, datasource);
  if (settings !== null) {
    await ctx.db.patch(settings._id, patch);
    return;
  }
  if (datasource === undefined) await ctx.db.insert("settings", { paused: false, ...patch });
  else await ctx.db.insert("datasourceSettings", { datasource, paused: false, ...patch });
}

/** Delivery signals update both the mount summary and this datasource's summary. */
export async function patchDeliverySettings(
  ctx: MutationCtx,
  datasource: string,
  patch: Pick<SettingsPatch, "lastError" | "lastDeliveredAt">,
): Promise<void> {
  await patchSettings(ctx, patch);
  await patchSettings(ctx, patch, datasource);
}

export function effectivePause(global: Settings, scoped: Settings) {
  if (global?.paused) return { paused: true, pausedReason: global.pausedReason };
  if (scoped?.paused && (scoped.pauseGeneration ?? 0) === (global?.pauseGeneration ?? 0)) {
    return { paused: true, pausedReason: scoped.pausedReason };
  }
  return { paused: false, pausedReason: undefined };
}

export async function readPause(ctx: QueryCtx, datasource: string) {
  const [global, scoped] = await Promise.all([readSettings(ctx), readSettings(ctx, datasource)]);
  return effectivePause(global, scoped);
}

/** All failures in a scope, oldest update first. */
export function failedEvents(ctx: QueryCtx, datasource?: string) {
  return datasource === undefined
    ? ctx.db.query("events").withIndex("by_state_updatedAt", (q) => q.eq("state", "failed"))
    : ctx.db
        .query("events")
        .withIndex("by_datasource_state_updatedAt", (q) =>
          q.eq("datasource", datasource).eq("state", "failed"),
        );
}

/** An undefined category selects legacy rows for the upgrade readiness check. */
export function failedEventsByCategory(
  ctx: QueryCtx,
  category: FailureCategory | undefined,
  datasource?: string,
) {
  return datasource === undefined
    ? ctx.db
        .query("events")
        .withIndex("by_state_lastErrorCategory_updatedAt", (q) =>
          q.eq("state", "failed").eq("lastErrorCategory", category),
        )
    : ctx.db
        .query("events")
        .withIndex("by_datasource_state_lastErrorCategory_updatedAt", (q) =>
          q.eq("datasource", datasource).eq("state", "failed").eq("lastErrorCategory", category),
        );
}
