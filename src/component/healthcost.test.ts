import { installComponentTestHooks, seedEvent, setup } from "../testing/fixtures";
import { COUNT_CAP, MAX_ERROR_HISTORY, MAX_EVENT_ID_LENGTH } from "./contract";
import { MAX_ERROR_MESSAGE_LENGTH } from "./sanitize";

installComponentTestHooks();

/**
 * Convex's documented per-call read budget for the hosted product.
 *
 * Conservative twice over: the OSS backend's own default knob is 16 MiB, and this uses the
 * published cloud figure instead.
 */
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
  // Every length cap in this contract counts UTF-16 code units, but Convex sizes a string
  // by its UTF-8 bytes. So the most expensive string a cap admits is not ASCII: a BMP
  // character outside Latin-1 is one code unit and three bytes, which is the worst ratio
  // available. An emoji is worse per character but cheaper per unit — two units, four bytes
  // — so it buys less under a length cap. An ASCII fixture measures a third of the truth.
  const fill = (units: number) => "\u4e2d".repeat(units);
  const error = (i: number) => ({
    category: "server_error" as const,
    httpStatus: 503,
    message: fill(MAX_ERROR_MESSAGE_LENGTH),
    at: Date.now() + i,
  });
  await t.run(async (ctx) => {
    await seedEvent(ctx, {
      // The datasource pattern is `[A-Za-z0-9_]`, so this one really is ASCII-bound.
      datasource: "d".repeat(128),
      eventId: fill(MAX_EVENT_ID_LENGTH),
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
  // Length is not size. Asserting only the length is how an ASCII fixture passes for a
  // maximal one, so the byte cost of the capped strings is asserted too.
  expect(Buffer.byteLength(row?.eventId ?? "", "utf8")).toBe(MAX_EVENT_ID_LENGTH * 3);
  expect(Buffer.byteLength(row?.lastError?.message ?? "", "utf8")).toBe(
    MAX_ERROR_MESSAGE_LENGTH * 3,
  );
  expect(row?.datasource).toHaveLength(128);
  expect(row?.lastError?.message).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
  expect(row?.previousErrors).toHaveLength(MAX_ERROR_HISTORY);
  expect(row?.previousErrors?.[0]?.message).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);

  // `JSON.stringify` is a PROXY for what Convex counts, and it errs in the safe direction.
  // Convex sizes a document as `1 + Σ(fieldName.len + 1 + value.size()) + 1` per object,
  // strings as `utf8 length + 2`, floats as 9. JSON spends two quotes on every field name
  // where Convex spends one, and a comma between fields where Convex spends none; strings
  // cost the same either way. Independently reconstructed against this exact fixture, the
  // two come to 2462 and 2370 — so this over-states by about 4%.
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
