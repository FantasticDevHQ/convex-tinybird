/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as maintenance from "../maintenance.js";
import type * as operations from "../operations.js";
import type * as orders from "../orders.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  maintenance: typeof maintenance;
  operations: typeof operations;
  orders: typeof orders;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  productEvents: import("@fantastic-dev/convex-tinybird/_generated/component.js").ComponentApi<"productEvents">;
  auditEvents: import("@fantastic-dev/convex-tinybird/_generated/component.js").ComponentApi<"auditEvents">;
};
