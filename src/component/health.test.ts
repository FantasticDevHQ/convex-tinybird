import { readFileSync } from "node:fs";

import { api } from "./_generated/api";
import { COUNT_CAP } from "./contract";
import { MAX_ERROR_MESSAGE_LENGTH } from "./sanitize";
import {
  drain,
  enqueueOne,
  installComponentTestHooks,
  jsonResponse,
  row,
  seedEvent,
  setup,
  type TestInstance,
} from "../testing/fixtures";

installComponentTestHooks();

const accepted = { successful_rows: 1, quarantined_rows: 0 };

/** Inserts waiting rows directly; the point is the count, not how they got there. */
async function seedRows(
  t: TestInstance,
  count: number,
  state: "pending" | "delivering" | "failed" = "pending",
) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i += 1) {
      await seedEvent(ctx, {
        datasource: "events",
        eventId: `seed_${state}_${i}`,
        state,
        attempts: 0,
        createdAt: Date.now() + i,
        updatedAt: Date.now() + i,
      });
    }
  });
}

describe("health — configuration and pause", () => {
  it("reports an unconfigured, unpaused component with nothing waiting", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");

    expect(await t.query(api.lib.health, {})).toMatchObject({
      configured: false,
      paused: false,
      counts: {
        pending: { count: 0, capped: false },
        delivering: { count: 0, capped: false },
        failed: { count: 0, capped: false },
      },
      oldestPendingAgeMs: null,
    });
  });

  it("reports the pause and its reason once a credential is refused", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, null)));
    const t = setup();
    await enqueueOne(t);
    await drain(t);

    expect(await t.query(api.lib.health, {})).toMatchObject({
      configured: true,
      paused: true,
      pausedReason: "unauthorized",
    });
  });
});

describe("health — what is waiting", () => {
  it("counts an event that is waiting and reports how long the OLDEST has waited", async () => {
    // Two rows and a moving clock. With one row created and read at the same instant, a
    // newest-first ordering and a flipped sign both read as zero and prove nothing.
    vi.stubGlobal("fetch", vi.fn());
    vi.setSystemTime(100_000);
    const t = setup("");
    await t.run(async (ctx) => {
      for (const createdAt of [40_000, 90_000]) {
        await seedEvent(ctx, {
          datasource: "events",
          eventId: `aged_${createdAt}`,
          state: "pending" as const,
          attempts: 0,
          createdAt,
          updatedAt: createdAt,
        });
      }
    });

    const health = await t.query(api.lib.health, {});
    expect(health.counts.pending).toEqual({ count: 2, capped: false });
    expect(health.oldestPendingAgeMs).toBe(60_000);

    vi.setSystemTime(160_000);
    expect((await t.query(api.lib.health, {})).oldestPendingAgeMs).toBe(120_000);
  });

  it("does not count delivered events, which retention bounds rather than the query", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    const t = setup();
    await enqueueOne(t);
    await drain(t);

    const health = await t.query(api.lib.health, {});
    expect(health.counts.pending.count).toBe(0);
    expect(health.lastDeliveredAt).toEqual(expect.any(Number));
    // Delivered events are absent by design, not by omission.
    expect(Object.keys(health.counts).sort()).toEqual(["delivering", "failed", "pending"]);
  });

  it("counts a dead letter and surfaces its sanitized reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400, { error: "p.token-leak" })));
    const t = setup("p.token-leak");
    await enqueueOne(t);
    await drain(t);

    const health = await t.query(api.lib.health, {});
    expect(health.counts.failed).toEqual({ count: 1, capped: false });
    expect(health.lastError?.category).toBe("invalid_request");
    expect(JSON.stringify(health)).not.toContain("p.token-leak");
  });

  it("reports an exact count at the cap and only claims 'capped' beyond it", async () => {
    // The boundary: exactly COUNT_CAP rows is a true count, not an approximation.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await seedRows(t, COUNT_CAP);

    expect((await t.query(api.lib.health, {})).counts.pending).toEqual({
      count: COUNT_CAP,
      capped: false,
    });
  });

  it("stops counting at the cap rather than reading an unbounded backlog", async () => {
    // The point of the cap is that a large outbox cannot make this query expensive. An
    // operator needs "more than a thousand", not the exact number.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await seedRows(t, COUNT_CAP + 5);

    expect((await t.query(api.lib.health, {})).counts.pending).toEqual({
      count: COUNT_CAP,
      capped: true,
    });
  });

  it("reads a bounded page per state rather than the whole table", () => {
    // No behavioural test can see this. `.collect()` returns the same counts as `.take()`
    // for any fixture that fits in memory, and the harm only appears on a real backlog big
    // enough to exceed Convex's read limit, where the query fails outright instead of
    // reporting a large number. So the assertion is on the call itself.
    const source = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function boundedCount");
    // Not vacuous on a rename: an absent helper fails here rather than matching an empty
    // slice.
    expect(start).toBeGreaterThan(-1);
    // Comments are stripped first, or a `// was: .take(...)` left behind by an unbounded
    // rewrite would satisfy the positive assertion on its own.
    const body = source
      .slice(start, source.indexOf("\n}", start))
      .replace(/\/\/[^\n]*/gu, "")
      .replace(/\/\*[\s\S]*?\*\//gu, "");

    // A shape, not a word: the bounded read has to be the one on this index.
    expect(body).toMatch(/withIndex\("by_state_createdAt"[\s\S]{0,300}?\.take\(COUNT_CAP \+ 1\)/u);
    // Exactly one read, so a decoy bounded take cannot sit beside an unbounded one and
    // satisfy the shape above while the real query reads everything.
    expect((body.match(/\.take\(/gu) ?? []).length).toBe(1);
    // Every other way to read the range is unbounded, and `.filter` is too: Convex evaluates
    // it by reading documents until the take is satisfied, so a restrictive filter here
    // scans the whole state range while still matching the shape.
    expect(body).not.toMatch(/\.collect\(|for await|\.paginate\(|\.filter\(|fullTableScan/u);
  });

  it("reports each state independently", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");
    await seedRows(t, 2);
    await seedRows(t, 3, "delivering");
    await seedRows(t, 4, "failed");

    const { counts } = await t.query(api.lib.health, {});
    expect(counts.pending.count).toBe(2);
    expect(counts.delivering.count).toBe(3);
    expect(counts.failed.count).toBe(4);
  });
});

describe("health — operator actions", () => {
  it("records who last paused or resumed", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("");

    await t.mutation(api.lib.pause, { actor: "operator_1" });
    expect(await t.query(api.lib.health, {})).toMatchObject({
      lastOperatorAction: { kind: "pause", actor: "operator_1" },
    });

    await t.mutation(api.lib.resume, { actor: "operator_2" });
    expect(await t.query(api.lib.health, {})).toMatchObject({
      paused: false,
      lastOperatorAction: { kind: "resume", actor: "operator_2" },
    });
  });

  it("bounds and redacts the actor, which is the one host string it echoes back", async () => {
    // The component cannot validate an opaque host identifier, but it stores this one and
    // returns it. Unbounded, a careless caller grows the settings row and every health
    // response; unredacted, a host that passed a credential as its actor would get it back.
    vi.stubGlobal("fetch", vi.fn());
    const t = setup("p.append-token");

    await t.mutation(api.lib.pause, { actor: "x".repeat(5_000) });
    const long = (await t.query(api.lib.health, {})).lastOperatorAction?.actor ?? "";
    expect(long.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH);

    await t.mutation(api.lib.resume, { actor: "operator p.append-token" });
    const redacted = (await t.query(api.lib.health, {})).lastOperatorAction?.actor ?? "";
    expect(redacted).not.toContain("p.append-token");
    expect(redacted).toContain("operator");
  });

  it("never returns a payload, a host or a credential", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, accepted)));
    vi.stubEnv("TINYBIRD_HOST", "https://api.eu-central-1.aws.tinybird.co");
    const t = setup("p.append-token");
    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: "evt_1",
      payload: { ...row, secret_field: "payload-marker-3b7f" },
    });
    await drain(t);

    const serialized = JSON.stringify(await t.query(api.lib.health, {}));
    expect(serialized).not.toContain("p.append-token");
    expect(serialized).not.toContain("payload-marker-3b7f");
    expect(serialized).not.toContain("tinybird.co");
  });
});

describe("heartbeat", () => {
  it("reports the signals worth alerting on without counting anything", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, null)));
    const t = setup();
    await enqueueOne(t);
    await drain(t);

    const beat = await t.query(api.lib.heartbeat, {});
    expect(beat).toMatchObject({
      configured: true,
      paused: true,
      pausedReason: "unauthorized",
    });
    expect(beat.oldestPendingAgeMs).toBeGreaterThanOrEqual(0);
    // No counts: that is the whole point of this query existing separately.
    expect(beat).not.toHaveProperty("counts");
  });

  it("stays available on a backlog large enough to make counting expensive", async () => {
    // health reads whole event rows, so on a big backlog of large events it can exceed
    // Convex's read limit and fail. These two signals must survive that, which they can
    // only do by not being computed from the same scan.
    vi.stubGlobal("fetch", vi.fn());
    vi.setSystemTime(500_000);
    const t = setup("");
    await seedRows(t, COUNT_CAP + 200);

    const beat = await t.query(api.lib.heartbeat, {});
    expect(beat.oldestPendingAgeMs).toEqual(expect.any(Number));
    expect(beat.paused).toBe(false);
  });

  it("reads only the settings row and the oldest waiting event", () => {
    // Behaviourally indistinguishable from a counting implementation, for the same reason
    // the bounded read is: the harness enforces no read limit. Assert the shape instead.
    const source = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function readHeartbeat");
    expect(start).toBeGreaterThan(-1);
    const body = source
      .slice(start, source.indexOf("\n}", start))
      .replace(/\/\/[^\n]*/gu, "")
      .replace(/\/\*[\s\S]*?\*\//gu, "");

    expect(body).not.toMatch(/boundedCount|\.take\(|\.collect\(|for await|\.paginate\(/u);
    // One row from each: the settings singleton and the oldest waiting event.
    expect((body.match(/\.first\(\)/gu) ?? []).length).toBe(2);
  });
});
