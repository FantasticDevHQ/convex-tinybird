import type { WorkId } from "@convex-dev/workpool";
import { api, internal } from "./_generated/api";
import { installComponentTestHooks, seedEvent, setup } from "../testing/fixtures";

installComponentTestHooks();

// Each production error writer must replace the category as well as the error. Seed a
// different category so a stale value fails just as clearly as an omitted initial write.
it.each(["attempt", "terminal", "exhausted", "pause", "recovery", "replayEvent", "replayFailed"])(
  "maintains the indexed category through %s",
  async (transition) => {
    const t = setup("");
    const id = await t.run((ctx) =>
      seedEvent(ctx, {
        datasource: "events",
        eventId: "one",
        state: transition.startsWith("replay") ? "failed" : "delivering",
        attempts: 1,
        createdAt: Date.now() - 3600000,
        updatedAt: Date.now() - 3600000,
        lastError: { category: "server_error", message: "old", at: Date.now() - 3600000 },
      }),
    );
    const error = { category: "quarantined" as const, message: "new", at: Date.now() };
    if (transition === "attempt")
      await t.mutation(internal.lifecycle.markAttemptFailed, { eventId: id, error });
    if (transition === "terminal")
      await t.mutation(internal.lifecycle.markFailed, { eventId: id, error });
    if (transition === "pause")
      await t.mutation(internal.lifecycle.markPaused, {
        eventId: id,
        reason: "unauthorized",
        error: { ...error, category: "unauthorized" },
      });
    if (transition === "exhausted") {
      await t.run((ctx) => ctx.db.patch(id, { workId: "completed-work" }));
      await t.mutation(internal.lifecycle.onDeliveryComplete, {
        workId: "completed-work" as WorkId,
        context: { eventId: id },
        result: { kind: "failed", error: "budget exhausted" },
      });
    }
    if (transition === "recovery") await t.mutation(api.recovery.requeueStuck, {});
    if (transition === "replayEvent")
      await t.mutation(api.lib.replayEvent, { datasource: "events", eventId: "one" });
    if (transition === "replayFailed") await t.mutation(api.lib.replayFailed, {});
    const event = await t.run((ctx) => ctx.db.get(id));
    const expected = transition.startsWith("replay")
      ? undefined
      : transition === "exhausted"
        ? "exhausted"
        : transition === "pause"
          ? "unauthorized"
          : transition === "recovery"
            ? "stuck"
            : "quarantined";
    expect(event?.lastError?.category).toBe(expected);
    expect(event?.lastErrorCategory).toBe(expected);
  },
);
