import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  vDeliveryError,
  vFailureCategory,
  vEventState,
  vOperatorAction,
  vPausedReason,
  vRetryConfig,
} from "./contract.js";

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
  /**
   * The row in `payloads` holding this event's body.
   *
   * Optional only because it cannot be known at insert time: the payload row keys itself by
   * the event, so the event must exist first. `enqueue` patches it in the same mutation, so
   * no committed row is ever without it.
   *
   * It exists so a retention sweep can delete the payload by id rather than searching for it
   * through the `by_event` index. That saves the index lookup, and NOT the payload bytes:
   * `ctx.db.delete(id)` reads the whole document and charges its size against the read limit
   * (`delete_inner` -> `get_inner` -> `record_read_document(..., doc.size(), ...)`,
   * `crates/database/src/transaction.rs:666`). Earlier versions of this comment said the
   * delete "reads nothing" and the sweep was sized on that; see
   * {@link PAYLOAD_ROW_OVERHEAD_BYTES} for what it cost.
   *
   * Keeping the payload out of `events` is still what makes counting, paging and health
   * cheap — those paths never read this table at all. It is the DELETE that pays.
   */
  payloadId: v.optional(v.id("payloads")),
  state: vEventState,
  attempts: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  deliveredAt: v.optional(v.number()),
  lastError: v.optional(vDeliveryError),
  /** Mirrors lastError.category for indexed operator replay. */
  lastErrorCategory: v.optional(vFailureCategory),
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
  .index("by_state_updatedAt", ["state", "updatedAt"])
  .index("by_state_lastErrorCategory_updatedAt", ["state", "lastErrorCategory", "updatedAt"]);

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
  /**
   * When a retention sweep last ran, whether or not it deleted anything.
   *
   * Separate from `lastOperatorAction` because the two answer different questions and that
   * field is a single slot. A nightly no-op sweep writing into the shared slot would erase
   * the record of the last human action within a day of it happening.
   */
  lastCleanupAt: v.optional(v.number()),
});

export default defineSchema({ events, payloads, settings });
