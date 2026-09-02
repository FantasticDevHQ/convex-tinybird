/// <reference types="vite/client" />
import workpool from "@convex-dev/workpool/test";
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";

import schema from "./component/schema";

export const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the component in a `convex-test` instance so host tests can call
 * `components.<name>.lib.*`. Call once per mounted instance name.
 */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name = "tinybird",
): void {
  t.registerComponent(name, schema, modules);
  // Delivery runs on a nested Workpool, so a host test that never registers it would fail
  // the moment an enqueue schedules work. Mirrors @convex-dev/workpool's own test helper.
  workpool.register(t, `${name}/workpool`);
}
