import { api } from "./_generated/api";
import {
  DEFAULT_CLEANUP_LIMIT,
  EVENT_ROW_BYTES,
  MAX_ORPHAN_SCAN_LIMIT,
  PAYLOAD_ROW_OVERHEAD_BYTES,
  SWEEP_READ_BUDGET_BYTES,
} from "./budget";
import { HARD_MAX_PAYLOAD_BYTES } from "./contract";
import { sweepExpired } from "./state";
import {
  installComponentTestHooks,
  seedEvent,
  setup,
  type TestInstance,
} from "../testing/fixtures";

installComponentTestHooks();

const DAY = 24 * 60 * 60 * 1000;

/** Seeds one event in a given state at a given age, with its payload row. */
async function aged(
  t: TestInstance,
  id: string,
  state: "delivered" | "failed" | "pending" | "delivering",
  ageMs: number,
) {
  await t.run(async (ctx) => {
    await seedEvent(ctx, {
      datasource: "events",
      eventId: id,
      state,
      attempts: 1,
      createdAt: Date.now() - ageMs,
      updatedAt: Date.now() - ageMs,
    });
  });
}

/** Both tables, counted. The pairing is the point; neither number means much alone. */
async function tableCounts(t: TestInstance) {
  return t.run(async (ctx) => {
    // eslint-disable-next-line @convex-dev/no-collect-in-query
    const events = await ctx.db.query("events").collect();
    // eslint-disable-next-line @convex-dev/no-collect-in-query
    const payloads = await ctx.db.query("payloads").collect();
    return { events: events.length, payloads: payloads.length };
  });
}

/**
 * What a sweep is allowed to READ, as distinct from which rows it removes.
 *
 * Split from `cleanup.test.ts` because the subject is different, and because the cost model
 * has been wrong six times on this component — always the same way, a term that is right for
 * the case in mind and wrong for the case the reader is in. It earns its own file and its own
 * fixtures rather than sitting as an appendix to the retention semantics.
 */
describe("what a sweep is allowed to read", () => {
  it("stops on BYTES before the row limit when payloads are large", async () => {
    // The bound the row cap cannot provide. Deleting a document READS it — Convex's
    // `delete_inner` calls `get_inner`, which records `doc.size()` against the read limit —
    // so a batch of 200 at the default 64 KiB payload bound would read about 13 MiB against
    // a limit near 8 MiB and throw. The row cap cannot see that, because the payload bound
    // is a per-call host option and `cleanup` never receives it.
    //
    // Eight rows at the hard cap, against a limit of 200: if only the row cap were enforcing
    // anything, all eight would go.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    const big = "x".repeat(HARD_MAX_PAYLOAD_BYTES);
    for (let i = 0; i < 8; i += 1) {
      await t.run(async (ctx) => {
        await seedEvent(ctx, {
          datasource: "events",
          eventId: `big-${i}`,
          state: "delivered",
          attempts: 1,
          createdAt: Date.now() - 10 * DAY,
          updatedAt: Date.now() - 10 * DAY,
          payload: big,
        });
      });
    }

    const result = await t.mutation(api.lib.cleanup, {});

    // Derived from the constants rather than written as 5, so the expectation moves with the
    // arithmetic instead of pinning a number that agrees with nothing.
    // The scan is charged before any deletion: `take` reads all 8 rows whether or not they
    // are deleted. Modelling it explicitly rather than letting the numbers agree by accident
    // — without the seed this formula still happened to give 5 here, so a test that omitted
    // it would have passed while pinning the wrong model.
    const perRow = EVENT_ROW_BYTES + HARD_MAX_PAYLOAD_BYTES + PAYLOAD_ROW_OVERHEAD_BYTES;
    const scanned = 8 * EVENT_ROW_BYTES;
    const fits = Math.floor((SWEEP_READ_BUDGET_BYTES - scanned) / perRow);
    expect(fits).toBeLessThan(DEFAULT_CLEANUP_LIMIT);
    expect(result.deletedDelivered).toBe(fits);
    expect(result.remaining).toBe(true);
    expect(await tableCounts(t)).toEqual({ events: 8 - fits, payloads: 8 - fits });
  });

  it("caps the orphan scan, so following the docs cannot blow the read budget", async () => {
    // The orphan scan has no byte budget available to it — it reads payload rows to find out
    // whether they are orphans, so their cost is paid before it can be weighed. The row
    // count is its only bound, and an earlier revision removed the ceiling entirely while
    // the README told hosts with small payloads to "pass a far larger one". A host following
    // that advice with `limit: 900` would have read about 70% of the call budget at once.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    for (let i = 0; i < MAX_ORPHAN_SCAN_LIMIT + 3; i += 1) {
      await aged(t, `p_${i}`, "delivered", 0);
    }

    const scan = await t.mutation(api.lib.reclaimOrphanedPayloads, { limit: 10_000 });
    expect(scan.scanned).toBe(MAX_ORPHAN_SCAN_LIMIT);
    // Nothing was an orphan, so the ceiling is the only thing this can be measuring.
    expect(scan.reclaimed).toBe(0);
    expect(scan.isDone).toBe(false);
  });

  it("charges the fallback path twice, because it reads the payload twice", async () => {
    // A row with no `payloadId` finds its payload through `by_event` — which returns the
    // document — and then deletes it, and a delete re-reads what it deletes. Every row
    // written before this component gained the pointer takes that path, so the FIRST sweep
    // after deploying it is the one that pays double on every row: the run with the largest
    // bill is the one nobody has rehearsed.
    //
    // Same eight rows as the pointered case, so the only variable is the pointer.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    const big = "x".repeat(HARD_MAX_PAYLOAD_BYTES);
    for (let i = 0; i < 8; i += 1) {
      await t.run(async (ctx) => {
        const id = await seedEvent(ctx, {
          datasource: "events",
          eventId: `legacy-${i}`,
          state: "delivered",
          attempts: 1,
          createdAt: Date.now() - 10 * DAY,
          updatedAt: Date.now() - 10 * DAY,
          payload: big,
        });
        // Exactly the shape of a row predating the field.
        await ctx.db.patch(id, { payloadId: undefined });
      });
    }

    const result = await t.mutation(api.lib.cleanup, {});

    const payloadRow = HARD_MAX_PAYLOAD_BYTES + PAYLOAD_ROW_OVERHEAD_BYTES;
    const budget = SWEEP_READ_BUDGET_BYTES - 8 * EVENT_ROW_BYTES;
    const fits = Math.floor(budget / (EVENT_ROW_BYTES + 2 * payloadRow));
    expect(result.deletedDelivered).toBe(fits);
    // And strictly fewer than the pointered path manages on identical rows, which is the
    // whole claim. Without this the test would pass against a budget that ignored the
    // pointer entirely.
    const pointered = Math.floor(budget / (EVENT_ROW_BYTES + payloadRow));
    expect(fits).toBeLessThan(pointered);
    expect(result.remaining).toBe(true);
  });

  it("spends one byte budget across both states, not one plus a free row each", async () => {
    // The exemption that lets the first row through whatever it costs used to fire once per
    // SWEEP. `cleanup` sweeps delivered and then failed, so a call could take a free
    // over-budget row in each: measured at 104% of the budget, 118% worst case. Safe against
    // Convex's real limit, but an unbounded overshoot is the thing a byte budget exists to
    // prevent, and the comment claimed a bound the code did not hold.
    //
    // Six delivered and two failed, all expired, all at the payload cap. The delivered sweep
    // exhausts the budget; the failed sweep must then take NOTHING, because this call has
    // already had its one exempt row.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    const big = "x".repeat(HARD_MAX_PAYLOAD_BYTES);
    const seed = async (id: string, state: "delivered" | "failed") => {
      await t.run(async (ctx) => {
        await seedEvent(ctx, {
          datasource: "events",
          eventId: id,
          state,
          attempts: 1,
          createdAt: Date.now() - 40 * DAY,
          updatedAt: Date.now() - 40 * DAY,
          payload: big,
        });
      });
    };
    for (let i = 0; i < 6; i += 1) await seed(`d-${i}`, "delivered");
    for (let i = 0; i < 2; i += 1) await seed(`f-${i}`, "failed");

    const result = await t.mutation(api.lib.cleanup, {});

    const perRow = EVENT_ROW_BYTES + HARD_MAX_PAYLOAD_BYTES + PAYLOAD_ROW_OVERHEAD_BYTES;
    const fits = Math.floor((SWEEP_READ_BUDGET_BYTES - 6 * EVENT_ROW_BYTES) / perRow);
    expect(result.deletedDelivered).toBe(fits);
    // The claim. Before the fix this was 1, and the call spent 104% of its budget.
    expect(result.deletedFailed).toBe(0);
    expect(result.remaining).toBe(true);
    expect((result.deletedDelivered + result.deletedFailed) * perRow).toBeLessThanOrEqual(
      SWEEP_READ_BUDGET_BYTES,
    );

    // And nothing is stranded: once the delivered rows are gone the exemption is available
    // again, so the failed rows do get swept. Without this the fix could have been a wedge.
    for (let pass = 0; pass < 6; pass += 1) await t.mutation(api.lib.cleanup, {});
    expect(await tableCounts(t)).toEqual({ events: 0, payloads: 0 });
  });

  it("charges the index scan for every row it FINDS, not every row it deletes", async () => {
    // This assertion exists because the obvious test cannot see the defect. `take(batch + 1)`
    // reads every candidate before any budget check, and charging that per DELETED row
    // assumed the two populations were the same — true while the row cap binds, false exactly
    // when the byte budget binds, which is the case the budget was added for.
    //
    // The behavioural tests above model the scan in their arithmetic and still pass with the
    // charge removed: at eight rows the seed is 43 672 bytes against a 529 939-byte row, far
    // too small to move `floor(budget / perRow)`. Making them discriminate would need ~60 rows
    // at the payload cap, about 24 MB of fixture. So the quantity is asserted directly
    // instead, on the function that computes it.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    const payload = "x".repeat(4096);
    for (let i = 0; i < 8; i += 1) {
      await t.run(async (ctx) => {
        await seedEvent(ctx, {
          datasource: "events",
          eventId: `scan-${i}`,
          state: "delivered",
          attempts: 1,
          createdAt: Date.now() - 10 * DAY,
          updatedAt: Date.now() - 10 * DAY,
          payload,
        });
      });
    }

    // A budget large enough that nothing is refused, so `bytesSpent` is the whole cost of
    // sweeping all eight rather than a number shaped by where the budget cut it off.
    const result = await t.run(async (ctx) =>
      sweepExpired(ctx, {
        state: "delivered",
        cutoff: Date.now(),
        batch: 50,
        byteBudget: Number.MAX_SAFE_INTEGER,
        mayExemptFirstRow: true,
      }),
    );

    expect(result.deleted).toBe(8);
    // Eight scan reads plus, per deleted row, the delete's own event read and one payload.
    const expected =
      8 * EVENT_ROW_BYTES + 8 * (EVENT_ROW_BYTES + 4096 + PAYLOAD_ROW_OVERHEAD_BYTES);
    expect(result.bytesSpent).toBe(expected);

    // And the scan half is not negligible relative to the total, so this cannot pass by the
    // seed being rounding error — it is 33% of the charge here.
    expect((8 * EVENT_ROW_BYTES) / expected).toBeGreaterThan(0.2);
  });
});
