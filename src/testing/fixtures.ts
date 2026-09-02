/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import workpool from "@convex-dev/workpool/test";

import { api } from "../component/_generated/api";
import type { Doc } from "../component/_generated/dataModel";
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
