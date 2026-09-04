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
  /**
   * Size of the payload, kept here while the payload itself is not.
   *
   * The size is a scalar an operator may want without paying for the bytes; the payload is
   * in `payloads`, read only when delivering and when comparing a duplicate.
   */
  payloadBytes: v.number(),
  /**
   * Fingerprint of the canonical payload, kept here so a lost payload row can still be
   * checked against what was committed. Length alone cannot do it: the field shapes that
   * dominate real payloads are fixed width, so a flipped status or a swapped id has the
   * same length as the value it replaced.
   */
  payloadHash: v.string(),
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

/**
 * The payload, one row per event, keyed by it.
 *
 * Separate from `events` because Convex returns WHOLE documents and caps a call near 8 MiB,
 * so a payload on the event row makes the cost of every paged read `rows x event size`
 * rather than `rows`. `health`, `resume`, replay and retention all page over `events`, and
 * an independent review of the health query found it failing at roughly 130 unfinished
 * events at the default 64 KiB payload bound — the query whose whole purpose was to stay
 * cheap, failing outright on exactly the backlog it exists to report.
 *
 * Nothing but delivery and the duplicate comparison reads this table.
 */
export const payloads = defineTable({
  eventId: v.id("events"),
  /** Canonical JSON (sorted keys, no whitespace). Sent verbatim as one NDJSON line. */
  payload: v.string(),
}).index("by_event", ["eventId"]);

/** Single row, created lazily. Destination-wide state; never a credential. */
export const settings = defineTable({
  paused: v.boolean(),
  pausedReason: v.optional(vPausedReason),
  pausedAt: v.optional(v.number()),
  lastDeliveredAt: v.optional(v.number()),
  lastError: v.optional(vDeliveryError),
  lastOperatorAction: v.optional(vOperatorAction),
});

export default defineSchema({ events, payloads, settings });
