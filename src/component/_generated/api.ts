/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as canonical from "../canonical.js";
import type * as classify from "../classify.js";
import type * as contract from "../contract.js";
import type * as credentials from "../credentials.js";
import type * as deliver from "../deliver.js";
import type * as destination from "../destination.js";
import type * as lib from "../lib.js";
import type * as lifecycle from "../lifecycle.js";
import type * as pool from "../pool.js";
import type * as sanitize from "../sanitize.js";
import type * as state from "../state.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  canonical: typeof canonical;
  classify: typeof classify;
  contract: typeof contract;
  credentials: typeof credentials;
  deliver: typeof deliver;
  destination: typeof destination;
  lib: typeof lib;
  lifecycle: typeof lifecycle;
  pool: typeof pool;
  sanitize: typeof sanitize;
  state: typeof state;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  workpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"workpool">;
};
