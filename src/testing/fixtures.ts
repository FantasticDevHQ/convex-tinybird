/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import workpool from "@convex-dev/workpool/test";

import { api } from "../component/_generated/api";
import { payloadFingerprint, utf8Length } from "../component/canonical";
import type { DatabaseWriter } from "../component/_generated/server";
import type { Doc, Id } from "../component/_generated/dataModel";
import schema from "../component/schema";

/**
 * Shared setup for the component's behavioural suites.
 *
 * Not a `.test.ts` file, so vitest does not collect it. It exists because delivery and the
 * operator controls are tested separately but drive the same component, and duplicating the
 * harness between them is how two suites quietly stop testing the same thing.
 */
// Globbed from outside the component directory on purpose. Convex bundles everything
// under `src/component` and cannot analyse `import.meta`, so a shared harness living there
// breaks the push for every host that mounts the component; only `.test.ts` files are
// excluded from that bundle.
const modules = import.meta.glob("../component/**/*.ts");

/**
 * The component under test, typed against its own schema so `t.run` sees the real tables
 * and indexes. `TestInstance` erases that and silently degrades every
 * database call in a suite to the system tables.
 */
export type TestInstance = TestConvex<typeof schema>;

/** The canonical event every suite enqueues unless it needs something else. */
export const row = { event_id: "evt_1", kind: "order_created" };

/** A component instance with the nested pool registered, as a host mount would have. */
export function setup(token = "p.token"): TestInstance {
  vi.stubEnv("TINYBIRD_TOKEN", token);
  const t = convexTest(schema, modules);
  workpool.register(t, "workpool");
  return t;
}

/**
 * Seeds an event and its payload together, the way `enqueue` writes them.
 *
 * Seeding only the `events` row builds a state production cannot reach — `enqueue` writes
 * both in one transaction — and a fixture in an impossible state proves nothing about the
 * code that handles possible ones.
 */
export async function seedEvent(
  ctx: { db: DatabaseWriter },
  fields: Omit<Doc<"events">, "_id" | "_creationTime" | "payloadBytes" | "payloadHash"> & {
    payload?: string;
  },
): Promise<Id<"events">> {
  const { payload = '{"seed":1}', ...event } = fields;
  // `utf8Length`, not `payload.length`: the production path measures UTF-8 bytes, and a
  // fixture that measured UTF-16 units would quietly disagree the first time one seeds a
  // non-ASCII payload. Nothing reads this field today, which is exactly why it should be
  // right — the old inline fixtures had it wrong for both of their payloads and no test
  // noticed.
  const id = await ctx.db.insert("events", {
    ...event,
    lastErrorCategory: event.lastError?.category,
    payloadBytes: utf8Length(payload),
    payloadHash: payloadFingerprint(payload),
  });
  const payloadId = await ctx.db.insert("payloads", { eventId: id, payload });
  // Patched exactly as `enqueue` does. Omitting it would build a row no real path produces,
  // and would quietly understate the size measurement that reads this helper.
  await ctx.db.patch(id, { payloadId });
  return id;
}

/** The stored canonical payload for an event, which no longer lives on the event row. */
export async function payloadOf(t: TestInstance, eventId: Id<"events">): Promise<string | null> {
  return t.run(async (ctx) => {
    const stored = await ctx.db
      .query("payloads")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .unique();
    return stored?.payload ?? null;
  });
}

/** Runs the scheduled delivery to completion. */
export async function drain(t: TestInstance): Promise<void> {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** A Tinybird response with the given status and JSON body, or no body for `null`. */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function enqueueOne(t: TestInstance) {
  return t.mutation(api.lib.enqueue, { datasource: "events", eventId: "evt_1", payload: row });
}

export async function enqueueWithRetry(t: TestInstance, maxAttempts: number) {
  return t.mutation(api.lib.enqueue, {
    datasource: "events",
    eventId: "evt_1",
    payload: row,
    retry: { maxAttempts, initialBackoffMs: 100, base: 2 },
  });
}

export async function statusOf(t: TestInstance) {
  return t.query(api.lib.getStatus, { datasource: "events", eventId: "evt_1" });
}

/** The single settings row, which mirrors the newest error for operators. */
export async function settingsOf(t: TestInstance): Promise<Doc<"settings"> | null> {
  return t.run(async (ctx) => ctx.db.query("settings").first());
}

/** The `ConvexError` code a rejected call raised, or undefined if it did not raise one. */
export async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConvexError) return (error.data as { code?: string }).code;
    throw error;
  }
  return undefined;
}

/** Fake timers plus stub cleanup, which every suite here needs identically. */
export function installComponentTestHooks(): void {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
}
