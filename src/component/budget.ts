/**
 * How much work one call may do, and the arithmetic behind every number here.
 *
 * Split out of `contract.ts` because these constants are one subject — the cost of a call —
 * and because the reasoning is the valuable part. Four successive versions of it were wrong,
 * each inheriting the previous one's frame, so the arithmetic is asserted in
 * `healthcost.test.ts` rather than trusted here. Change a number and that test is where you
 * find out what else it moved.
 *
 * Everything is a pure constant. Nothing here reads the database or the environment.
 */

/** How long a `delivered` row is kept before retention may remove it. */
export const DEFAULT_DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a `failed` row is kept.
 *
 * Longer than delivered on purpose: a delivered row exists only to answer "have I sent this
 * already", while a dead letter is something an operator may still act on, and the window to
 * notice one is measured in weeks rather than days.
 */
export const DEFAULT_FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The share of one call's read budget a retention sweep may spend.
 *
 * 8 MiB is a CHOSEN margin, not the limit. `TRANSACTION_MAX_READ_SIZE_BYTES` defaults to
 * `1 << 24` — 16 MiB (`crates/common/src/knobs.rs:580`) — so sizing against 8 is deliberately
 * half of it, because the knob is settable per deployment and this component cannot see it.
 * Stating that matters: read as "8 MiB is the limit", the 35% share looks like a second
 * unexplained fudge stacked on a first, and someone reasonably deletes one of them.
 *
 * 35% matches what `health` is sized against in `healthcost.test.ts`, so the two costly
 * paths in this component use one number.
 */
export const SWEEP_READ_BUDGET_BYTES = Math.floor(8 * 1024 * 1024 * 0.35);

/**
 * What one swept event row costs to READ, counted twice.
 *
 * 5 459 bytes is the largest `events` row the contract permits, measured rather than
 * estimated — `healthcost.test.ts` builds it and pins the number. It is counted twice
 * because the sweep reads the row once from `by_state_updatedAt` and again when
 * `ctx.db.delete(event._id)` fetches it (see {@link PAYLOAD_ROW_OVERHEAD_BYTES} for why a
 * delete is a read).
 *
 * Twice is exact, not merely cautious. Convex accumulates reads with
 * `tx_size.total_document_size += document_size` and does not deduplicate by document id
 * (`crates/database/src/reads.rs:487`), so reading the same row twice is charged twice. An
 * earlier draft of this comment hedged that Convex "may well charge that once" — worth
 * checking rather than hedging, since the hedge would have been an excuse to halve the
 * constant later.
 */
export const EVENT_ROW_READ_BYTES = 2 * 5_459;

/**
 * Everything a `payloads` row costs beyond the payload text itself: `_id`, `_creationTime`,
 * `eventId` and the field names. Measured at ~134 bytes; 192 is rounded up.
 *
 * This constant exists because of a mistake worth recording. Every earlier version of this
 * file claimed `ctx.db.delete(id)` "reads nothing", and sized the sweep on that. It is
 * false. Convex's `delete_inner` calls `get_inner`, which calls
 * `record_read_document(..., doc.size(), ..., &self.limits)` — `crates/database/src/
 * transaction.rs:666`, `:1093`. A delete reads the WHOLE document and charges its bytes.
 *
 * So `payloadId` does not avoid reading the payload; it avoids one index lookup. The real
 * cost of deleting an event is the event row plus its payload, and at the default 64 KiB
 * bound a 200-row batch is about 13 MiB against an 8 MiB limit — the precise disaster the
 * old docblock claimed the pointer prevented. Three rounds of review passed over it because
 * no test can see it: `convex-test` enforces no byte limit.
 */
export const PAYLOAD_ROW_OVERHEAD_BYTES = 192;

/**
 * How many rows one `cleanup` call removes, across both states, by default.
 *
 * A ROW cap, and the weaker of the sweep's two bounds. The real bound is
 * {@link SWEEP_READ_BUDGET_BYTES}, which the sweep spends against each row's stored
 * `payloadBytes` as it walks. That is what makes the limit true rather than documented: the
 * payload bound is a per-call host option that `cleanup` cannot see, so no fixed row count
 * can be safe for every configuration. The bytes are on the rows themselves.
 *
 * Which bound binds depends on payload size, and each binds where it should:
 *
 * | payload size | cost per row | rows the byte budget allows | binds |
 * |---|---|---|---|
 * | ~200 B (typical) | ~11 KiB | ~260 | the row cap, at 200 |
 * | 1 KiB | ~12 KiB | ~243 | the row cap, at 200 |
 * | 64 KiB (default bound) | ~75 KiB | ~38 | the byte budget |
 * | 512 KiB (hard cap) | ~523 KiB | ~5 | the byte budget |
 *
 * 200 is therefore chosen for how much work one transaction should reasonably do, which is
 * what the old docblock claimed for it — the difference is that the claim is now true,
 * because something else enforces the bytes.
 *
 * The sweep always removes at least one row even when that row alone exceeds the budget, and
 * exactly one per CALL rather than one per state. A single row cannot approach the limit
 * (the worst case is ~523 KiB against ~2.9 MiB), and refusing to make progress is the
 * failure mode this component keeps rediscovering: a sweep that deletes nothing on every
 * call never runs again.
 *
 * **If you are here to raise this number, read this paragraph.** Bytes are the first limit
 * to bind and they are handled above, but they are not the only meter, and the second one is
 * not the one you would check. Per swept row the sweep touches three documents — the event
 * from the index, the payload delete, the event delete — and FOUR on the pre-`payloadId`
 * fallback, where `by_event` reads the payload before the delete re-reads it. Each by-id
 * read also registers one read-set interval. Against the backend defaults:
 *
 * | meter | knob | default | at 200 rows | at 1000 rows |
 * |---|---|---|---|---|
 * | read bytes | `TRANSACTION_MAX_READ_SIZE_BYTES` | 16 MiB | budgeted above | budgeted above |
 * | read-set intervals | `TRANSACTION_MAX_READ_SET_INTERVALS` | 4 096 | ~15% | ~73% |
 * | documents read | `TRANSACTION_MAX_READ_SIZE_ROWS` | 32 000 | ~2.5% | ~12.5% |
 * | writes | `TRANSACTION_MAX_NUM_USER_WRITES` | 16 000 | ~2.5% | ~12.5% |
 *
 * So the order is bytes, then INTERVALS at 4 096, then documents, then writes — and a reader
 * who checks documents finds eightfold headroom where the real headroom is about sixfold, on
 * a meter they did not look at.
 *
 * Every figure is the FALLBACK path, which is the worst case. That is worth stating because
 * the first draft of this table quoted the pointer figure in one cell — 9% where the
 * fallback is 12.5% — while claiming to be worst case throughout. A table whose whole
 * purpose is to be trusted by the next person cannot mix its paths. Intervals merge when
 * they overlap, so those counts are upper bounds.
 *
 * Note too that a delete charges its full document on the READ meter and nothing at all on
 * the write meter — `value_size` is `0` when `new_document` is `None`
 * (`crates/database/src/writes.rs:255`). "Deleting 200 rows of 512 KiB payloads writes zero
 * bytes" is correct, not a typo, and does not want a second byte budget built for it.
 */
export const DEFAULT_CLEANUP_LIMIT = 200;

/**
 * How many payload rows one `reclaimOrphanedPayloads` call examines.
 *
 * Small where the retention limit is large, and for a reason `cleanup` does not share: this
 * scan cannot budget by bytes. `cleanup` knows what a row costs before touching it, because
 * the event carries `payloadBytes`. This one learns a payload's size by reading it, so the
 * cost is paid before it can be weighed and the row count is the only bound available.
 *
 * Each scanned row costs one of two things, and the budget takes the larger:
 *
 *   healthy — `paginate` reads the payload, then `ctx.db.get(eventId)` reads the event.
 *   orphan  — that get returns null and costs nothing, but `ctx.db.delete` re-reads the
 *             payload it was already handed, because a delete reads the document it
 *             deletes. So an orphan pays for its payload TWICE.
 *
 * Which is worse flips where a payload outweighs an event row. Against roughly 8 MiB per
 * call at a 35% share, with the event row measured at 5 459 bytes and the payload row's
 * overhead at 134:
 *
 * | payload bound | healthy row | orphan row | rows that fit |
 * |---|---|---|---|
 * | 1 KiB | ~6.5 KiB | ~2.3 KiB | ~443 |
 * | 64 KiB (default) | ~69 KiB | ~128 KiB | ~22 |
 * | 512 KiB (hard cap) | ~518 KiB | ~1 MiB | 2 |
 *
 * Two, so the default is safe for ANY payload size a host may configure, and it is the
 * largest value that is — a third row at the hard cap exceeds the share. Both halves are
 * asserted in `healthcost.test.ts`, so it cannot drift in either direction in silence.
 *
 * Three earlier versions of this docblock were wrong, each in a way the next one inherited,
 * which is why the arithmetic now lives in a test. The first justified 25 rows as "about
 * 13 MB, sized to stay inside one transaction" — 156% of the budget. The second corrected
 * the value but counted only the payload, so it was right at the hard cap and threefold out
 * at 1 KiB. The third added the event read and still measured a HEALTHY row, understating
 * the orphan case by 98% at the cap — the one case the function exists for.
 *
 * A host whose events are small should pass a larger `limit`; the scan is paginated, so the
 * cost of a small default is more calls rather than an unreachable table.
 */
export const DEFAULT_ORPHAN_SCAN_LIMIT = 2;

/**
 * The largest `limit` `reclaimOrphanedPayloads` will honour.
 *
 * Sized for the DEFAULT payload bound rather than the hard cap: 20 orphans at 64 KiB is
 * about 2.6 MiB, inside the share. A host that raises `maxPayloadBytes` must lower its
 * limit to match, which is stated here because nothing can enforce it — the scan cannot see
 * that option, and by the time it has read a row it has already paid for it.
 *
 * A ceiling here and none on `cleanup`, which is the opposite of where you would expect one,
 * for exactly the reason above: `cleanup` budgets by bytes and needs no row ceiling to stay
 * safe. Removing this one, which an earlier revision did, let a host follow this file's own
 * advice to "pass a larger one" into reading several times the whole call budget.
 */
export const MAX_ORPHAN_SCAN_LIMIT = 20;
