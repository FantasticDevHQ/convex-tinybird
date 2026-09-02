import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  vDeliveryError,
  vEventState,
  vOperatorAction,
  vPausedReason,
  vRetryConfig,
} from "./contract";

/**
 * One row per event. The row IS the dedupe record: identity `(datasource, eventId)` is
 * unique through `by_identity`, and a delivered row survives until retention cleanup
 * removes it, so the dedupe window equals the retention window.
 */
export const events = defineTable({
  datasource: v.string(),
  eventId: v.string(),
  /** Canonical JSON (sorted keys, no whitespace). Sent verbatim as one NDJSON line. */
  payload: v.string(),
  payloadBytes: v.number(),
  state: vEventState,
  attempts: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  deliveredAt: v.optional(v.number()),
  lastError: v.optional(vDeliveryError),
  previousErrors: v.optional(v.array(vDeliveryError)),
  /** Workpool id of the live delivery item, when one is scheduled. */
  workId: v.optional(v.string()),
  retry: v.optional(vRetryConfig),
  requestTimeoutMs: v.optional(v.number()),
})
  .index("by_identity", ["datasource", "eventId"])
  .index("by_state_createdAt", ["state", "createdAt"])
  // Exactly the set `resume` puts back to work: waiting, with no live pool item. Scanning
  // `by_state_createdAt` and filtering instead would let rows that already have work fill
  // the window and hide events behind them that genuinely need requeueing.
  .index("by_state_workId_createdAt", ["state", "workId", "createdAt"])
  .index("by_state_updatedAt", ["state", "updatedAt"]);

/** Single row, created lazily. Destination-wide state; never a credential. */
export const settings = defineTable({
  paused: v.boolean(),
  pausedReason: v.optional(vPausedReason),
  pausedAt: v.optional(v.number()),
  lastDeliveredAt: v.optional(v.number()),
  lastError: v.optional(vDeliveryError),
  lastOperatorAction: v.optional(vOperatorAction),
});

export default defineSchema({ events, settings });
