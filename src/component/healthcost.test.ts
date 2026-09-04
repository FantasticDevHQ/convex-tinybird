import { installComponentTestHooks, seedEvent, setup } from "../testing/fixtures";
import { COUNT_CAP, MAX_ERROR_HISTORY, MAX_EVENT_ID_LENGTH } from "./contract";
import { MAX_ERROR_MESSAGE_LENGTH } from "./sanitize";

installComponentTestHooks();

/** Convex's documented per-call read budget. */
const READ_BUDGET_BYTES = 8 * 1024 * 1024;

/** The fraction of that budget `health`'s worst case is allowed to occupy. */
const BUDGET_SHARE = 0.35;

/** `health` counts three states, each reading one row past the cap. */
const STATES_COUNTED = 3;

/**
 * Builds the largest `events` row the contract permits, and measures it.
 *
 * Every string is at its documented maximum and every optional field is present. That is
 * not a pathological shape: a thousand failed rows each carrying a full failure history is
 * precisely what a sustained outage produces, so the worst case and the case an operator
 * reaches for `health` in are the same case.
 */
async function measureWorstCaseRow(): Promise<number> {
  const t = setup("");
  const error = (i: number) => ({
    category: "server_error" as const,
    httpStatus: 503,
    message: `${i}`.padEnd(MAX_ERROR_MESSAGE_LENGTH, "x"),
    at: Date.now(),
  });
  await t.run(async (ctx) => {
    await seedEvent(ctx, {
      datasource: "d".repeat(128),
      eventId: "e".repeat(MAX_EVENT_ID_LENGTH),
      state: "failed" as const,
      attempts: 5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deliveredAt: Date.now(),
      lastError: error(0),
      previousErrors: Array.from({ length: MAX_ERROR_HISTORY }, (_, i) => error(i + 1)),
      workId: "w".repeat(32),
      retry: { maxAttempts: 5, initialBackoffMs: 100, base: 2 },
      requestTimeoutMs: 30_000,
      payload: '{"seed":1}',
    });
  });
  const row = await t.run(async (ctx) => ctx.db.query("events").first());

  // The measurement is only worth its name if the row really is maximal. `padEnd` with an
  // undefined length silently does nothing, which is how an earlier version of this probe
  // measured 1264 bytes instead of 2458 and made the cap look twice as safe as it is.
  expect(row?.eventId).toHaveLength(MAX_EVENT_ID_LENGTH);
  expect(row?.datasource).toHaveLength(128);
  expect(row?.lastError?.message).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
  expect(row?.previousErrors).toHaveLength(MAX_ERROR_HISTORY);
  expect(row?.previousErrors?.[0]?.message).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);

  return Buffer.byteLength(JSON.stringify(row), "utf8");
}

describe("what a full health call costs", () => {
  it("stays inside its documented share of the read budget at the cap", async () => {
    // convex-test enforces neither the document nor the byte limit, so nothing here can
    // observe the failure this guards against. What it CAN do is keep the arithmetic
    // honest: it measures the row rather than estimating it, and it reds if someone raises
    // the cap or adds a field to the row without redoing the sum.
    const rowBytes = await measureWorstCaseRow();
    const worstCase = STATES_COUNTED * (COUNT_CAP + 1) * rowBytes;

    expect(worstCase).toBeLessThan(READ_BUDGET_BYTES * BUDGET_SHARE);
  });
});
