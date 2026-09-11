import { TinybirdDelivery } from "@fantasticdevhq/convex-tinybird";
import { register } from "@fantasticdevhq/convex-tinybird/test";
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
afterEach(() => vi.restoreAllMocks());

it("continues each stream's recovery cursor across bounded maintenance transactions", async () => {
  const t = convexTest({ schema, modules, transactionLimits: true });
  register(t, "productEvents");
  register(t, "auditEvents");
  const product = { delivering: null, pending: { updatedAt: 1, creationTime: 2 } };
  const audit = { delivering: { updatedAt: 3, creationTime: 4 }, pending: null };
  const recovery = vi
    .spyOn(TinybirdDelivery.prototype, "requeueStuck")
    .mockResolvedValueOnce({ requeued: 0, remaining: true, cursor: product })
    .mockResolvedValueOnce({ requeued: 0, remaining: true, cursor: audit })
    .mockResolvedValue({
      requeued: 1,
      remaining: false,
      cursor: { delivering: null, pending: null },
    });
  const cleanup = vi.spyOn(TinybirdDelivery.prototype, "cleanup").mockResolvedValue({
    deletedDelivered: 0,
    deletedFailed: 0,
    remaining: true,
  });

  await t.mutation(internal.maintenance.maintain, {});
  // Each component call has its own byte cap. Repeating it in this parent transaction
  // multiplies that cap and can roll back the whole sweep at the platform read limit.
  expect(recovery).toHaveBeenCalledTimes(2);
  expect(cleanup).toHaveBeenCalledTimes(2);
  await t.mutation(internal.maintenance.maintain, {});
  expect(recovery.mock.calls[2]?.[1]).toMatchObject({ cursor: product });
  expect(recovery.mock.calls[3]?.[1]).toMatchObject({ cursor: audit });
  await t.mutation(internal.maintenance.maintain, {});
  expect(recovery.mock.calls[4]?.[1]?.cursor).toBeUndefined();
  expect(recovery.mock.calls[5]?.[1]?.cursor).toBeUndefined();
});
