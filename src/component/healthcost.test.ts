import { installComponentTestHooks, seedEvent, setup } from "../testing/fixtures";
import {
  COUNT_CAP,
  DEFAULT_MAX_PAYLOAD_BYTES,
  HARD_MAX_PAYLOAD_BYTES,
  MAX_DATASOURCE_NAME_LENGTH,
  MAX_ERROR_HISTORY,
  MAX_EVENT_ID_LENGTH,
  REQUEST_TIMEOUT_RANGE_MS,
  RETRY_LIMITS,
} from "./contract";
import {
  DEFAULT_CLEANUP_LIMIT,
  DEFAULT_ORPHAN_SCAN_LIMIT,
  EVENT_ROW_READ_BYTES,
  MAX_ORPHAN_SCAN_LIMIT,
  PAYLOAD_ROW_OVERHEAD_BYTES,
  SWEEP_READ_BUDGET_BYTES,
} from "./budget";
import { MAX_ERROR_MESSAGE_LENGTH } from "./sanitize";

installComponentTestHooks();

/**
 * Convex's documented per-call read budget for the hosted product.
 *
 * Conservative twice over: the OSS backend's own default knob is 16 MiB, and this uses the
 * published cloud figure instead.
 */
const READ_BUDGET_BYTES = 8 * 1024 * 1024;

/** The ceiling: the fraction of the budget `health`'s worst case may ever occupy. */
const BUDGET_SHARE = 0.35;

/**
 * The share it actually occupies, as documented on `COUNT_CAP`.
 *
 * The tolerance is 0.0005, which is about twice what the four-byte row step can move the
 * share (455 documents x 4 bytes is 0.02 of a point). It was 0.002 and that was too loose:
 * it absorbed a published figure that was simply wrong — 29.7% where the arithmetic gives
 * 29.6% — so the change detector stayed green while both documents printed a false number.
 * That is the fourth time on this component a margin has swallowed the thing it was there
 * to catch.
 *
 * Pinned separately from the ceiling because the two say different things. The ceiling is a
 * safety bound with deliberate headroom, so it does not notice a change that stays inside
 * it: at 29.4% actual against a 35% ceiling the cap could be raised from 150 to about 178
 * in silence, and verification measured that slack at an earlier stage too. This pins the
 * combination of cap and row against the number the docblock publishes, so either moving
 * has to come here.
 */
const DOCUMENTED_SHARE = 0.296;
const SHARE_TOLERANCE = 0.0005;

/**
 * The measured size of the largest event the contract permits.
 *
 * This is the change-detector half. The budget ceiling alone is not one: with the worst case
 * at 29% and the ceiling at 35% there is room to raise the cap by a fifth, or add a kilobyte
 * to the row, in silence — verification measured the cap going 250 to 390 unnoticed before
 * the ceiling bit. Pinning the row size instead means anything that changes what a row costs
 * has to come here and update the number, which is where the arithmetic lives.
 *
 * Pinned to within a single documented step, not a percentage band. An earlier version
 * allowed 3% and then 0.5% on the theory that `_creationTime` varies between runs. It does
 * not: `installComponentTestHooks` freezes the clock, and convex-test computes
 * `_creationTime = now <= last ? last + 0.001 : now`, so the value takes one of exactly TWO
 * lengths — 13 characters for the unbumped integer, 17 for a bumped one — decided by insert
 * order rather than by chance. Measured identical across five runs here, and across 16,000
 * samples spanning a year of clock values in independent verification.
 *
 * So the hazard is not noise, it is a STEP. `seedEvent` inserts the event before its payload
 * row, so the event takes the integer; if that order ever changed, the row would jump four
 * bytes and a bare equality would red with a message nobody could trace back to insert
 * order. {@link CREATION_TIME_STEP_BYTES} absorbs exactly that and nothing else.
 *
 * The percentage bands it replaces were not merely loose. At 3% one swallowed a 128-byte
 * bound change, which is the failure the ratchet exists to catch, and at 0.5% one would
 * still have absorbed the 42 bytes of unmaximal fields verification found.
 */
const WORST_CASE_ROW_BYTES = 5459;

/**
 * The only variation the measurement can legitimately show: `_creationTime` rendering as a
 * bumped 17-character value instead of an unbumped 13-character one, which depends on the
 * order of the inserts in `seedEvent` rather than on anything about the row's contents.
 */
const CREATION_TIME_STEP_BYTES = 4;

/** `health` counts three states, each reading one row past the cap. */
const STATES_COUNTED = 3;

/**
 * `health` is `readHeartbeat` plus the three counts, and the heartbeat reads two documents
 * of its own — the settings row and the oldest waiting event. Two rows against 453 is
 * immaterial, but the sum is presented as the whole cost of the call, so it should be.
 */
const HEARTBEAT_DOCUMENTS = 2;

/**
 * Builds the largest `events` row the contract permits, and measures it.
 *
 * Every string is at its documented maximum and every optional field is present. That is
 * not a pathological shape: a thousand failed rows each carrying a full failure history is
 * precisely what a sustained outage produces, so the worst case and the case an operator
 * reaches for `health` in are the same case.
 */
async function measureWorstCaseRow(): Promise<{ event: number; payload: number }> {
  const t = setup("");
  // Every length cap in this contract counts UTF-16 code units, but Convex sizes a string
  // by its UTF-8 bytes. So the most expensive string a cap admits is not ASCII: a BMP
  // character outside Latin-1 is one code unit and three bytes, which is the worst ratio
  // available. An emoji is worse per character but cheaper per unit — two units, four bytes
  // — so it buys less under a length cap. An ASCII fixture measures a third of the truth.
  const fill = (units: number) => "\u4e2d".repeat(units);
  const error = (i: number) => ({
    // The longest member of the category union.
    category: "payload_too_large" as const,
    httpStatus: 503,
    message: fill(MAX_ERROR_MESSAGE_LENGTH),
    at: Date.now() + i,
  });
  await t.run(async (ctx) => {
    await seedEvent(ctx, {
      // ASCII-bound for real: the pattern admits only `[A-Za-z0-9_]`. Derived from the
      // contract's own constant rather than a literal, so widening the bound moves this
      // fixture with it instead of leaving the two agreeing with each other and disagreeing
      // with the contract.
      datasource: "d".repeat(MAX_DATASOURCE_NAME_LENGTH),
      eventId: fill(MAX_EVENT_ID_LENGTH),
      // `delivering` is a counted state and four bytes longer than `failed`.
      state: "delivering" as const,
      attempts: RETRY_LIMITS.maxAttempts.max,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deliveredAt: Date.now(),
      lastError: error(0),
      previousErrors: Array.from({ length: MAX_ERROR_HISTORY }, (_, i) => error(i + 1)),
      // The one fill not derived from a contract bound: `workId` comes from the workpool, so
      // 32 is an observation about its id format rather than a limit this component sets. If
      // that format ever changes, this test reds on the row size with a failure message that
      // will not say so — check here first.
      workId: "w".repeat(32),
      retry: {
        maxAttempts: RETRY_LIMITS.maxAttempts.max,
        initialBackoffMs: RETRY_LIMITS.initialBackoffMs.max,
        base: RETRY_LIMITS.base.max,
      },
      requestTimeoutMs: REQUEST_TIMEOUT_RANGE_MS.max,
      // The payload lives in its own table, but its SIZE stays on this row.
      payload: "x".repeat(HARD_MAX_PAYLOAD_BYTES),
    });
  });
  const row = await t.run(async (ctx) => ctx.db.query("events").first());

  // The measurement is only worth its name if the row really is maximal. `padEnd` with an
  // undefined length silently does nothing, which is how an earlier version of this probe
  // measured 1264 bytes instead of 2458 and made the cap look twice as safe as it is.
  // EVERY message, not the first one. Checking `previousErrors[0]` leaves four of the five
  // free to be anything, and independent verification used exactly that to make the row
  // 38.7% smaller with every assertion here still passing — which is the same defect this
  // guard exists to catch, surviving inside the array it was written for.
  const messages = [row?.lastError, ...(row?.previousErrors ?? [])];
  expect(messages).toHaveLength(MAX_ERROR_HISTORY + 1);
  for (const error of messages) {
    expect(error?.message).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
    // Length is not size. Asserting only the length is how an ASCII fixture passes for a
    // maximal one, so the byte cost is asserted too.
    expect(Buffer.byteLength(error?.message ?? "", "utf8")).toBe(MAX_ERROR_MESSAGE_LENGTH * 3);
    expect(error?.httpStatus).toBeDefined();
  }

  expect(row?.eventId).toHaveLength(MAX_EVENT_ID_LENGTH);
  expect(Buffer.byteLength(row?.eventId ?? "", "utf8")).toBe(MAX_EVENT_ID_LENGTH * 3);
  expect(row?.datasource).toHaveLength(MAX_DATASOURCE_NAME_LENGTH);

  // The optional fields too: a maximal row has all of them, and deleting any one shrinks it
  // while every assertion above stays true.
  expect(row?.payloadId).toBeDefined();
  expect(row?.workId).toBeDefined();
  expect(row?.retry).toBeDefined();
  expect(row?.requestTimeoutMs).toBeDefined();
  expect(row?.deliveredAt).toBeDefined();

  // `JSON.stringify` is a PROXY for what Convex counts, and it errs in the safe direction.
  // Convex sizes a document as `1 + Σ(fieldName.len + 1 + value.size()) + 1` per object,
  // strings as `utf8 length + 2`, floats as 9. JSON spends two quotes on every field name
  // where Convex spends one, and a comma between fields where Convex spends none; strings
  // cost the same either way. Independently reconstructed against this exact fixture, the
  // two come to 2462 and 2370 — so this over-states by about 4%.
  // The payload row is measured from the same fixture rather than a second one, so the two
  // numbers are guaranteed to describe the SAME event. `reclaimOrphanedPayloads` reads both
  // per scanned row, and a pair measured from separate seeds could silently drift apart.
  //
  // Note the fill here is ASCII while the event row's is CJK, and that is not an oversight:
  // `HARD_MAX_PAYLOAD_BYTES` is a BYTE bound, so one ASCII character is exactly one byte of
  // it and the string is already maximal. The event row's caps count UTF-16 code units,
  // where ASCII buys a third of the bytes the cap admits.
  const stored = await t.run(async (ctx) => ctx.db.query("payloads").first());
  expect(Buffer.byteLength(stored?.payload ?? "", "utf8")).toBe(HARD_MAX_PAYLOAD_BYTES);

  return {
    event: Buffer.byteLength(JSON.stringify(row), "utf8"),
    payload: Buffer.byteLength(JSON.stringify(stored), "utf8"),
  };
}

describe("what a full health call costs", () => {
  it("stays inside its documented share of the read budget at the cap", async () => {
    // convex-test enforces neither the document nor the byte limit, so nothing here can
    // observe the failure this guards against. What it CAN do is keep the arithmetic honest,
    // and that takes two assertions rather than one.
    const rowBytes = (await measureWorstCaseRow()).event;

    // A ratchet on the row itself. Anything that changes what an event costs — a new field,
    // a wider cap, a different fill — lands here and has to update the recorded number,
    // which is the same place the docblock's arithmetic is written.
    expect(Math.abs(rowBytes - WORST_CASE_ROW_BYTES)).toBeLessThanOrEqual(CREATION_TIME_STEP_BYTES);

    const worstCase = (STATES_COUNTED * (COUNT_CAP + 1) + HEARTBEAT_DOCUMENTS) * rowBytes;
    const share = worstCase / READ_BUDGET_BYTES;

    // The published figure, so raising the cap has to come here even while it stays safe.
    expect(share).toBeGreaterThan(DOCUMENTED_SHARE - SHARE_TOLERANCE);
    expect(share).toBeLessThan(DOCUMENTED_SHARE + SHARE_TOLERANCE);

    // And the ceiling, which is the safety claim rather than the change detector.
    expect(share).toBeLessThan(BUDGET_SHARE);
  });
});

describe("what a full orphan scan costs", () => {
  it("fits DEFAULT_ORPHAN_SCAN_LIMIT rows in the budget, and one more would not", async () => {
    const rows = await measureWorstCaseRow();

    // There are TWO per-row costs and the budget has to take the larger. `paginate` reads
    // every payload row. Then, per row, one of two things happens:
    //
    //   healthy — `ctx.db.get(stored.eventId)` reads the event row: payload + event.
    //   orphan  — that get returns null and costs nothing, but `ctx.db.delete(stored._id)`
    //             re-reads the payload it already has: payload TWICE.
    //
    // Which is larger flips at the point where a payload outweighs an event row. Below it
    // an orphan is CHEAPER than a healthy row; at the hard cap it is nearly double. An
    // earlier version of this test measured only the healthy pair, from a healthy fixture,
    // and so understated the worst case by 98% at the cap — for the very case the function
    // exists to handle. Same omission as the delete read one level down, found the same way.
    const healthyRow = rows.payload + rows.event;
    const orphanRow = 2 * rows.payload;
    const perScannedRow = Math.max(healthyRow, orphanRow);

    // Not a tautology: it pins WHICH case is worst at the bound the default is sized for, so
    // the two terms cannot be silently swapped or one of them dropped.
    expect(orphanRow).toBeGreaterThan(healthyRow);

    const budget = READ_BUDGET_BYTES * BUDGET_SHARE;
    const atDefault = DEFAULT_ORPHAN_SCAN_LIMIT * perScannedRow;

    // The safety claim.
    expect(atDefault).toBeLessThan(budget);

    // And the tightness claim, which is what makes this a change detector rather than a
    // bound with slack to drift inside. The default is the LARGEST value that fits: one more
    // row does not. So raising the default, widening the hard payload cap, or adding a field
    // to either row all land here.
    //
    // "Does not fit" means it exceeds the 35% share this component budgets against, NOT that
    // Convex would throw — the real limit is nearly three times that. The share is the
    // self-imposed headroom, and the wording matters because an earlier version read as
    // though one more row would crash.
    expect((DEFAULT_ORPHAN_SCAN_LIMIT + 1) * perScannedRow).toBeGreaterThan(budget);

    // The CEILING is a separate claim and needs its own assertion. It is sized for the
    // DEFAULT payload bound rather than the hard cap, because a host that has raised
    // `maxPayloadBytes` has to lower its limit and nothing can enforce that for it — the
    // scan cannot see the option, and by the time it has read a row it has paid for it.
    // Without this the docblock's "20 orphans at 64 KiB is about 2.6 MiB" is prose.
    const overhead = rows.payload - HARD_MAX_PAYLOAD_BYTES;
    const orphanAtDefaultBound = 2 * (DEFAULT_MAX_PAYLOAD_BYTES + overhead);
    expect(MAX_ORPHAN_SCAN_LIMIT * orphanAtDefaultBound).toBeLessThan(budget);
  });
});

describe("what a retention sweep costs", () => {
  it("keeps its sizing constants tied to the rows they claim to describe", async () => {
    // The ratchet that was missing. Every byte claim about the sweep was prose for three
    // rounds, and the one that mattered was false: `ctx.db.delete(id)` reads the whole
    // document (`delete_inner` -> `get_inner` -> `record_read_document(..., doc.size(), ...,
    // &self.limits)`), so the sweep's real cost is the event row plus its payload, not the
    // event row alone. `convex-test` enforces no byte limit, so no behavioural test can see
    // the overrun. What this can do is refuse to let the CONSTANTS drift from the rows.
    const rows = await measureWorstCaseRow();

    // Counted twice: once from `by_state_updatedAt`, once by the delete that fetches it.
    expect(EVENT_ROW_READ_BYTES).toBeGreaterThanOrEqual(2 * rows.event);

    // The payload row costs its text plus this. Measured against the real row rather than
    // assumed, so adding a field to `payloads` lands here.
    expect(PAYLOAD_ROW_OVERHEAD_BYTES).toBeGreaterThanOrEqual(
      rows.payload - HARD_MAX_PAYLOAD_BYTES,
    );

    const worstRow = EVENT_ROW_READ_BYTES + HARD_MAX_PAYLOAD_BYTES + PAYLOAD_ROW_OVERHEAD_BYTES;

    // One row always fits, which is why `sweepExpired` deletes the first row whatever it
    // costs. That branch is UNREACHABLE today and this is the assertion that says so — if it
    // ever stops holding, the branch starts mattering and this test is where you find out.
    expect(worstRow).toBeLessThan(SWEEP_READ_BUDGET_BYTES);

    // Two bounds, each binding where it should. At the hard payload cap the bytes bind well
    // before the row cap: without this, `DEFAULT_CLEANUP_LIMIT` could be lowered until the
    // byte budget never fired and the sweep silently went back to being row-bounded.
    expect(Math.floor(SWEEP_READ_BUDGET_BYTES / worstRow)).toBeLessThan(DEFAULT_CLEANUP_LIMIT);

    // And at a small payload the ROW cap binds, so a full 200-row batch of ordinary events
    // stays inside the budget. This is the leg that fails if the event row grows: it is the
    // reason the old `200 x 5.4 KB` claim needed to be checked against something.
    const smallRow = EVENT_ROW_READ_BYTES + 1024 + PAYLOAD_ROW_OVERHEAD_BYTES;
    expect(DEFAULT_CLEANUP_LIMIT * smallRow).toBeLessThan(SWEEP_READ_BUDGET_BYTES);
  });
});
