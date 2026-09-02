/// <reference types="vite/client" />
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
}
